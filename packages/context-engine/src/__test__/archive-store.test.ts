// ArchiveStore 单元测试
// 验证归档存储、关键词检索、模块过滤

import { ArchiveStore } from '../retrieve/archive-store.js';
import { ModuleTracker, type ModuleInfo } from '../retrieve/module-tracker.js';
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

// ============================================================
// 辅助：构造模块信息
// ============================================================
function makeModule(id: string, startTurn: number, endTurn: number, summary: string): ModuleInfo {
  return {
    id,
    topicKeywords: new Set(['test']),
    representativeQuery: 'test query',
    startTurn,
    lastReferencedTurn: endTurn,
    messageIndices: [0, 1],  // 会在 archive 时被覆盖
    status: 'archived',
    summary,
  };
}

// ============================================================
// 测试 1：基本归档与检索
// ============================================================
test('Test 1: 基本归档与关键词检索', async () => {
  const store = new ArchiveStore();
  const module = makeModule('module-1', 1, 2, 'TypeScript 类型系统');
  // 修正 messageIndices 为实际消息索引
  module.messageIndices = [0, 1];
  const messages: Message[] = [
    { role: 'user', content: '如何用 TypeScript 处理 undefined 类型？' },
    { role: 'assistant', content: '使用类型守卫或可选链操作符处理 undefined。' },
  ];

  await store.archive(module, messages);
  assert(store.size === 2, '归档后 2 条消息');
  assert(store.moduleCount === 1, '归档后 1 个模块');

  const results = store.searchKeyword('TypeScript undefined 类型');
  assert(results.length > 0, '检索 TypeScript 类型有结果');
  assert(results[0]!.metadata?.moduleId === 'module-1', '结果属于 module-1');
  assert(results[0]!.metadata?.moduleSummary === 'TypeScript 类型系统', '包含模块摘要');
});

// ============================================================
// 测试 2：多模块归档与跨模块检索
// ============================================================
test('Test 2: 多模块归档与跨模块检索', async () => {
  const store = new ArchiveStore();

  // 模块1：TypeScript 类型
  const module1 = makeModule('module-1', 1, 2, 'TypeScript 类型系统');
  module1.messageIndices = [0, 1];
  const messages1: Message[] = [
    { role: 'user', content: 'TypeScript type guard undefined check' },
    { role: 'assistant', content: 'Use type guard to check undefined in TypeScript.' },
  ];

  // 模块2：Postgres 数据库
  const module2 = makeModule('module-2', 3, 4, 'Postgres 数据库优化');
  module2.messageIndices = [0, 1];
  const messages2: Message[] = [
    { role: 'user', content: 'Postgres index optimization for query performance' },
    { role: 'assistant', content: 'Create B-tree index on frequently queried columns.' },
  ];

  await store.archive(module1, messages1);
  await store.archive(module2, messages2);

  assert(store.size === 4, '归档后 4 条消息');
  assert(store.moduleCount === 2, '归档后 2 个模块');

  // 检索 TypeScript 相关
  const tsResults = store.searchKeyword('TypeScript type guard');
  assert(tsResults.length > 0, 'TypeScript 检素有结果');
  assert(tsResults.every((r) => r.metadata?.moduleId === 'module-1'), 'TypeScript 结果都在 module-1');

  // 检索 Postgres 相关
  const pgResults = store.searchKeyword('Postgres index optimization');
  assert(pgResults.length > 0, 'Postgres 检素有结果');
  assert(pgResults.every((r) => r.metadata?.moduleId === 'module-2'), 'Postgres 结果都在 module-2');
});

