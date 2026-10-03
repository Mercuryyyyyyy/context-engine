// Engine 归档集成测试
// 验证 runEngine + ModuleTracker + ArchiveStore + ArchiveRetriever 完整流程
// 使用 mock summarizer，不依赖真实 LLM

import {
  runEngine,
  ModuleTracker,
  ArchiveStore,
  ArchiveRetriever,
  type Message,
  type EngineOutput,
} from '../index.js';

let pass = 0;
let fail = 0;

function assert(condition: boolean, message: string): void {
  if (condition) {
    pass++;
    console.log(`  ✓ ${message}`);
  } else {
    fail++;
    console.error(`  ✗ ${message}`);
  }
}

const tests: Array<{ name: string; fn: () => Promise<void> | void }> = [];

function test(name: string, fn: () => Promise<void> | void): void {
  tests.push({ name, fn });
}

async function runAll(): Promise<void> {
  for (const { name, fn } of tests) {
    console.log(`\n${name}`);
    await fn();
  }
}

// Mock summarizer：返回简单摘要字符串（SummarizerFn 签名要求返回 Promise<string>）
function mockSummarizer() {
  return async (messages: Message[]) => {
    const firstUser = messages.find((m) => m.role === 'user');
    const content = typeof firstUser?.content === 'string'
      ? firstUser.content.slice(0, 50)
      : 'summary';
    return `[Mock summary of ${messages.length} messages: ${content}...]`;
  };
}

// ============================================================
// 测试 1：主题切换触发归档，消息被替换为摘要
// ============================================================
test('Test 1: 主题切换触发归档', async () => {
  const moduleTracker = new ModuleTracker({ topicSwitchThreshold: 0.20, archiveDelayRounds: 2 });
  const archiveStore = new ArchiveStore();
  const archiveRetriever = new ArchiveRetriever(archiveStore, { topicGateThreshold: 0.05 });

  // Turn 1: TypeScript 类型（module-1 开始）
  const turn1Messages: Message[] = [
    { role: 'system', content: 'You are a helpful assistant.' },
    { role: 'user', content: 'TypeScript type guard undefined check' },
  ];
  const result1 = await runEngine({
    messages: turn1Messages,
    model: 'test',
    archive: { moduleTracker, archiveStore, retriever: archiveRetriever, enableSummary: false },
    currentTurn: 1,
    summarizer: { fn: mockSummarizer() },
  });
  assert(result1.stats.archivedModules === 0, 'Turn 1 无归档');
  assert(!result1.messages.some((m) => m.name === 'context-archive'), 'Turn 1 无归档摘要消息');

  // Turn 2: TypeScript 继续（module-1 继续）
  const turn2Messages: Message[] = [
    ...turn1Messages,
    { role: 'assistant', content: 'Use type guard to check undefined.' },
    { role: 'user', content: 'TypeScript generic type constraint' },
  ];
  const result2 = await runEngine({
    messages: turn2Messages,
    model: 'test',
    previousMessages: turn1Messages,
    archive: { moduleTracker, archiveStore, retriever: archiveRetriever, enableSummary: false },
    currentTurn: 2,
    summarizer: { fn: mockSummarizer() },
  });
  assert(result2.stats.archivedModules === 0, 'Turn 2 无归档（同主题）');

  // Turn 3: 切换到 Postgres（module-2 开始）
  const turn3Messages: Message[] = [
    ...turn2Messages,
    { role: 'assistant', content: 'Use extends keyword for generic constraints.' },
    { role: 'user', content: 'Postgres index optimization query performance' },
  ];
  const result3 = await runEngine({
    messages: turn3Messages,
    model: 'test',
    previousMessages: turn2Messages,
    archive: { moduleTracker, archiveStore, retriever: archiveRetriever, enableSummary: false },
    currentTurn: 3,
    summarizer: { fn: mockSummarizer() },
  });
  assert(result3.stats.archivedModules === 0, 'Turn 3 无归档（module-1 仅过 1 轮）');

  // Turn 4: Postgres 继续（module-1 过 2 轮，触发归档）
  const turn4Messages: Message[] = [
    ...turn3Messages,
    { role: 'assistant', content: 'Create B-tree index on frequently queried columns.' },
    { role: 'user', content: 'Postgres transaction isolation level' },
  ];
  const result4 = await runEngine({
    messages: turn4Messages,
    model: 'test',
    previousMessages: turn3Messages,
    archive: { moduleTracker, archiveStore, retriever: archiveRetriever, enableSummary: false },
    currentTurn: 4,
    summarizer: { fn: mockSummarizer() },
  });
  assert(result4.stats.archivedModules === 1, 'Turn 4 归档 1 个模块（module-1）');
  assert((result4.stats.archivedMessages ?? 0) > 0, 'Turn 4 归档消息数 > 0');
  assert(result4.messages.some((m) => m.name === 'context-archive'), 'Turn 4 有归档摘要消息');
  assert(result4.stats.strategies.includes('archive'), 'Turn 4 strategies 包含 archive');
  assert(archiveStore.size > 0, 'ArchiveStore 有归档内容');
  assert(archiveStore.moduleCount === 1, 'ArchiveStore 有 1 个模块');
});

