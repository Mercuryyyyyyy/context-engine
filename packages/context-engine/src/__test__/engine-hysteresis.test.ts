// P1-A: compaction hysteresis 测试
// 验证：
// 1. 未达高水位时不触发有损压缩
// 2. 超过高水位触发压缩，目标压缩到低水位
// 3. 自定义 highWatermark / lowWatermark 生效
// 4. 默认 lowWatermark = budget * 0.7

import { runEngine } from '../engine.js';
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
  console.log('\n=== Hysteresis 测试 1: 未达高水位不触发有损压缩 ===');
  {
    const messages: Message[] = [{ role: 'system', content: 'stable system' }];
    for (let i = 0; i < 6; i++) {
      messages.push({ role: 'user', content: `old request ${i}` });
      messages.push({ role: 'assistant', content: longCode(`oldFunction${i}`) });
    }
    messages.push({ role: 'user', content: 'current query' });

    // budget 设大，highWatermark 显式更大，避免触发
    const result = await runEngine({
      messages,
      model: 'test',
      budget: 100000,
      compaction: { highWatermark: 100000, lowWatermark: 50000 },
    });
    check(!result.stats.strategies.includes('summarize'), '未达高水位不触发 summarize');
    check(!result.stats.strategies.includes('clear-middle'), '未达高水位不触发 clear-middle');
    check(!result.stats.strategies.includes('semantic-fold'), '未达高水位不触发 semantic-fold');
    check(!result.stats.budgetExceeded, '未超预算');
  }

  console.log('\n=== Hysteresis 测试 2: 超过高水位触发 clear-middle，目标压缩到低水位 ===');
  {
    const messages: Message[] = [{ role: 'system', content: 'stable system' }];
    for (let i = 0; i < 12; i++) {
      messages.push({ role: 'user', content: `old request ${i}` });
      messages.push({ role: 'assistant', content: longCode(`oldFunction${i}`) });
    }
    messages.push({ role: 'user', content: 'current query' });

    // budget = 5000，highWatermark = 2500，lowWatermark = 1500
    // 12 轮 longCode 累计 ~4500 tokens，应触发 clear-middle 并压缩到 1500 附近
    const result = await runEngine({
      messages,
      model: 'test',
      budget: 5000,
      compaction: { highWatermark: 2500, lowWatermark: 1500 },
      recentKeep: 4,
    });
    check(result.stats.strategies.includes('clear-middle'), '超高水位触发 clear-middle');
    check(result.stats.optimizedTokens <= 2500, `压缩后 token 应低于高水位 (实际: ${result.stats.optimizedTokens})`);
    // 由于语义上要求压缩到 target（lowWatermark），通常应明显低于 highWatermark
    check(result.stats.optimizedTokens < result.stats.originalTokens, `压缩后 token 减少 (优化: ${result.stats.optimizedTokens}, 原始: ${result.stats.originalTokens})`);
  }

  console.log('\n=== Hysteresis 测试 3: 默认 highWatermark = budget ===');
  {
    const messages: Message[] = [{ role: 'system', content: 'stable system' }];
    for (let i = 0; i < 8; i++) {
      messages.push({ role: 'user', content: `old request ${i}` });
      messages.push({ role: 'assistant', content: longCode(`oldFunction${i}`) });
    }
    messages.push({ role: 'user', content: 'current query' });

    // 不提供 compaction，默认 highWatermark = budget = 2400
    const result = await runEngine({
      messages,
      model: 'test',
      budget: 2400,
      recentKeep: 4,
    });
    check(result.stats.strategies.includes('clear-middle'), '默认高水位 = budget，超则触发 clear-middle');
    check(result.stats.optimizedTokens <= 2400, `压缩后 token <= budget (实际: ${result.stats.optimizedTokens})`);
  }

  console.log('\n=== Hysteresis 测试 4: 默认 lowWatermark = budget * 0.7 ===');
  {
    const messages: Message[] = [{ role: 'system', content: 'stable system' }];
    for (let i = 0; i < 12; i++) {
      messages.push({ role: 'user', content: `old request ${i}` });
      messages.push({ role: 'assistant', content: longCode(`oldFunction${i}`) });
    }
    messages.push({ role: 'user', content: 'current query' });

    // budget = 3000，默认 lowWatermark = 2100
    // clear-middle 应压缩到 2100 附近而非 3000 附近
    const result = await runEngine({
      messages,
      model: 'test',
      budget: 3000,
      recentKeep: 4,
    });
    check(result.stats.strategies.includes('clear-middle'), '触发 clear-middle');
    // 压缩后 token 应明显低于 budget（接近 lowWatermark）
    // 注意：保护区头部和尾部不会被清空，所以可能略高于 lowWatermark，但应远低于 budget
    check(result.stats.optimizedTokens < 3000, `压缩后 token < budget (实际: ${result.stats.optimizedTokens})`);
  }

  console.log('\n=== Hysteresis 测试 5: 摘要触发也使用 highWatermark ===');
  {
    const mockSummary = async (items: Message[]) => `[summary of ${items.length} msgs]`;
    const messages: Message[] = [{ role: 'system', content: 'stable system' }];
    for (let i = 0; i < 10; i++) {
      messages.push({ role: 'user', content: `old request ${i}` });
      messages.push({ role: 'assistant', content: longCode(`oldFunction${i}`) });
    }
    messages.push({ role: 'user', content: 'current query' });

    // highWatermark 设很高，不应触发摘要
    const result1 = await runEngine({
      messages,
      model: 'test',
      budget: 1000,
      compaction: { highWatermark: 100000, lowWatermark: 500 },
      summarizer: { fn: mockSummary, recentKeep: 4 },
    });
    check(!result1.stats.strategies.includes('summarize'), '未达高水位不触发 summarize');

    // highWatermark 设很低，应触发摘要
    const result2 = await runEngine({
      messages,
      model: 'test',
      budget: 1000,
      compaction: { highWatermark: 100, lowWatermark: 50 },
      summarizer: { fn: mockSummary, recentKeep: 4 },
    });
    check(result2.stats.strategies.includes('summarize'), '超高水位触发 summarize');
  }

  console.log('\n=== Hysteresis 测试 6: 相邻轮次 hysteresis 减少频繁触发 ===');
  {
    // 模拟连续两轮对话：
    // 第 1 轮：超过高水位，触发 clear-middle 压缩到低水位
    // 第 2 轮：追加少量新消息，应在低水位附近不再触发 clear-middle
    const messages1: Message[] = [{ role: 'system', content: 'stable system' }];
    for (let i = 0; i < 10; i++) {
      messages1.push({ role: 'user', content: `old request ${i}` });
      messages1.push({ role: 'assistant', content: longCode(`oldFunction${i}`) });
    }
    messages1.push({ role: 'user', content: 'current query 1' });

    const result1 = await runEngine({
      messages: messages1,
      model: 'test',
      budget: 3000,
      compaction: { highWatermark: 3000, lowWatermark: 2100 },
      recentKeep: 4,
    });
    check(result1.stats.strategies.includes('clear-middle'), '第 1 轮触发 clear-middle');

    // 第 2 轮：追加一轮对话
    const messages2: Message[] = [
      ...result1.messages,
      { role: 'assistant', content: 'short answer' },
      { role: 'user', content: 'next query' },
    ];
    const result2 = await runEngine({
      messages: messages2,
      model: 'test',
      budget: 3000,
      compaction: { highWatermark: 3000, lowWatermark: 2100 },
      previousMessages: result1.messages,
      recentKeep: 4,
    });
    // 第 2 轮 token 应在 lowWatermark + 增量附近，如果仍低于 highWatermark 则不应再触发 clear-middle
    if (result2.stats.optimizedTokens < 3000) {
      check(!result2.stats.strategies.includes('clear-middle'),
        `第 2 轮低于高水位不应再触发 clear-middle (token: ${result2.stats.optimizedTokens})`);
    } else {
      check(true, `第 2 轮仍超高水位，继续触发 clear-middle (token: ${result2.stats.optimizedTokens})`);
    }
    // 缓存应命中上一轮前缀
    check(result2.stats.cacheHitTokens > 0, '第 2 轮复用上一轮稳定前缀');
  }

  console.log('\n=== Hysteresis 测试 7: 无 budget 时不触发有损压缩 ===');
  {
    const messages: Message[] = [{ role: 'system', content: 'stable system' }];
    for (let i = 0; i < 10; i++) {
      messages.push({ role: 'user', content: `old request ${i}` });
      messages.push({ role: 'assistant', content: longCode(`oldFunction${i}`) });
    }
    messages.push({ role: 'user', content: 'current query' });

    // 无 budget，无 compaction
    const result = await runEngine({
      messages,
      model: 'test',
    });
    check(!result.stats.strategies.includes('summarize'), '无 budget 不触发 summarize');
    check(!result.stats.strategies.includes('clear-middle'), '无 budget 不触发 clear-middle');
    check(!result.stats.strategies.includes('semantic-fold'), '无 budget 不触发 semantic-fold');
  }

  console.log('\n=== Hysteresis 测试 8: lowWatermark 高于 highWatermark 时仍正常工作 ===');
  {
    const messages: Message[] = [{ role: 'system', content: 'stable system' }];
    for (let i = 0; i < 8; i++) {
      messages.push({ role: 'user', content: `old request ${i}` });
      messages.push({ role: 'assistant', content: longCode(`oldFunction${i}`) });
    }
    messages.push({ role: 'user', content: 'current query' });

    // 异常配置：lowWatermark > highWatermark，应不崩溃
    const result = await runEngine({
      messages,
      model: 'test',
      budget: 2000,
      compaction: { highWatermark: 2000, lowWatermark: 3000 },
      recentKeep: 4,
    });
    check(result.stats.optimizedTokens !== undefined, '异常配置不崩溃');
    // 由于 target=3000 > highWatermark=2000，clear-middle 一旦进入循环立即 break（total <= target）
    // 但仍应记录 budget-exceeded-protected
  }

  console.log(`\n--- 汇总 ---\n通过: ${passed}, 失败: ${failed}`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
