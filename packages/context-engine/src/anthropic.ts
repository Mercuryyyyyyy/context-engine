// Anthropic API 格式适配器
// 职责：Anthropic 请求体 ↔ 内部 Message[] 互转 + cache_control 断点插入

import type { Message, ContextTier } from './types.js';
import { countMessageTokens } from './tokenize.js';

// Anthropic content block
export interface AnthropicContentBlock {
  type: 'text' | 'image' | 'tool_use' | 'tool_result';
  text?: string;
  cache_control?: { type: 'ephemeral' };
  [key: string]: unknown;
}

// Anthropic 请求体
export interface AnthropicRequestBody {
  model: string;
  max_tokens: number;
  system?: string | AnthropicContentBlock[];
  messages: Array<{
    role: 'user' | 'assistant';
    content: string | AnthropicContentBlock[];
  }>;
  temperature?: number;
  tools?: unknown[];
  [key: string]: unknown;
}

// Anthropic 请求体 → 内部 Message[]
// system 字段转成第一条 system message
export function anthropicToMessages(body: AnthropicRequestBody): Message[] {
  const messages: Message[] = [];

  // system 转成第一条 system message
  if (body.system) {
    const systemText = typeof body.system === 'string'
      ? body.system
      : body.system
          .map((b) => b.text || '')
          .join('\n');
    messages.push({ role: 'system', content: systemText });
  }

  // tools 转成 tool message（简化：作为一条 system 消息的补充）
  // 注意：Anthropic 的 tools 定义与 OpenAI 不同，这里只做透传标记
  // 实际 tool_use/tool_result 在 messages 的 content blocks 里

  // messages 转换
  for (const msg of body.messages) {
    const content = typeof msg.content === 'string'
      ? msg.content
      : msg.content
          .map((b) => {
            if (b.type === 'text') return b.text || '';
            if (b.type === 'tool_use') return `[tool_use: ${b.name || 'unknown'}]`;
            if (b.type === 'tool_result') return `[tool_result]`;
            return '';
          })
          .join('\n');
    messages.push({ role: msg.role, content });
  }

  return messages;
}

// 内部 Message[] → Anthropic 请求体，插入 cache_control 断点
// 断点策略（最多 4 个，按 tier 边界插入）：
//   1. system 末尾
//   2. rules 末尾（如有）
//   3. history 中段（老历史末尾）
//   4. dynamic 前一条末尾
export function messagesToAnthropic(
  messages: Message[],
  maxBreakpoints = 4
): { system?: string | AnthropicContentBlock[]; messages: AnthropicRequestBody['messages'] } {
  // 分离 system 和其他消息
  const systemMsgs = messages.filter((m) => m.role === 'system');
  const nonSystemMsgs = messages.filter((m) => m.role !== 'system');

  // 对非 system 消息分层（简化版，用于决定断点位置）
  const tiers = classifyTiers(nonSystemMsgs);

  // 计算断点位置
  const breakpoints = new Set<number>(); // 非system消息的索引
  let usedBreakpoints = 0;

  // 断点1：system 末尾（通过 system 字段的 cache_control 实现，单独处理）
  const hasSystemBreakpoint = systemMsgs.length > 0 && usedBreakpoints < maxBreakpoints;
  if (hasSystemBreakpoint) usedBreakpoints++;

  // 找各 tier 边界
  const tierBoundaries = findTierBoundaries(tiers);

  // 断点2：rules 末尾
  if (tierBoundaries.rulesEnd >= 0 && usedBreakpoints < maxBreakpoints) {
    breakpoints.add(tierBoundaries.rulesEnd);
    usedBreakpoints++;
  }

  // 断点3：history 中段
  if (tierBoundaries.historyMid >= 0 && usedBreakpoints < maxBreakpoints) {
    breakpoints.add(tierBoundaries.historyMid);
    usedBreakpoints++;
  }

  // 断点4：dynamic 前一条
  if (tierBoundaries.dynamicStart - 1 >= 0 && usedBreakpoints < maxBreakpoints) {
    breakpoints.add(tierBoundaries.dynamicStart - 1);
    usedBreakpoints++;
  }

  // 构造 system
  let system: string | AnthropicContentBlock[] | undefined;
  if (systemMsgs.length > 0) {
    const systemText = systemMsgs
      .map((m) => (typeof m.content === 'string' ? m.content : ''))
      .join('\n');
    if (hasSystemBreakpoint) {
      // 用 content blocks 形式，末尾加 cache_control
      system = [
        { type: 'text', text: systemText, cache_control: { type: 'ephemeral' } },
      ];
    } else {
      system = systemText;
    }
  }

  // 构造 messages（带 cache_control）
  const anthropicMessages: AnthropicRequestBody['messages'] = nonSystemMsgs.map((msg, i) => {
    const content = typeof msg.content === 'string' ? msg.content : '';
    const blocks: AnthropicContentBlock[] = [{ type: 'text', text: content }];

    // 在该消息末尾插断点
    if (breakpoints.has(i)) {
      blocks[blocks.length - 1]!.cache_control = { type: 'ephemeral' };
    }

    return {
      role: msg.role as 'user' | 'assistant',
      content: blocks,
    };
  });

  return { system, messages: anthropicMessages };
}

// 简化分层（复用 engine 的逻辑思路）
function classifyTiers(messages: Message[]): ContextTier[] {
  const lastUserIndex = messages.map((m) => m.role).lastIndexOf('user');
  return messages.map((msg, i) => {
    if (msg.role === 'tool') return 'tools';
    if (msg.role === 'user' && isRulesMessage(msg)) return 'rules';
    if (lastUserIndex >= 0 && i >= lastUserIndex) return 'dynamic';
    return 'history';
  });
}

function isRulesMessage(msg: Message): boolean {
  const text = typeof msg.content === 'string' ? msg.content : '';
  return /<rules>|<project>|^#\s+(Rules|Project Rules|CLAUDE)/m.test(text);
}

interface TierBoundaries {
  rulesEnd: number;      // rules tier 最后一条的索引，-1 表示无
  historyMid: number;    // history 中段的索引，-1 表示无
  dynamicStart: number;  // dynamic tier 第一条的索引
}

function findTierBoundaries(tiers: ContextTier[]): TierBoundaries {
  const boundaries: TierBoundaries = {
    rulesEnd: -1,
    historyMid: -1,
    dynamicStart: tiers.length, // 默认指向末尾之后
  };

  // rules 末尾
  for (let i = tiers.length - 1; i >= 0; i--) {
    if (tiers[i] === 'rules') {
      boundaries.rulesEnd = i;
      break;
    }
  }

  // history 中段
  const historyIndices = tiers
    .map((t, i) => (t === 'history' ? i : -1))
    .filter((i) => i >= 0);
  if (historyIndices.length >= 2) {
    const mid = Math.floor(historyIndices.length / 2);
    boundaries.historyMid = historyIndices[mid]!;
  }

  // dynamic 起点
  for (let i = 0; i < tiers.length; i++) {
    if (tiers[i] === 'dynamic') {
      boundaries.dynamicStart = i;
      break;
    }
  }

  return boundaries;
}