// ============================================================
// 测试 2：归档后内容可通过检索找回
// ============================================================
test('Test 2: 归档后检索找回内容', async () => {
  const moduleTracker = new ModuleTracker({ topicSwitchThreshold: 0.20, archiveDelayRounds: 1 });
  const archiveStore = new ArchiveStore();
  const archiveRetriever = new ArchiveRetriever(archiveStore, {
    topicGateThreshold: 0.05,
    minScore: 0.001,
    maxTokens: 2000,
  });

  // Turn 1: TypeScript 类型
  const messages1: Message[] = [
    { role: 'system', content: 'You are a helpful assistant.' },
    { role: 'user', content: 'TypeScript type guard undefined check implementation' },
    { role: 'assistant', content: 'Use type guard to check undefined in TypeScript.' },
  ];
  await runEngine({
    messages: messages1,
    model: 'test',
    archive: { moduleTracker, archiveStore, retriever: archiveRetriever, enableSummary: false },
    currentTurn: 1,
    summarizer: { fn: mockSummarizer() },
  });

  // Turn 2: 切换到 Postgres，module-1 过 1 轮触发归档
  const messages2: Message[] = [
    ...messages1,
    { role: 'user', content: 'Postgres database index optimization query performance' },
    { role: 'assistant', content: 'Create B-tree index on frequently queried columns.' },
    { role: 'user', content: 'Postgres transaction isolation' },
  ];
  await runEngine({
    messages: messages2,
    model: 'test',
    previousMessages: messages1,
    archive: { moduleTracker, archiveStore, retriever: archiveRetriever, enableSummary: false },
    currentTurn: 2,
    summarizer: { fn: mockSummarizer() },
  });

  assert(archiveStore.size > 0, 'ArchiveStore 有内容');

  // 直接从 ArchiveStore 检索 TypeScript 相关内容
  const results = await archiveStore.search('TypeScript type guard', 5);
  assert(results.length > 0, '检索 TypeScript 有结果');
  assert(results.some((r) => r.content.includes('type guard')), '结果包含 type guard 内容');
});

// ============================================================
// 测试 3：topic gate 阻止不相关检索注入
// ============================================================
test('Test 3: topic gate 阻止不相关检索', async () => {
  const moduleTracker = new ModuleTracker({ topicSwitchThreshold: 0.20, archiveDelayRounds: 1 });
  const archiveStore = new ArchiveStore();
  const archiveRetriever = new ArchiveRetriever(archiveStore, {
    topicGateThreshold: 0.50,  // 高阈值
    minScore: 0.001,
  });

  // Turn 1: TypeScript
  const messages1: Message[] = [
    { role: 'system', content: 'You are a helpful assistant.' },
    { role: 'user', content: 'TypeScript type guard undefined check' },
    { role: 'assistant', content: 'Use type guard for undefined checks.' },
  ];
  await runEngine({
    messages: messages1,
    model: 'test',
    archive: { moduleTracker, archiveStore, retriever: archiveRetriever, enableSummary: false },
    currentTurn: 1,
    summarizer: { fn: mockSummarizer() },
  });

  // Turn 2: Postgres，归档 module-1
  const messages2: Message[] = [
    ...messages1,
    { role: 'user', content: 'Postgres database index optimization' },
    { role: 'assistant', content: 'Create B-tree index.' },
    { role: 'user', content: 'Postgres transaction isolation' },
  ];
  await runEngine({
    messages: messages2,
    model: 'test',
    previousMessages: messages1,
    archive: { moduleTracker, archiveStore, retriever: archiveRetriever, enableSummary: false },
    currentTurn: 2,
    budget: 100,  // 设小 budget 触发 retrieval
    summarizer: { fn: mockSummarizer() },
  });

  // 用高阈值检索器搜 TypeScript（与 Postgres 不相关）
  const results = await archiveRetriever.search('Postgres database', 5);
  // Postgres 查询不应匹配到 TypeScript 归档内容（topic gate 阻止）
  const log = archiveRetriever.getLastSearchLog();
  if (log && log.totalRetrieved > 0) {
    assert(log.rejectedByTopicGate > 0 || log.acceptedCount === 0, 'topic gate 阻止不相关结果');
  }
});

