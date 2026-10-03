import { runEngine } from '../engine.js';
import { reversibleCompress } from '../compress/reversible.js';
import type { Message } from '../types.js';

let passed = 0;
let failed = 0;

function check(condition: boolean, label: string): void {
  if (condition) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.log(`  ✗ ${label}`);
  }
}

function longCode(name: string): string {
  const body = Array.from({ length: 30 }, (_, i) => `  const value${i} = input + ${i};`).join('\n');
  return `function ${name}(input: number) {\n${body}\n  return value29;\n}`;
}

async function main(): Promise<void> {
  console.log('\n=== 策略1: 默认压缩必须无损 ===');
  const code = longCode('importantCalculation');
  const normalized = reversibleCompress(code);
  check(normalized.compressed.includes('const value20'), '默认模式保留代码正文');
  check(!normalized.compressed.includes('<folded:'), '默认模式不产生有损占位符');

  console.log('\n=== 策略2: semantic fold 只处理旧历史 ===');
  const messages: Message[] = [{ role: 'system', content: 'Always preserve the current request.' }];
  for (let i = 0; i < 10; i++) {
    messages.push({ role: 'user', content: `old request ${i}` });
    messages.push({ role: 'assistant', content: longCode(`oldFunction${i}`) });
  }
  const currentQuery = `请基于当前代码回答，必须保留此标记 CURRENT_QUERY_SENTINEL\n${longCode('currentFunction')}`;
  messages.push({ role: 'user', content: currentQuery });

  const folded = await runEngine({
    messages,
    model: 'test',
    budget: 2400,
    recentKeep: 4,
    enableSemanticFold: true,
  });
  const outputText = folded.messages.map((message) => typeof message.content === 'string' ? message.content : '').join('\n');
  check(outputText.includes('CURRENT_QUERY_SENTINEL'), '当前 query 始终保留');
  check(outputText.includes('const value20'), '当前 query 中的代码正文不折叠');
  check(folded.stats.strategies.includes('semantic-fold'), '超预算时命中显式 semantic-fold');

  console.log('\n=== 策略3: query-aware retrieval 注入 ===');
  const retrieved = await runEngine({
    messages: [
      { role: 'system', content: 'coding assistant' },
      { role: 'user', content: 'Where is parseConfig defined?' },
    ],
    model: 'test',
    retrieval: {
      topK: 2,
      maxTokens: 200,
      search: async () => [
        { id: 'src/config.ts', content: 'export function parseConfig() { return {}; }', score: 0.9 },
      ],
    },
  });
  check(retrieved.stats.strategies.includes('retrieve'), '记录 retrieve 策略');
  check(retrieved.messages.some((message) => message.name === 'context-retrieval'), '检索结果进入实际 messages');
  check((retrieved.stats.retrievedTokens ?? 0) > 0, '统计检索 token');

  console.log('\n=== 策略4: 稳定请求前缀命中 ===');
  const first = await runEngine({
    messages: [
      { role: 'system', content: 'stable system' },
      { role: 'user', content: 'first question' },
    ],
    model: 'test',
  });
  const secondInput: Message[] = [
    ...first.messages,
    { role: 'assistant', content: 'first answer' },
    { role: 'user', content: 'second question' },
  ];
  const second = await runEngine({
    messages: secondInput,
    model: 'test',
    previousMessages: first.messages,
  });
  check(second.stats.cacheHitTokens > 0, '精确 request payload 产生前缀命中');
  check(second.stats.cacheHitRate > 0, '缓存命中率大于 0');

  console.log('\n=== 策略5: compaction epoch 复用 ===');
  const rawEpoch1: Message[] = [{ role: 'system', content: 'stable epoch system' }];
  for (let i = 0; i < 12; i++) {
    rawEpoch1.push({ role: 'user', content: `epoch question ${i}` });
    rawEpoch1.push({ role: 'assistant', content: longCode(`epochFunction${i}`) });
  }
  rawEpoch1.push({ role: 'user', content: 'current epoch request' });
  const epoch1 = await runEngine({ messages: rawEpoch1, baselineMessages: rawEpoch1, model: 'test', budget: 2200 });
  const suffix: Message[] = [
    { role: 'assistant', content: 'current epoch answer' },
    { role: 'user', content: 'next epoch request' },
  ];
  const rawEpoch2 = [...rawEpoch1, ...suffix];
  const epoch2 = await runEngine({
    messages: [...epoch1.messages, ...suffix],
    baselineMessages: rawEpoch2,
    previousMessages: epoch1.messages,
    model: 'test',
    budget: 2200,
  });
  check(epoch1.stats.strategies.includes('clear-middle'), '首次超预算发生 compaction');
  check(!epoch1.stats.strategies.includes('clear-tail'), '近期 tail 不再参与清空');
  check(epoch2.stats.cacheHitTokens > 0, '下一轮复用 compaction 后稳定前缀');
  check(epoch2.stats.originalTokens > epoch2.stats.optimizedTokens, '统计仍以未压缩 baseline 为准');
  const epoch1Cleared = epoch1.messages
    .map((message) => typeof message.content === 'string' ? message.content : '')
    .filter((content) => content.startsWith('[cleared:'));
  const epoch2Cleared = epoch2.messages
    .map((message) => typeof message.content === 'string' ? message.content : '')
    .filter((content) => content.startsWith('[cleared:'));
  check(epoch1Cleared.every((content) => epoch2Cleared.includes(content)), '已清空占位符不会被递归改写');

  console.log('\n=== 策略6: 摘要在 epoch 间合并而非累积 ===');
  const mockSummary = async (items: Message[]) => `summary for ${items.length} messages`;
  const summaryEpoch1 = await runEngine({
    messages: rawEpoch1,
    baselineMessages: rawEpoch1,
    model: 'test',
    budget: 1800,
    summarizer: { fn: mockSummary, recentKeep: 4 },
  });
  const summaryEpoch2 = await runEngine({
    messages: [...summaryEpoch1.messages, ...suffix, ...suffix],
    baselineMessages: [...rawEpoch1, ...suffix, ...suffix],
    previousMessages: summaryEpoch1.messages,
    model: 'test',
    budget: 1800,
    summarizer: { fn: mockSummary, recentKeep: 4 },
  });
  check(summaryEpoch1.messages.filter((message) => message.name === 'context-summary').length === 1, '首次 compaction 只生成一个摘要');
  check(summaryEpoch2.messages.filter((message) => message.name === 'context-summary').length <= 1, '后续 compaction 合并旧摘要');

  console.log(`\n--- 汇总 ---\n通过: ${passed}, 失败: ${failed}`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
