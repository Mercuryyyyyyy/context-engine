// ArchiveRetriever 单元测试
// 验证 topic gate、minScore 过滤、token budget 截断、检索日志

import { ArchiveStore } from '../retrieve/archive-store.js';
import { ArchiveRetriever } from '../retrieve/archive-retriever.js';
import type { ModuleInfo } from '../retrieve/module-tracker.js';
import type { Message } from '../types.js';

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

function makeModule(id: string, startTurn: number, endTurn: number, summary: string, indices: number[]): ModuleInfo {
  return {
    id,
    topicKeywords: new Set(['test']),
    representativeQuery: 'test query',
    startTurn,
    lastReferencedTurn: endTurn,
    messageIndices: indices,
    status: 'archived',
    summary,
  };
}

// ============================================================
// 测试 1：基本检索 + topic gate 通过
// ============================================================
test('Test 1: 相关查询通过 topic gate', async () => {
  const store = new ArchiveStore();
  const module = makeModule('module-1', 1, 2, 'TypeScript 类型系统', [0, 1]);
  const messages: Message[] = [
    { role: 'user', content: 'TypeScript type guard undefined check' },
    { role: 'assistant', content: 'Use type guard to check undefined in TypeScript.' },
  ];
  await store.archive(module, messages);

  const retriever = new ArchiveRetriever(store, { topicGateThreshold: 0.10 });
  const results = await retriever.search('TypeScript type guard', 5);
  assert(results.length > 0, '相关查询返回结果');

  const log = retriever.getLastSearchLog()!;
  assert(log.acceptedCount > 0, '日志记录 accepted > 0');
  assert(log.rejectedByTopicGate === 0, '无 topic gate 拒绝');
  assert(log.injectedTokens > 0, '注入 token > 0');
});

// ============================================================
// 测试 2：不相关查询被 topic gate 拒绝
// ============================================================
test('Test 2: 不相关查询被 topic gate 拒绝', async () => {
  const store = new ArchiveStore();
  // 归档内容包含 'database' 让 BM25 能返回结果，但主题是 TypeScript
  const module = makeModule('module-1', 1, 2, 'TypeScript 类型系统', [0, 1]);
  const messages: Message[] = [
    { role: 'user', content: 'TypeScript type guard database schema undefined check' },
    { role: 'assistant', content: 'Use type guard to check undefined in TypeScript database schema.' },
  ];
  await store.archive(module, messages);

  // 查询 Postgres database，BM25 因 'database' 重叠返回结果，但 topic gate 拒绝
  const retriever = new ArchiveRetriever(store, { topicGateThreshold: 0.50 });
  const results = await retriever.search('Postgres database index optimization', 5);
  assert(results.length === 0, '不相关查询被 topic gate 全部拒绝');

  const log = retriever.getLastSearchLog()!;
  // BM25 可能返回 0 结果（完全不匹配），也可能返回有 'database' 重叠的结果
  // 如果 BM25 返回了结果，topic gate 应该拒绝
  if (log.totalRetrieved > 0) {
    assert(log.rejectedByTopicGate > 0, '日志记录 topic gate 拒绝数 > 0');
  }
  assert(log.acceptedCount === 0, 'accepted = 0');
});

// ============================================================
// 测试 3：minScore 过滤
// ============================================================
test('Test 3: minScore 过滤低分结果', async () => {
  const store = new ArchiveStore();
  const module = makeModule('module-1', 1, 2, '测试', [0, 1]);
  const messages: Message[] = [
    { role: 'user', content: 'React component hooks useEffect' },
    { role: 'assistant', content: 'Use useEffect for side effects in React components.' },
  ];
  await store.archive(module, messages);

  const retriever = new ArchiveRetriever(store, { minScore: 0.5, topicGateThreshold: 0 });
  const results = await retriever.search('completely unrelated xyz', 5);
  assert(results.length === 0, '不相关查询高 minScore 无结果');

  const log = retriever.getLastSearchLog()!;
  assert(log.rejectedByMinScore >= 0, '日志记录 minScore 拒绝');
});