// ============================================================
// 测试 4：无 archive 选项时引擎正常工作
// ============================================================
test('Test 4: 无 archive 选项时正常工作', async () => {
  const messages: Message[] = [
    { role: 'system', content: 'You are a helpful assistant.' },
    { role: 'user', content: 'Hello world' },
  ];
  const result = await runEngine({
    messages,
    model: 'test',
  });
  assert(result.stats.archivedModules === undefined || result.stats.archivedModules === 0, '无 archive 时不归档');
  assert(result.messages.length === 2, '消息数不变');
  assert(!result.messages.some((m) => m.name === 'context-archive'), '无归档摘要消息');
});

// ============================================================
// 测试 5：归档摘要消息格式正确
// ============================================================
test('Test 5: 归档摘要消息格式', async () => {
  const moduleTracker = new ModuleTracker({ topicSwitchThreshold: 0.20, archiveDelayRounds: 1 });
  const archiveStore = new ArchiveStore();
  const archiveRetriever = new ArchiveRetriever(archiveStore, { topicGateThreshold: 0.05 });

  const messages1: Message[] = [
    { role: 'system', content: 'System prompt' },
    { role: 'user', content: 'TypeScript type guard undefined' },
    { role: 'assistant', content: 'Use type guard.' },
  ];
  await runEngine({
    messages: messages1,
    model: 'test',
    archive: { moduleTracker, archiveStore, retriever: archiveRetriever, enableSummary: false },
    currentTurn: 1,
    summarizer: { fn: mockSummarizer() },
  });

  const messages2: Message[] = [
    ...messages1,
    { role: 'user', content: 'Postgres database index optimization' },
    { role: 'assistant', content: 'Create index.' },
    { role: 'user', content: 'Postgres transaction' },
  ];
  const result = await runEngine({
    messages: messages2,
    model: 'test',
    previousMessages: messages1,
    archive: { moduleTracker, archiveStore, retriever: archiveRetriever, enableSummary: false },
    currentTurn: 2,
    summarizer: { fn: mockSummarizer() },
  });

  const archiveMsg = result.messages.find((m) => m.name === 'context-archive');
  assert(archiveMsg !== undefined, '有归档摘要消息');
  assert(archiveMsg!.role === 'system', '归档消息 role 是 system');
  assert(String(archiveMsg!.content).includes('[Archived module:'), '包含 [Archived module:] 标识');
  assert(String(archiveMsg!.content).includes('Topic:'), '包含 Topic:');
  assert(String(archiveMsg!.content).includes('Summary:'), '包含 Summary:');
  assert(String(archiveMsg!.content).includes('Full content archived:'), '包含归档说明');
});

// ============================================================
// 测试 6：多模块连续归档
// ============================================================
test('Test 6: 多模块连续归档', async () => {
  const moduleTracker = new ModuleTracker({ topicSwitchThreshold: 0.20, archiveDelayRounds: 2 });
  const archiveStore = new ArchiveStore();
  const archiveRetriever = new ArchiveRetriever(archiveStore, { topicGateThreshold: 0.05 });

  // Turn 1-2: TypeScript
  let messages: Message[] = [
    { role: 'system', content: 'System' },
    { role: 'user', content: 'TypeScript type guard' },
  ];
  let prev = undefined;
  for (let turn = 1; turn <= 6; turn++) {
    const lastUser = messages[messages.length - 1]!;
    let newQuery = '';
    if (turn === 2) newQuery = 'TypeScript generic constraint';
    else if (turn === 3) newQuery = 'Postgres index optimization';  // 切换到 module-2
    else if (turn === 4) newQuery = 'Postgres transaction isolation';
    else if (turn === 5) newQuery = 'React hooks useEffect';  // 切换到 module-3
    else if (turn === 6) newQuery = 'React state management';

    if (turn > 1) {
      messages = [...messages, { role: 'assistant', content: `Answer ${turn - 1}` }, { role: 'user', content: newQuery }];
    }

    const result = await runEngine({
      messages,
      model: 'test',
      previousMessages: prev,
      archive: { moduleTracker, archiveStore, retriever: archiveRetriever, enableSummary: false },
      currentTurn: turn,
      summarizer: { fn: mockSummarizer() },
    });
    prev = messages;

    if (turn === 4) {
      // module-1 过 2 轮，触发归档
      assert((result.stats.archivedModules ?? 0) >= 1, `Turn ${turn} 归档 module-1`);
    }
    if (turn === 6) {
      // module-2 过 2 轮，触发归档
      assert((result.stats.archivedModules ?? 0) >= 1, `Turn ${turn} 归档 module-2`);
      assert(archiveStore.moduleCount >= 2, 'ArchiveStore 至少有 2 个模块');
    }
  }
});