// ============================================================
// 测试 3：模块过滤检索
// ============================================================
test('Test 3: 模块过滤检索', async () => {
  const store = new ArchiveStore();

  const module1 = makeModule('module-1', 1, 2, '认证模块');
  module1.messageIndices = [0, 1];
  const messages1: Message[] = [
    { role: 'user', content: 'login authentication password' },
    { role: 'assistant', content: 'Use bcrypt for password hashing in login.' },
  ];

  const module2 = makeModule('module-2', 3, 4, '缓存模块');
  module2.messageIndices = [0, 1];
  const messages2: Message[] = [
    { role: 'user', content: 'cache redis login session storage' },  // 注意：也有 login
    { role: 'assistant', content: 'Store login session in Redis with TTL.' },
  ];

  await store.archive(module1, messages1);
  await store.archive(module2, messages2);

  // 不过滤：检索 login 应返回两个模块的结果
  const allResults = store.searchKeyword('login');
  const allModuleIds = new Set(allResults.map((r) => r.metadata?.moduleId));
  assert(allModuleIds.size === 2, '不过滤时返回两个模块的结果');

  // 过滤：只搜 module-1
  const filteredResults = store.searchKeyword('login', { moduleIds: ['module-1'] });
  assert(filteredResults.length > 0, '过滤后仍有结果');
  assert(filteredResults.every((r) => r.metadata?.moduleId === 'module-1'), '过滤后只返回 module-1');
});

// ============================================================
// 测试 4：minScore 过滤
// ============================================================
test('Test 4: minScore 过滤低质量结果', async () => {
  const store = new ArchiveStore();
  const module = makeModule('module-1', 1, 2, '测试模块');
  module.messageIndices = [0, 1];
  const messages: Message[] = [
    { role: 'user', content: 'React component hooks useEffect useState' },
    { role: 'assistant', content: 'Use useEffect for side effects and useState for state.' },
  ];

  await store.archive(module, messages);

  // 高 minScore：可能无结果
  const highScoreResults = store.searchKeyword('completely unrelated topic xyz', { minScore: 0.5 });
  assert(highScoreResults.length === 0, '不相关查询高 minScore 无结果');

  // 低 minScore：有结果
  const lowScoreResults = store.searchKeyword('React hooks', { minScore: 0 });
  assert(lowScoreResults.length > 0, '相关查询低 minScore 有结果');
});

// ============================================================
// 测试 5：getModuleMessages
// ============================================================
test('Test 5: getModuleMessages 获取模块所有消息', async () => {
  const store = new ArchiveStore();
  const module = makeModule('module-1', 1, 3, '完整模块');
  module.messageIndices = [0, 1, 2, 3];
  const messages: Message[] = [
    { role: 'user', content: '问题一' },
    { role: 'assistant', content: '回答一' },
    { role: 'user', content: '问题二' },
    { role: 'assistant', content: '回答二' },
  ];

  await store.archive(module, messages);

  const moduleMessages = store.getModuleMessages('module-1');
  assert(moduleMessages.length === 4, '模块有 4 条消息');
  assert(moduleMessages[0]!.role === 'user', '第一条是 user');
  assert(moduleMessages[1]!.role === 'assistant', '第二条是 assistant');
  assert(moduleMessages[0]!.messageIndex === 0, 'messageIndex=0');
  assert(moduleMessages[3]!.messageIndex === 3, 'messageIndex=3');
});

// ============================================================
// 测试 6：兼容 RetrievalOptions.search 的异步接口
// ============================================================
test('Test 6: search 方法兼容 RetrievalOptions.search', async () => {
  const store = new ArchiveStore();
  const module = makeModule('module-1', 1, 2, '兼容性测试');
  module.messageIndices = [0, 1];
  const messages: Message[] = [
    { role: 'user', content: 'WebSocket connection realtime' },
    { role: 'assistant', content: 'Use WebSocket for realtime bidirectional communication.' },
  ];

  await store.archive(module, messages);

  // 调用 search（异步接口）
  const results = await store.search('WebSocket realtime', 5);
  assert(results.length > 0, 'search 返回结果');
  assert(typeof results[0]!.id === 'string', '结果有 id');
  assert(typeof results[0]!.content === 'string', '结果有 content');
  assert(typeof results[0]!.score === 'number', '结果有 score');
  assert(results[0]!.metadata !== undefined, '结果有 metadata');
});

// ============================================================
// 测试 7：空消息跳过
// ============================================================
test('Test 7: 空消息跳过', async () => {
  const store = new ArchiveStore();
  const module = makeModule('module-1', 1, 2, '空消息测试');
  module.messageIndices = [0, 1, 2];
  const messages: Message[] = [
    { role: 'user', content: '有内容' },
    { role: 'assistant', content: '' },  // 空内容
    { role: 'user', content: '   ' },    // 纯空白
  ];

  await store.archive(module, messages);
  assert(store.size === 1, '只归档了 1 条非空消息');
});

