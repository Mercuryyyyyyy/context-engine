import type { Message } from './types.js';
import { countMessageTokens, messageContentToString, encodeTokens } from './tokenize.js';

export interface CacheHitResult {
  hitTokens: number;
  hitRate: number;
  firstDiffIndex: number; // 第一条不一致的 message 索引
}

// 判断两条 message 是否逐字一致（缓存命中的硬性条件）
function messagesEqual(a: Message, b: Message): boolean {
  if (a.role !== b.role) return false;
  if (a.name !== b.name || a.tool_call_id !== b.tool_call_id) return false;
  if (JSON.stringify(a.tool_calls ?? null) !== JSON.stringify(b.tool_calls ?? null)) return false;
  const aContent = typeof a.content === 'string' ? a.content : JSON.stringify(a.content);
  const bContent = typeof b.content === 'string' ? b.content : JSON.stringify(b.content);
  return aContent === bContent;
}

// 将一条 message 序列化为 token id（近似角色/结构 token，用于前缀匹配）
function messageTokenIds(msg: Message): number[] {
  const parts: string[] = [msg.role];
  if (msg.name) parts.push(msg.name);
  if (msg.tool_call_id) parts.push(msg.tool_call_id);
  if (msg.tool_calls) parts.push(JSON.stringify(msg.tool_calls));
  parts.push(messageContentToString(msg.content));
  return parts.flatMap((p) => encodeTokens(p));
}

// 两条同位置消息的最长公共 token 前缀长度（捕获「消息被部分追加」的前缀命中）
function partialTokenPrefix(a: Message, b: Message): number {
  const at = messageTokenIds(a);
  const bt = messageTokenIds(b);
  const len = Math.min(at.length, bt.length);
  let n = 0;
  while (n < len && at[n] === bt[n]) n++;
  return n;
}

// 预估前缀缓存命中：对比 current 和 previous，找最长公共前缀
export function estimateCacheHit(
  current: Message[],
  previous: Message[]
): CacheHitResult {
  if (previous.length === 0) {
    return { hitTokens: 0, hitRate: 0, firstDiffIndex: 0 };
  }

  let hitTokens = 0;
  let firstDiffIndex = 0;
  const minLen = Math.min(current.length, previous.length);

  for (let i = 0; i < minLen; i++) {
    const cur = current[i]!;
    const prev = previous[i]!;
    if (messagesEqual(cur, prev)) {
      hitTokens += countMessageTokens(cur);
      firstDiffIndex = i + 1;
    } else {
      // 消息不完全一致时，仍可能共享 token 级前缀（例如仅尾部追加内容），
      // 逐 token 计算最长公共前缀，提高命中预估精度。
      hitTokens += partialTokenPrefix(cur, prev);
      break;
    }
  }

  const totalTokens = current.reduce((s, m) => s + countMessageTokens(m), 0);
  const hitRate = totalTokens > 0 ? hitTokens / totalTokens : 0;

  return { hitTokens, hitRate, firstDiffIndex };
}
