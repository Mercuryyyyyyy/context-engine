import { encode } from 'gpt-tokenizer';
import type { Message } from './types.js';

// 计算 text 的 token 数（基于 cl100k_base，对 GPT-3.5/4 准确，对 Claude 近似）
export function countTokens(text: string): number {
  if (!text) return 0;
  try {
    return encode(text).length;
  } catch {
    // fallback：粗略估算（中文 ~1.5 字/token，英文 ~4 字符/token）
    return Math.ceil(text.length / 4);
  }
}

// 返回 text 的 token id 序列（用于 token 级前缀缓存命中预估）
export function encodeTokens(text: string): number[] {
  if (!text) return [];
  try {
    return encode(text);
  } catch {
    return [];
  }
}

export function messageContentToString(content: Message['content']): string {
  if (typeof content === 'string') return content;
  return content.map((p) => ('text' in p ? p.text : '')).join('');
}

// 单条消息的 token 数（含 ~4 token 的角色/结构开销，近似 OpenAI 公式）
export function countMessageTokens(msg: Message): number {
  let tokens = countTokens(messageContentToString(msg.content)) + 4;
  if (msg.name) tokens += countTokens(msg.name) + 1;
  if (msg.tool_call_id) tokens += countTokens(msg.tool_call_id) + 1;
  if (msg.tool_calls) tokens += countTokens(JSON.stringify(msg.tool_calls));
  return tokens;
}

export function countMessagesTokens(msgs: Message[]): number {
  return msgs.reduce((sum, m) => sum + countMessageTokens(m), 0);
}