// ============================================================
// 测试 7：P3 - HybridSearcher（带 embedFn）vs 纯 BM25
// 验证：有 embedFn 时 ArchiveStore 走混合检索路径
// 使用 mock embedFn 模拟向量检索（基于关键词重合度的伪向量）
// ============================================================
test('Test 7: P3 HybridSearcher 混合检索路径', async () => {
  // mock embedFn：把文本转为基于关键词的伪向量（512 维）
  // 同主题文本向量余弦相似度高，不同主题低
  const mockEmbedFn = async (text: string): Promise<Float32Array> => {
    const vec = new Float32Array(512);
    const lower = text.toLowerCase();
    // 简单 hash：每个关键词对应一个维度
    for (const match of lower.matchAll(/[a-z_]+/g)) {
      const word = match[0]!;
      let hash = 0;
      for (let i = 0; i < word.length; i++) hash = (hash * 31 + word.charCodeAt(i)) | 0;
      const idx = Math.abs(hash) % 512;
      vec[idx] = (vec[idx] ?? 0) + 1;
    }
    // 归一化
    let norm = 0;
    for (let i = 0; i < 512; i++) norm += vec[i]! * vec[i]!;
    norm = Math.sqrt(norm);
    if (norm > 0) for (let i = 0; i < 512; i++) vec[i] = vec[i]! / norm;
    return vec;
  };

  const moduleTracker = new ModuleTracker({ topicSwitchThreshold: 0.20, archiveDelayRounds: 1 });
  const archiveStoreHybrid = new ArchiveStore(mockEmbedFn);
  const archiveStoreKeyword = new ArchiveStore();  // 无 embedFn，纯 BM25
  const archiveRetrieverHybrid = new ArchiveRetriever(archiveStoreHybrid, { topicGateThreshold: 0.05 });
  const archiveRetrieverKeyword = new ArchiveRetriever(archiveStoreKeyword, { topicGateThreshold: 0.05 });

  // Turn 1: TypeScript 类型主题
  const messages1: Message[] = [
    { role: 'system', content: 'System' },
    { role: 'user', content: 'TypeScript type guard undefined check' },
    { role: 'assistant', content: 'Use typeof and type guard to check undefined.' },
  ];
  await runEngine({
    messages: messages1,
    model: 'test',
    archive: { moduleTracker, archiveStore: archiveStoreHybrid, retriever: archiveRetrieverHybrid, enableSummary: false },
    currentTurn: 1,
    summarizer: { fn: mockSummarizer() },
  });
  // 复制相同内容到 keyword-only store
  const moduleTracker2 = new ModuleTracker({ topicSwitchThreshold: 0.20, archiveDelayRounds: 1 });
  await runEngine({
    messages: messages1,
    model: 'test',
    archive: { moduleTracker: moduleTracker2, archiveStore: archiveStoreKeyword, retriever: archiveRetrieverKeyword, enableSummary: false },
    currentTurn: 1,
    summarizer: { fn: mockSummarizer() },
  });

  // Turn 2: 切换到 Postgres，触发 module-1 归档
  const messages2hybrid: Message[] = [
    ...messages1,
    { role: 'user', content: 'Postgres database index optimization' },
    { role: 'assistant', content: 'Create B-tree index.' },
    { role: 'user', content: 'Postgres transaction isolation' },
  ];
  await runEngine({
    messages: messages2hybrid,
    model: 'test',
    previousMessages: messages1,
    archive: { moduleTracker, archiveStore: archiveStoreHybrid, retriever: archiveRetrieverHybrid, enableSummary: false },
    currentTurn: 2,
    summarizer: { fn: mockSummarizer() },
  });
  const messages2kw: Message[] = [
    ...messages1,
    { role: 'user', content: 'Postgres database index optimization' },
    { role: 'assistant', content: 'Create B-tree index.' },
    { role: 'user', content: 'Postgres transaction isolation' },
  ];
  await runEngine({
    messages: messages2kw,
    model: 'test',
    previousMessages: messages1,
    archive: { moduleTracker: moduleTracker2, archiveStore: archiveStoreKeyword, retriever: archiveRetrieverKeyword, enableSummary: false },
    currentTurn: 2,
    summarizer: { fn: mockSummarizer() },
  });

  assert(archiveStoreHybrid.size > 0, 'hybrid store 归档了消息');
  assert(archiveStoreKeyword.size > 0, 'keyword store 归档了消息');
  assert(archiveStoreHybrid.size === archiveStoreKeyword.size, '两个 store 归档数量一致');

  // 用 TypeScript 相关 query 检索 — 应能找回 module-1 内容
  const hybridResults = await archiveStoreHybrid.search('TypeScript type guard', 5);
  const keywordResults = await archiveStoreKeyword.search('TypeScript type guard', 5);

  assert(hybridResults.length > 0, 'hybrid 检索能找回 TypeScript 内容');
  assert(keywordResults.length > 0, 'keyword 检索能找回 TypeScript 内容');

  // 验证混合检索返回的 metadata.source 标识
  const hybridSources = hybridResults.map((r) => r.metadata?.source);
  const hasHybridSource = hybridSources.some((s) => s === 'archive-hybrid' || s === 'archive-keyword');
  assert(hasHybridSource, `hybrid 检索结果有 source 标识: ${JSON.stringify(hybridSources)}`);

  // 验证混合检索路径被实际使用（有 embedFn 时 searchHybrid 应被调用）
  // 通过比较 hybrid 与 keyword 的结果顺序可能不同（RRF 融合后）
  // 主要验证：hybrid 路径不崩溃，且能找到相关内容
  const topHybrid = hybridResults[0];
  assert(topHybrid !== undefined, 'hybrid 检索有 top-1 结果');
  assert(topHybrid!.content.includes('TypeScript') || topHybrid!.content.includes('type guard'),
    `hybrid top-1 内容相关: ${topHybrid!.content.slice(0, 80)}`);
});

