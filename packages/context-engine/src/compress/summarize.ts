// 不可逆压缩：调用小模型对老历史做摘要
// 借鉴 Manus Summarization 阶段：有损但保留关键信息

import type { Message } from '../types.js';
import { countMessageTokens, countMessagesTokens, messageContentToString } from '../tokenize.js';

export interface SummarizerConfig {
  model: string;           // 如 'gpt-4o-mini' / 'claude-haiku'
  apiKey: string;
  baseURL: string;         // 如 'https://api.openai.com'
  targetRatio?: number;    // 目标压缩比，默认 0.2（压到 1/5）
}

// 可注入的摘要函数（测试时用 mock，生产用真实 API）
export type SummarizerFn = (messages: Message[]) => Promise<string>;

export interface SummarizeResult {
  summary: string;
  originalTokens: number;
  summaryTokens: number;
}

// 把 messages 格式化成 LLM 易读的对话文本
function formatMessagesForSummary(messages: Message[]): string {
  return messages
    .map((m) => {
      const role = m.role.toUpperCase();
      const content = messageContentToString(m.content);
      return `[${role}]: ${content}`;
    })
    .join('\n\n');
}

// 结构化摘要：将旧对话压成可继续执行任务的稳定状态，而不是普通文章摘要。
function buildSummaryPrompt(messages: Message[]): Message[] {
  const conversation = formatMessagesForSummary(messages);
  const systemPrompt = `You maintain the durable working memory of a coding agent. Convert the old conversation into a compact structured state.

Requirements:
- Preserve user goals, acceptance criteria, constraints and unresolved questions
- Preserve decisions and their rationale
- Preserve exact file paths, symbols, APIs, commands, errors and configuration values
- Preserve short critical code snippets or patches; omit replaceable boilerplate
- Record which facts are confirmed versus assumptions
- Never invent missing information
- Write in the same language as the original conversation
- Target length: about 1/5 of the original

Use exactly these sections:
## Goal
## Constraints
## Decisions
## Files and symbols
## Completed work
## Open issues and next steps
## Critical snippets

Output ONLY the summary, no preamble.`;

  return [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: `Conversation to summarize:\n\n${conversation}` },
  ];
}

// 默认摘要实现：调 OpenAI 兼容 API
export function createDefaultSummarizer(config: SummarizerConfig): SummarizerFn {
  const targetRatio = config.targetRatio ?? 0.2;

  return async (messages: Message[]): Promise<string> => {
    const promptMessages = buildSummaryPrompt(messages);
    const originalTokens = countMessagesTokens(messages);

    const resp = await fetch(`${config.baseURL}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        messages: promptMessages,
        temperature: 0,
        max_tokens: Math.max(256, Math.floor(originalTokens * targetRatio)),
      }),
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`Summarizer API error ${resp.status}: ${text.slice(0, 200)}`);
    }

    const data = (await resp.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const summary = data.choices?.[0]?.message?.content?.trim() || '';
    if (!summary) {
      throw new Error('Summarizer returned empty content');
    }
    return summary;
  };
}

// 对外暴露的摘要入口：接收 messages 和 summarizer，返回摘要结果
export async function summarizeMessages(
  messages: Message[],
  summarizer: SummarizerFn
): Promise<SummarizeResult> {
  const originalTokens = countMessagesTokens(messages);
  const summary = await summarizer(messages);
  const summaryTokens = countMessageTokens({ role: 'system', content: summary });

  return {
    summary,
    originalTokens,
    summaryTokens,
  };
}

// 构造摘要消息（替换原历史块）
export function buildSummaryMessage(summary: string): Message {
  return {
    role: 'system',
    name: 'context-summary',
    content: `[Summary of earlier conversation]\n${summary}`,
  };
}