// ============================================================
// 测试 8：clear 清空
// ============================================================
test('Test 8: clear 清空归档存储', async () => {
  const store = new ArchiveStore();
  const module = makeModule('module-1', 1, 2, '清空测试');
  module.messageIndices = [0, 1];
  const messages: Message[] = [
    { role: 'user', content: 'test clear' },
    { role: 'assistant', content: 'response' },
  ];

  await store.archive(module, messages);
  assert(store.size === 2, '归档后 2 条');
  assert(store.moduleCount === 1, '1 个模块');

  store.clear();
  assert(store.size === 0, '清空后 0 条');
  assert(store.moduleCount === 0, '清空后 0 个模块');

  const results = store.searchKeyword('test');
  assert(results.length === 0, '清空后检索无结果');
});

// ============================================================
// 测试 9：与 ModuleTracker 集成
// ============================================================
test('Test 9: 与 ModuleTracker 集成', async () => {
  const tracker = new ModuleTracker({ topicSwitchThreshold: 0.20, archiveDelayRounds: 2 });
  const store = new ArchiveStore();

  // 模拟 4 轮对话
  const allMessages: Message[] = [];
  let msgIdx = 0;

  // Turn 1-2: TypeScript 类型（module-1）
  const turn1Query = 'TypeScript type guard undefined';
  const turn1Messages: Message[] = [
    { role: 'user', content: turn1Query },
    { role: 'assistant', content: 'Use type guard to check undefined.' },
  ];
  allMessages.push(...turn1Messages);
  tracker.observe(1, turn1Query, [msgIdx, msgIdx + 1]);
  msgIdx += 2;

  const turn2Query = 'TypeScript generic type constraint';
  const turn2Messages: Message[] = [
    { role: 'user', content: turn2Query },
    { role: 'assistant', content: 'Use extends keyword for generic constraints.' },
  ];
  allMessages.push(...turn2Messages);
  tracker.observe(2, turn2Query, [msgIdx, msgIdx + 1]);
  msgIdx += 2;

  // Turn 3: 切换到数据库
  const turn3Query = 'Postgres index optimization';
  const turn3Messages: Message[] = [
    { role: 'user', content: turn3Query },
    { role: 'assistant', content: 'Create B-tree index on frequently queried columns.' },
  ];
  allMessages.push(...turn3Messages);
  const r3 = tracker.observe(3, turn3Query, [msgIdx, msgIdx + 1]);
  msgIdx += 2;

  // Turn 4: 继续数据库，module-1 过 2 轮触发归档
  const turn4Query = 'Postgres transaction isolation';
  const turn4Messages: Message[] = [
    { role: 'user', content: turn4Query },
    { role: 'assistant', content: 'Use SERIALIZABLE isolation level for strict consistency.' },
  ];
  allMessages.push(...turn4Messages);
  const r4 = tracker.observe(4, turn4Query, [msgIdx, msgIdx + 1]);
  msgIdx += 2;

  assert(r4.modulesToArchive.length === 1, 'Turn 4 module-1 触发归档');
  assert(r4.modulesToArchive[0]!.id === 'module-1', '归档 module-1');

  // 归档 module-1
  const module1 = r4.modulesToArchive[0]!;
  tracker.markArchived(module1.id, 'TypeScript 类型系统摘要', 4);

  // 提取 module-1 的消息并归档到 ArchiveStore
  const module1Messages = allMessages.filter((_, i) => module1.messageIndices.includes(i));
  await store.archive({ ...module1, status: 'archived', summary: 'TypeScript 类型系统摘要' }, allMessages);

  assert(store.size > 0, 'ArchiveStore 有归档内容');

  // 检索 TypeScript 相关内容
  const results = await store.search('TypeScript type guard', 5);
  assert(results.length > 0, '检索 TypeScript 有结果');
  assert(results.every((r) => r.metadata?.moduleId === 'module-1'), '结果都在 module-1');
});

// ============================================================
// 汇总
// ============================================================
await runAll();
console.log(`\n========================================`);
console.log(`ArchiveStore 测试结果: ${pass} passed, ${fail} failed`);
console.log(`========================================`);
if (fail > 0) {
  process.exit(1);
}