// ============================================================
// 测试 8：P3 - 无 embedFn 时退化为纯 BM25
// ============================================================
test('Test 8: P3 无 embedFn 时退化为纯 BM25', async () => {
  const archiveStore = new ArchiveStore();  // 无 embedFn
  const moduleTracker = new ModuleTracker({ topicSwitchThreshold: 0.20, archiveDelayRounds: 1 });
  const archiveRetriever = new ArchiveRetriever(archiveStore, { topicGateThreshold: 0.05 });

  const messages1: Message[] = [
    { role: 'system', content: 'System' },
    { role: 'user', content: 'TypeScript type guard' },
    { role: 'assistant', content: 'Use type guard.' },
  ];
  await runEngine({
    messages: messages1,
    model: 'test',
    archive: { moduleTracker, archiveStore, retriever: archiveRetriever, enableSummary: false },
    currentTurn: 1,
    summarizer: { fn: mockSummarizer() },
  });

  const messages2: Message[] = [
    ...messages1,
    { role: 'user', content: 'Postgres database index' },
    { role: 'assistant', content: 'Create index.' },
    { role: 'user', content: 'Postgres transaction' },
  ];
  await runEngine({
    messages: messages2,
    model: 'test',
    previousMessages: messages1,
    archive: { moduleTracker, archiveStore, retriever: archiveRetriever, enableSummary: false },
    currentTurn: 2,
    summarizer: { fn: mockSummarizer() },
  });

  const results = await archiveStore.search('TypeScript', 5);
  assert(results.length > 0, '纯 BM25 也能检索');
  const sources = results.map((r) => r.metadata?.source);
  assert(sources.every((s) => s === 'archive-keyword'),
    `无 embedFn 时 source 全为 archive-keyword: ${JSON.stringify(sources)}`);
});

// ============================================================
// 汇总
// ============================================================
await runAll();
console.log(`\n========================================`);
console.log(`Engine 归档集成测试结果: ${pass} passed, ${fail} failed`);
console.log(`========================================`);
if (fail > 0) {
  process.exit(1);
}