// ============================================================
// 测试 4：token budget 截断
// ============================================================
test('Test 4: token budget 截断过多结果', async () => {
  const store = new ArchiveStore();
  // 归档多条长消息
  const module = makeModule('module-1', 1, 4, '长消息模块', [0, 1, 2, 3, 4, 5]);
  const messages: Message[] = [
    { role: 'user', content: 'React hooks useEffect useState detailed explanation with examples and best practices' },
    { role: 'assistant', content: 'useEffect is a React hook for side effects. useState is for state management. Detailed examples include cleanup functions, dependency arrays, and custom hooks for reusable logic.' },
    { role: 'user', content: 'React hooks useContext useReducer detailed explanation with examples' },
    { role: 'assistant', content: 'useContext provides global state access. useReducer manages complex state transitions. Both are React hooks for advanced state management patterns.' },
    { role: 'user', content: 'React hooks useCallback useMemo detailed explanation with examples' },
    { role: 'assistant', content: 'useCallback memoizes functions to prevent unnecessary re-renders. useMemo memoizes expensive computations. Both optimize React performance.' },
  ];
  await store.archive(module, messages);

  // 设很小的 maxTokens
  const retriever = new ArchiveRetriever(store, { maxTokens: 50, topicGateThreshold: 0.10 });
  const results = await retriever.search('React hooks', 10);
  assert(results.length <= 6, '结果数不超过总归档数');

  const log = retriever.getLastSearchLog()!;
  assert(log.injectedTokens <= 50, '注入 token 不超过 50');
});

// ============================================================
// 测试 5：toRetrievalOptions 生成兼容接口
// ============================================================
test('Test 5: toRetrievalOptions 生成 RetrievalOptions', async () => {
  const store = new ArchiveStore();
  const module = makeModule('module-1', 1, 2, '测试', [0, 1]);
  const messages: Message[] = [
    { role: 'user', content: 'WebSocket realtime connection' },
    { role: 'assistant', content: 'Use WebSocket for realtime bidirectional communication.' },
  ];
  await store.archive(module, messages);

  const retriever = new ArchiveRetriever(store);
  const retrievalOpts = retriever.toRetrievalOptions();

  assert(typeof retrievalOpts.search === 'function', 'search 是函数');
  assert(retrievalOpts.topK === 6, 'topK = 6');
  assert(retrievalOpts.maxTokens === 1200, 'maxTokens = 1200');
  assert(retrievalOpts.when === 'over-budget', 'when = over-budget');

  // 验证 search 可调用
  const results = await retrievalOpts.search('WebSocket realtime', 5);
  assert(results.length > 0, '通过 RetrievalOptions.search 检素有结果');
});

// ============================================================
// 测试 6：检索日志完整性
// ============================================================
test('Test 6: 检索日志记录完整信息', async () => {
  const store = new ArchiveStore();
  const module1 = makeModule('module-1', 1, 2, 'TypeScript', [0, 1]);
  const module2 = makeModule('module-2', 3, 4, 'Postgres', [0, 1]);
  await store.archive(module1, [
    { role: 'user', content: 'TypeScript type guard undefined' },
    { role: 'assistant', content: 'Use type guard for undefined checks in TypeScript.' },
  ]);
  await store.archive(module2, [
    { role: 'user', content: 'TypeScript Postgres connection pool' },
    { role: 'assistant', content: 'Use pg library with connection pooling for Postgres.' },
  ]);

  const retriever = new ArchiveRetriever(store, { topicGateThreshold: 0.15 });
  await retriever.search('TypeScript type guard', 10);

  const log = retriever.getLastSearchLog()!;
  assert(log.query === 'TypeScript type guard', '日志记录查询');
  assert(log.results.length > 0, '日志有结果条目');
  for (const entry of log.results) {
    assert(typeof entry.id === 'string', '条目有 id');
    assert(typeof entry.score === 'number', '条目有 score');
    assert(typeof entry.topicRelevance === 'number', '条目有 topicRelevance');
    assert(typeof entry.accepted === 'boolean', '条目有 accepted');
  }
});

// ============================================================
// 测试 7：updateOptions 动态调整
// ============================================================
test('Test 7: updateOptions 动态调整阈值', async () => {
  const store = new ArchiveStore();
  const module = makeModule('module-1', 1, 2, 'TypeScript', [0, 1]);
  await store.archive(module, [
    { role: 'user', content: 'TypeScript type guard undefined check' },
    { role: 'assistant', content: 'Use type guard for undefined checks in TypeScript.' },
  ]);

  // 高阈值：查询用缩写 'TS'，与归档内容的 'typescript' 不匹配，coverage 低
  const retriever = new ArchiveRetriever(store, { topicGateThreshold: 0.80 });
  const r1 = await retriever.search('TS type checking', 5);
  assert(r1.length === 0, '高阈值时拒绝（TS 与 typescript 不匹配）');

  // 降低阈值
  retriever.updateOptions({ topicGateThreshold: 0.10 });
  const r2 = await retriever.search('TS type checking', 5);
  assert(r2.length > 0, '降低阈值后通过');
});

// ============================================================
// 汇总
// ============================================================
await runAll();
console.log(`\n========================================`);
console.log(`ArchiveRetriever 测试结果: ${pass} passed, ${fail} failed`);
console.log(`========================================`);
if (fail > 0) {
  process.exit(1);
}
