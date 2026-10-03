// 摘要压缩逻辑测试（用 mock summarizer，不调真实 API）
// 运行: pnpm --filter @context/engine tsx src/__test__/engine-summarize.test.ts

import { runEngine } from '../engine.js';
import type { Message } from '../types.js';

// mock summarizer：把多条消息压成一句摘要
function mockSummarizer(messages: Message[]): Promise<string> {
  const count = messages.length;
  const firstContent = typeof messages[0]?.content === 'string' ? messages[0].content.slice(0, 30) : '';
  return Promise.resolve(
    `[Mock summary of ${count} messages. First: "${firstContent}...". Key points preserved.]`
  );
}

// 构造长对话：1 system + 10 轮 history (20 messages) + 1 dynamic
function buildLongConversation(): Message[] {
  const messages: Message[] = [
    { role: 'system', content: 'You are a coding assistant.' },
  ];
  for (let i = 1; i <= 10; i++) {
    messages.push({
      role: 'user',
      content: `Question ${i}: Explain concept ${i} in detail. `.repeat(20),
    });
    messages.push({
      role: 'assistant',
      content: `Answer ${i}: Here is the detailed explanation of concept ${i}. `.repeat(20),
    });
  }
  // 最后一条 user（dynamic）
  messages.push({ role: 'user', content: 'Summarize what we discussed.' });
  return messages;
}

async function main() {
  const messages = buildLongConversation();
  console.log(`原始消息数: ${messages.length}`);

  // 测试 1：不启用摘要，只裁剪（关闭可逆压缩，避免长行被折叠影响测试）
  const result1 = await runEngine({
    messages,
    model: 'gpt-4',
    budget: 1500,
    enableReversible: false,
  });
  console.log('\n测试1 - 仅裁剪（无摘要）:');
  console.log(`  original: ${result1.stats.originalTokens} tok`);
  console.log(`  optimized: ${result1.stats.optimizedTokens} tok`);
  console.log(`  saved: ${result1.stats.savedTokens} tok`);
  console.log(`  strategies: ${result1.stats.strategies.join(', ')}`);
  console.log(`  output msgs: ${result1.messages.length}`);

  // 测试 2：启用摘要
  const result2 = await runEngine({
    messages,
    model: 'gpt-4',
    budget: 1500,
    enableReversible: false,
    summarizer: {
      fn: mockSummarizer,
      recentKeep: 4, // 保留最近 4 条 history
    },
  });
  console.log('\n测试2 - 启用摘要:');
  console.log(`  original: ${result2.stats.originalTokens} tok`);
  console.log(`  optimized: ${result2.stats.optimizedTokens} tok`);
  console.log(`  saved: ${result2.stats.savedTokens} tok`);
  console.log(`  strategies: ${result2.stats.strategies.join(', ')}`);
  console.log(`  output msgs: ${result2.messages.length}`);

  // 检查摘要消息是否在输出中
  const hasSummary = result2.messages.some(
    (m) => typeof m.content === 'string' && m.content.includes('[Summary of earlier conversation]')
  );
  console.log(`  包含摘要消息: ${hasSummary ? '✓' : '✗'}`);

  // 检查 dynamic（最后一条 user）是否保留
  const lastMsg = result2.messages[result2.messages.length - 1];
  const dynamicPreserved = lastMsg && typeof lastMsg.content === 'string'
    && lastMsg.content.includes('Summarize what we discussed');
  console.log(`  dynamic 保留: ${dynamicPreserved ? '✓' : '✗'}`);

  // 检查 system 是否保留
  const systemPreserved = result2.messages[0]?.role === 'system';
  console.log(`  system 保留: ${systemPreserved ? '✓' : '✗'}`);

  // 测试 3：预算足够大，不应触发摘要
  const result3 = await runEngine({
    messages,
    model: 'gpt-4',
    budget: 100000,
    enableReversible: false,
    summarizer: { fn: mockSummarizer, recentKeep: 4 },
  });
  console.log('\n测试3 - 预算充足（不应触发摘要）:');
  console.log(`  strategies: ${result3.stats.strategies.join(', ')}`);
  const noSummarize = !result3.stats.strategies.includes('summarize');
  console.log(`  未触发摘要: ${noSummarize ? '✓' : '✗'}`);

  // 汇总
  console.log('\n--- 汇总 ---');
  const allPass = hasSummary && dynamicPreserved && systemPreserved && noSummarize;
  console.log(`摘要触发: ${hasSummary ? '✓' : '✗'}`);
  console.log(`关键内容保留: ${dynamicPreserved && systemPreserved ? '✓' : '✗'}`);
  console.log(`预算充足不误触: ${noSummarize ? '✓' : '✗'}`);
  console.log(`\n结果: ${allPass ? 'PASS ✓' : 'FAIL ✗'}`);
  process.exit(allPass ? 0 : 1);
}

main().catch((e) => {
  console.error('Test error:', e);
  process.exit(1);
});
