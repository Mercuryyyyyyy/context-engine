// Engine 归档集成测试
// 验证 runEngine + ModuleTracker + ArchiveStore + ArchiveRetriever 完整流程
// 使用 mock summarizer，不依赖真实 LLM

import {
  runEngine,
  countMessagesTokens,
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
// 测试 6：归档摘要消息格式正确
// ============================================================
test('Test 5: 稳定前缀内的模块不归档', async () => {
  const moduleTracker = new ModuleTracker({ topicSwitchThreshold: 0.20, archiveDelayRounds: 1 });
  const archiveStore = new ArchiveStore();
  const archiveRetriever = new ArchiveRetriever(archiveStore, { topicGateThreshold: 0.05 });

  const firstMessages: Message[] = [
    { role: 'user', content: 'TypeScript 类型守卫问题' },
    { role: 'assistant', content: '请使用 if 检查 undefined。' },
  ];
  await runEngine({
    messages: firstMessages,
    baselineMessages: firstMessages,
    model: 'test',
    budget: 1,
    archive: { moduleTracker, archiveStore, retriever: archiveRetriever, enableSummary: false },
    currentTurn: 1,
  });

  const nextMessages: Message[] = [
    ...firstMessages,
    { role: 'user', content: 'Postgres 索引优化问题' },
    { role: 'assistant', content: '请使用复合索引。' },
  ];
  const result = await runEngine({
    messages: nextMessages,
    baselineMessages: nextMessages,
    model: 'test',
    previousMessages: firstMessages,
    stablePrefixLength: firstMessages.length,
    compaction: { highWatermark: 1, lowWatermark: 0 },
    archive: { moduleTracker, archiveStore, retriever: archiveRetriever, enableSummary: false },
    currentTurn: 2,
  });

  assert(result.stats.archivedModules === 0, '稳定前缀中的 module-1 不归档');
  assert(!result.messages.some((m) => m.name === 'context-archive'), '稳定前缀未插入归档摘要');
  assert(archiveStore.moduleCount === 0, '稳定前缀模块未写入 ArchiveStore');
});

// ============================================================
// 测试 6：稳定前缀保护与 epoch rotation
// ============================================================
test('Test 6: 稳定前缀保护与 epoch rotation', async () => {
  const stablePrefix: Message[] = [
    { role: 'system', content: 'stable system' },
    { role: 'user', content: 'stable question 1' },
    { role: 'assistant', content: 'stable answer 1' },
    { role: 'user', content: 'stable question 2' },
    { role: 'assistant', content: 'stable answer 2' },
  ];
  const suffix: Message[] = [];
  for (let i = 0; i < 5; i++) {
    suffix.push(
      { role: 'user', content: `new epoch question ${i}` },
      { role: 'assistant', content: `new epoch answer ${i}` },
    );
  }
  const currentQuery: Message = { role: 'user', content: 'current epoch query' };
  const messages = [...stablePrefix, ...suffix, currentQuery];
  const totalTokens = countMessagesTokens(messages);

  // total > highWatermark，但仍在 rotation threshold 内：只允许处理稳定前缀之后的消息。
  const protectedResult = await runEngine({
    messages,
    model: 'test',
    budget: totalTokens,
    previousMessages: stablePrefix,
    stablePrefixLength: stablePrefix.length,
    compaction: {
      highWatermark: Math.max(1, totalTokens - 1),
      lowWatermark: 0,
    },
    recentKeep: 1,
  });
  assert(
    JSON.stringify(protectedResult.messages.slice(0, stablePrefix.length))
      === JSON.stringify(stablePrefix),
    'rotation threshold 内稳定前缀逐字保持不变',
  );
  assert(
    protectedResult.stats.strategies.includes('clear-middle'),
    'rotation threshold 内仍可压缩稳定前缀之后的新消息',
  );

  // 即使 total 超过 rotation threshold，稳定轮数未达到门槛时仍保护旧 epoch。
  const delayedRotationResult = await runEngine({
    messages,
    model: 'test',
    budget: totalTokens,
    previousMessages: stablePrefix,
    stablePrefixLength: stablePrefix.length,
    stablePrefixTurns: 0,
    compaction: {
      highWatermark: Math.max(1, Math.floor(totalTokens * 0.5)),
      lowWatermark: 0,
      rotationAfterRounds: 6,
    },
    recentKeep: 1,
  });
  assert(
    JSON.stringify(delayedRotationResult.messages.slice(0, stablePrefix.length))
      === JSON.stringify(stablePrefix),
    '稳定轮数未达到门槛时，即使超过 rotation threshold 也保持前缀',
  );

  // total 超过 highWatermark * 1.5 且稳定轮数达到门槛：允许改写旧 epoch。
  const rotatedResult = await runEngine({
    messages,
    model: 'test',
    budget: totalTokens,
    previousMessages: stablePrefix,
    stablePrefixLength: stablePrefix.length,
    stablePrefixTurns: 6,
    compaction: {
      highWatermark: Math.max(1, Math.floor(totalTokens * 0.5)),
      lowWatermark: 0,
      rotationAfterRounds: 6,
    },
    recentKeep: 1,
  });
  const rotatedPrefixChanged = rotatedResult.messages
    .slice(0, stablePrefix.length)
    .some((message, index) => JSON.stringify(message) !== JSON.stringify(stablePrefix[index]));
  assert(rotatedPrefixChanged, '超过 rotation threshold 后允许改写旧 epoch');
  assert(
    rotatedResult.stats.strategies.includes('clear-middle'),
    '超过 rotation threshold 后触发压缩',
  );
});

// ============================================================
// 测试 7：稳定前缀之后的模块可以延迟归档
// ============================================================
test('Test 7: 稳定前缀之后的模块可以延迟归档', async () => {
  const moduleTracker = new ModuleTracker({ topicSwitchThreshold: 0.20, archiveDelayRounds: 1 });
  const archiveStore = new ArchiveStore();
  const archiveRetriever = new ArchiveRetriever(archiveStore, { topicGateThreshold: 0.05 });

  const firstMessages: Message[] = [
    { role: 'user', content: 'TypeScript 类型守卫问题' },
    { role: 'assistant', content: '请使用 if 检查 undefined。' },
  ];
  await runEngine({
    messages: firstMessages,
    model: 'test',
    budget: 1,
    archive: { moduleTracker, archiveStore, retriever: archiveRetriever, enableSummary: false },
    currentTurn: 1,
  });

  const secondMessages: Message[] = [
    ...firstMessages,
    { role: 'user', content: 'Postgres 索引优化问题' },
    { role: 'assistant', content: '请使用复合索引。' },
  ];
  await runEngine({
    messages: secondMessages,
    model: 'test',
    previousMessages: firstMessages,
    stablePrefixLength: firstMessages.length,
    budget: 1,
    archive: { moduleTracker, archiveStore, retriever: archiveRetriever, enableSummary: false },
    currentTurn: 2,
  });

  const thirdMessages: Message[] = [
    ...secondMessages,
    { role: 'user', content: 'React hooks 状态管理问题' },
    { role: 'assistant', content: '请拆分 useState 和 useEffect。' },
  ];
  const result = await runEngine({
    messages: thirdMessages,
    model: 'test',
    previousMessages: secondMessages,
    stablePrefixLength: firstMessages.length,
    budget: 1,
    archive: { moduleTracker, archiveStore, retriever: archiveRetriever, enableSummary: false },
    currentTurn: 3,
  });

  assert(result.stats.archivedModules === 1, '稳定前缀之后的完整模块可以归档');
  assert(archiveStore.moduleCount === 1, '延迟归档模块写入 ArchiveStore');
  assert(result.messages.some((message) => message.name === 'context-archive'), '生成归档摘要消息');
});

// ============================================================
// 测试 8：归档摘要消息格式正确
// ============================================================
test('Test 8: 归档摘要消息格式', async () => {
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
// 测试 9：多模块连续归档
// ============================================================
test('Test 9: 多模块连续归档', async () => {
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
// 测试 10：P3 - HybridSearcher（带 embedFn）vs 纯 BM25
// 验证：有 embedFn 时 ArchiveStore 走混合检索路径
// 使用 mock embedFn 模拟向量检索（基于关键词重合度的伪向量）
// ============================================================
test('Test 10: P3 HybridSearcher 混合检索路径', async () => {
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
// 测试 11：P3 - 无 embedFn 时退化为纯 BM25
// ============================================================
test('Test 11: P3 无 embedFn 时退化为纯 BM25', async () => {
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
// 测试 12：rotation 经济性门槛（rotationMinSavingsRatio）
// 改写缓存前缀会付出一次性 miss 成本（首个改写点之后全部降级），
// 收益是此后每轮前缀缩小 Δ（按 hit 价计）。门槛不达标时应降级为保护模式。
// ============================================================
test('Test 12: rotation 经济性门槛', async () => {
  // 用较长内容保证"清空中间消息"确实省 token（占位符远小于原文）
  const pad = (seed: string): string => `${seed} `.repeat(80);
  const stablePrefix: Message[] = [
    { role: 'system', content: pad('system') },
    { role: 'user', content: pad('prefixq1') },
    { role: 'assistant', content: pad('prefixa1') },
    { role: 'user', content: pad('prefixq2') },
    { role: 'assistant', content: pad('prefixa2') },
  ];
  const suffix: Message[] = [];
  for (let i = 0; i < 5; i++) {
    suffix.push(
      { role: 'user', content: pad(`suffixq${i}`) },
      { role: 'assistant', content: pad(`suffixa${i}`) },
    );
  }
  const currentQuery: Message = { role: 'user', content: 'current query about rotation' };
  const messages = [...stablePrefix, ...suffix, currentQuery];
  const totalTokens = countMessagesTokens(messages);

  const base = {
    messages,
    model: 'test',
    budget: totalTokens,
    previousMessages: stablePrefix,
    stablePrefixLength: stablePrefix.length,
    stablePrefixTurns: 6,
    recentKeep: 1,
    compaction: {
      highWatermark: Math.max(1, Math.floor(totalTokens * 0.5)),
      lowWatermark: 0,
      rotationAfterRounds: 6,
    },
  };

  // (1) 未配置门槛：保持既有行为，允许 rotation
  const noGate = await runEngine({ ...base });
  assert(noGate.stats.strategies.includes('clear-middle'),
    '未配置 rotationMinSavingsRatio 时按既有行为 rotation');

  // (2) 门槛宽松（0.2）：预计节省 Δ 能覆盖 20% 改写成本 → 允许 rotation
  const loose = await runEngine({
    ...base,
    compaction: { ...base.compaction, rotationMinSavingsRatio: 0.2 },
  });
  assert(loose.stats.strategies.includes('clear-middle'),
    '门槛宽松时允许 rotation（clear-middle 触发）');

  // (3) 门槛严格（5.0）：Δ 远不足以覆盖一次性 miss 成本 → 降级为保护模式
  const strict = await runEngine({
    ...base,
    compaction: { ...base.compaction, rotationMinSavingsRatio: 5 },
  });
  assert(strict.stats.strategies.includes('rotation-deferred-economy'),
    '门槛不达标时标记 rotation-deferred-economy');
  assert(
    !strict.messages.slice(0, stablePrefix.length).some((m) =>
      typeof m.content === 'string' && m.content.startsWith('[cleared:')),
    '门槛不达标时稳定前缀内无任何消息被清空',
  );
  assert(
    JSON.stringify(strict.messages.slice(0, stablePrefix.length)) === JSON.stringify(stablePrefix),
    '门槛不达标时稳定前缀逐字保持（含 losslessNormalize 也不改写前缀）',
  );
  // 降级为保护模式后，稳定前缀之后的中间消息仍可压缩（不浪费预算）
  assert(strict.stats.strategies.includes('clear-middle'),
    '降级为保护模式后仍可压缩稳定前缀之后的消息');
});

// ============================================================
// Test 13: 硬约束兜底 rotationForceTokens
// ============================================================
test('Test 13: 上下文逼近窗口上限时忽略经济门槛强制 rotation', async () => {
  const pad = (seed: string): string => `${seed} `.repeat(80);
  const stablePrefix: Message[] = [
    { role: 'system', content: pad('system') },
    { role: 'user', content: pad('prefixq1') },
    { role: 'assistant', content: pad('prefixa1') },
    { role: 'user', content: pad('prefixq2') },
    { role: 'assistant', content: pad('prefixa2') },
  ];
  const suffix: Message[] = [];
  for (let i = 0; i < 5; i++) {
    suffix.push(
      { role: 'user', content: pad(`suffixq${i}`) },
      { role: 'assistant', content: pad(`suffixa${i}`) },
    );
  }
  const currentQuery: Message = { role: 'user', content: 'current query about rotation' };
  const messages = [...stablePrefix, ...suffix, currentQuery];
  const totalTokens = countMessagesTokens(messages);

  const base = {
    messages,
    model: 'test',
    budget: totalTokens,
    stablePrefixLength: stablePrefix.length,
    stablePrefixTurns: 6,
    recentKeep: 1,
    compaction: {
      highWatermark: Math.max(1, Math.floor(totalTokens * 0.5)),
      lowWatermark: 0,
      rotationAfterRounds: 6,
      // 严格门槛：正常情况下 Δ 远不足以覆盖改写成本 → 降级为保护模式
      rotationMinSavingsRatio: 5,
    },
  };
  const prefixCleared = (msgs: Message[]): boolean =>
    msgs.slice(0, stablePrefix.length).some((m) =>
      typeof m.content === 'string' && m.content.startsWith('[cleared:'));

  // (1) 未达硬约束（forceTokens > total）：门槛照常生效，前缀保持
  const underLimit = await runEngine({
    ...base,
    compaction: { ...base.compaction, rotationForceTokens: totalTokens + 1000 },
  });
  assert(underLimit.stats.strategies.includes('rotation-deferred-economy'),
    '未达硬约束时仍走经济门槛（标记 rotation-deferred-economy）');
  assert(!underLimit.stats.strategies.includes('rotation-forced-limit'),
    '未达硬约束时不标记 rotation-forced-limit');
  assert(!prefixCleared(underLimit.messages),
    '未达硬约束时稳定前缀保持原样');

  // (2) 达到硬约束（forceTokens ≤ total，但未达 1.5 倍紧急线）：忽略门槛，强制改写前缀
  // 取 0.8×total：既满足 rotationForced，又不触发 rotationEmergency（1.5×0.8=1.2 > 1）。
  const overLimit = await runEngine({
    ...base,
    compaction: { ...base.compaction, rotationForceTokens: Math.floor(totalTokens * 0.8) },
  });
  assert(overLimit.stats.strategies.includes('rotation-forced-limit'),
    '达到硬约束时标记 rotation-forced-limit');
  assert(!overLimit.stats.strategies.includes('rotation-deferred-economy'),
    '强制 rotation 时不再标记 rotation-deferred-economy');
  assert(prefixCleared(overLimit.messages),
    '达到硬约束时稳定前缀被改写（避免上下文溢出优先于缓存经济性）');

  // (3) 硬约束不解除 rotationAfterRounds：新 epoch 刚建立时（稳定轮数 0）仍受保护。
  // 这是防止"每轮都强制 rotation 导致缓存持续断裂"的关键约束（12 轮实测反例）。
  const youngEpoch = await runEngine({
    ...base,
    stablePrefixTurns: 0,
    compaction: { ...base.compaction, rotationForceTokens: Math.floor(totalTokens * 0.8) },
  });
  assert(!youngEpoch.stats.strategies.includes('rotation-forced-limit'),
    '稳定轮数不足时不强制 rotation（让新 epoch 重建缓存）');
  assert(!prefixCleared(youngEpoch.messages),
    '稳定轮数不足时即使达到硬约束，稳定前缀仍保持原样');

  // (4) 关闭硬约束（0）时即使上下文很大也不强制
  const noForce = await runEngine({
    ...base,
    compaction: { ...base.compaction, rotationForceTokens: 0 },
  });
  assert(!noForce.stats.strategies.includes('rotation-forced-limit'),
    'rotationForceTokens=0 时关闭硬约束（既有行为）');
  assert(noForce.stats.strategies.includes('rotation-deferred-economy'),
    'rotationForceTokens=0 时经济门槛仍生效');

  // (5) 紧急通道：超过硬约束 1.5 倍时，即使稳定轮数为 0 也立即强制 rotation。
  // 对应"稀疏化等待期间上下文持续增长、逼近真实溢出"的场景。
  const emergency = await runEngine({
    ...base,
    stablePrefixTurns: 0,
    compaction: { ...base.compaction, rotationForceTokens: Math.floor(totalTokens * 0.3) },
  });
  assert(emergency.stats.strategies.includes('rotation-emergency'),
    '超过硬约束 1.5 倍时标记 rotation-emergency');
  assert(prefixCleared(emergency.messages),
    '紧急通道下即使稳定轮数为 0 也立即改写前缀（可用性优先于缓存）');
});

// ============================================================
// Test 14: 硬约束阈值由模型窗口自动推导
// ============================================================
test('Test 14: contextWindowTokens 自动推导 rotationForceTokens', async () => {
  const pad = (seed: string): string => `${seed} `.repeat(80);
  const stablePrefix: Message[] = [
    { role: 'system', content: pad('system') },
    { role: 'user', content: pad('prefixq1') },
    { role: 'assistant', content: pad('prefixa1') },
    { role: 'user', content: pad('prefixq2') },
    { role: 'assistant', content: pad('prefixa2') },
  ];
  const suffix: Message[] = [];
  for (let i = 0; i < 5; i++) {
    suffix.push(
      { role: 'user', content: pad(`suffixq${i}`) },
      { role: 'assistant', content: pad(`suffixa${i}`) },
    );
  }
  const currentQuery: Message = { role: 'user', content: 'current query about rotation' };
  const messages = [...stablePrefix, ...suffix, currentQuery];
  const totalTokens = countMessagesTokens(messages);

  const base = {
    messages,
    model: 'test',
    budget: totalTokens,
    stablePrefixLength: stablePrefix.length,
    stablePrefixTurns: 6,
    recentKeep: 1,
    compaction: {
      highWatermark: Math.max(1, Math.floor(totalTokens * 0.5)),
      lowWatermark: 0,
      rotationAfterRounds: 6,
      rotationMinSavingsRatio: 5,
    },
  };
  const prefixCleared = (msgs: Message[]): boolean =>
    msgs.slice(0, stablePrefix.length).some((m) =>
      typeof m.content === 'string' && m.content.startsWith('[cleared:'));

  // (1) 无窗口、无显式阈值：硬约束关闭，经济门槛照常生效
  const noWindow = await runEngine(base);
  assert(!noWindow.stats.strategies.includes('rotation-forced-limit'),
    '未提供 contextWindowTokens 且无显式阈值时硬约束关闭');

  // (2) 窗口较大：推导出的阈值高于 total → 不触发
  const bigWindow = await runEngine({
    ...base,
    compaction: { ...base.compaction, contextWindowTokens: totalTokens * 10 },
  });
  assert(!bigWindow.stats.strategies.includes('rotation-forced-limit'),
    '窗口足够大时自动推导的阈值不会触发强制 rotation');

  // (3) 窗口接近：推导阈值 = (窗口 − 预留) × 0.6 < total → 触发强制 rotation
  // 取窗口 = 1.2 × total，预留 0 → 推导阈值 = 0.72 × total（紧急线 1.08 × total 未达）
  const tightWindow = await runEngine({
    ...base,
    compaction: { ...base.compaction, contextWindowTokens: Math.floor(totalTokens * 1.2) },
  });
  assert(tightWindow.stats.strategies.includes('rotation-forced-limit'),
    '窗口受限时自动推导的阈值会触发强制 rotation');
  assert(prefixCleared(tightWindow.messages),
    '自动推导触发时稳定前缀被改写');

  // (4) 预留输出参与推导：同一窗口下，扣除预留后阈值下降从而触发。
  // 窗口取 1.8×total：无预留时阈值 = 1.08×total > total（不触发）；
  // 扣除 0.3×total 预留后阈值 = 0.9×total < total（触发），且未达 1.5 倍紧急线。
  const windowOnly = Math.floor(totalTokens * 1.8);
  const noReserve = await runEngine({
    ...base,
    compaction: { ...base.compaction, contextWindowTokens: windowOnly },
  });
  assert(!noReserve.stats.strategies.includes('rotation-forced-limit'),
    '同一窗口下未扣除预留时阈值较高，不触发强制 rotation');

  const withReserve = await runEngine({
    ...base,
    compaction: {
      ...base.compaction,
      contextWindowTokens: windowOnly,
      reserveOutputTokens: Math.floor(totalTokens * 0.3),
    },
  });
  assert(withReserve.stats.strategies.includes('rotation-forced-limit'),
    '扣除预留输出后阈值下降，触发强制 rotation');

  // (5) 显式 rotationForceTokens 优先于自动推导：显式设为不触发，即便窗口很紧
  const explicitWins = await runEngine({
    ...base,
    compaction: {
      ...base.compaction,
      contextWindowTokens: Math.floor(totalTokens * 1.2),
      rotationForceTokens: totalTokens + 1000,
    },
  });
  assert(!explicitWins.stats.strategies.includes('rotation-forced-limit'),
    '显式 rotationForceTokens 优先于自动推导');
  assert(!prefixCleared(explicitWins.messages),
    '显式阈值未触发时稳定前缀保持原样');
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
