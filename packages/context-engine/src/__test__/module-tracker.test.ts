// ModuleTracker 单元测试
// 验证主题切换检测、归档时机判定、高水位兜底

import { ModuleTracker } from '../retrieve/module-tracker.js';

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

function test(name: string, fn: () => void): void {
  console.log(`\n${name}`);
  fn();
}

// ============================================================
// 测试 1：同主题连续轮次应归入同一模块
// ============================================================
test('Test 1: 同主题连续轮次归入同一模块', () => {
  const tracker = new ModuleTracker({ topicSwitchThreshold: 0.20, archiveDelayRounds: 3 });
  const r1 = tracker.observe(1, '如何用 TypeScript 处理 undefined 类型？', [0, 1]);
  assert(r1.newModuleCreated === true, 'Turn 1 创建新模块');
  assert(r1.currentModuleId === 'module-1', 'Turn 1 模块 id 为 module-1');
  assert(r1.modulesToArchive.length === 0, 'Turn 1 无待归档模块');

  // Turn 2：同主题（TypeScript 类型）
  const r2 = tracker.observe(2, 'TypeScript 类型守卫怎么写？', [2, 3]);
  assert(r2.newModuleCreated === false, 'Turn 2 不创建新模块（同主题）');
  assert(r2.currentModuleId === 'module-1', 'Turn 2 仍在 module-1');
  assert(r2.modulesToArchive.length === 0, 'Turn 2 无待归档模块');
});

// ============================================================
// 测试 2：主题切换应创建新模块
// ============================================================
test('Test 2: 主题切换创建新模块', () => {
  const tracker = new ModuleTracker({ topicSwitchThreshold: 0.20, archiveDelayRounds: 3 });
  tracker.observe(1, 'TypeScript 类型守卫处理 undefined', [0, 1]);
  tracker.observe(2, 'TypeScript 类型推导问题', [2, 3]);

  // Turn 3：完全不同主题（数据库）
  const r3 = tracker.observe(3, 'Postgres 索引优化查询性能', [4, 5]);
  assert(r3.newModuleCreated === true, 'Turn 3 主题切换，创建新模块');
  assert(r3.currentModuleId === 'module-2', 'Turn 3 创建 module-2');
  assert(r3.modulesToArchive.length === 0, 'Turn 3 module-1 还未到归档延迟（仅过 1 轮）');
});

// ============================================================
// 测试 3：旧模块连续 N 轮无引用应标记归档
// ============================================================
test('Test 3: 旧模块连续 N 轮无引用触发归档', () => {
  const tracker = new ModuleTracker({ topicSwitchThreshold: 0.20, archiveDelayRounds: 3 });
  tracker.observe(1, 'TypeScript 类型守卫处理 undefined', [0, 1]);
  tracker.observe(2, 'TypeScript 类型推导问题', [2, 3]);
  // Turn 3 切换主题
  tracker.observe(3, 'Postgres 索引优化查询性能', [4, 5]);
  // Turn 4 继续数据库主题
  const r4 = tracker.observe(4, 'Postgres 乐观锁并发控制', [6, 7]);
  assert(r4.modulesToArchive.length === 0, 'Turn 4 module-1 仅过 2 轮，未到延迟阈值 3');

  // Turn 5 继续数据库主题，module-1 已过 3 轮
  const r5 = tracker.observe(5, 'Postgres 事务隔离级别', [8, 9]);
  assert(r5.modulesToArchive.length === 1, 'Turn 5 module-1 已过 3 轮无引用，触发归档');
  assert(r5.modulesToArchive[0]!.id === 'module-1', '归档的是 module-1');
});

// ============================================================
// 测试 4：高水位兜底强制归档
// ============================================================
test('Test 4: 高水位兜底强制归档最老模块', () => {
  const tracker = new ModuleTracker({
    topicSwitchThreshold: 0.20,
    archiveDelayRounds: 100, // 设很高，只测高水位
    highWatermarkTokens: 5000,
  });
  tracker.observe(1, 'TypeScript 类型问题', [0, 1]);
  tracker.observe(2, '数据库索引优化', [2, 3]);
  // Turn 3：当前 token 6000 超过 5000 高水位
  const r3 = tracker.observe(3, '数据库事务', [4, 5], 6000);
  assert(r3.modulesToArchive.length === 1, 'Turn 3 高水位触发，强制归档最老活动模块');
  assert(r3.modulesToArchive[0]!.id === 'module-1', '归档的是最老的 module-1');
});

// ============================================================
// 测试 5：markArchived 后模块状态变更
// ============================================================
test('Test 5: markArchived 更新模块状态', () => {
  const tracker = new ModuleTracker({ archiveDelayRounds: 2 });
  tracker.observe(1, 'TypeScript type guard undefined check', [0, 1]);
  tracker.observe(2, 'Postgres index optimization query', [2, 3]); // 切换
  const r3 = tracker.observe(3, 'Postgres transaction isolation', [4, 5]); // module-1 过 2 轮
  assert(r3.modulesToArchive.length === 1, 'Turn 3 module-1 触发归档');

  const archived = r3.modulesToArchive[0]!;
  tracker.markArchived(archived.id, '主题A 的摘要内容', 3);
  const module = tracker.getModule('module-1');
  assert(module !== null, 'module-1 仍存在');
  assert(module!.status === 'archived', 'module-1 状态为 archived');
  assert(module!.summary === '主题A 的摘要内容', 'module-1 摘要已写入');
  assert(module!.archivedAtTurn === 3, 'module-1 归档于 turn 3');

  const archivedList = tracker.getArchivedModules();
  assert(archivedList.length === 1, 'getArchivedModules 返回 1 个');
  assert(tracker.archivedCount === 1, 'archivedCount = 1');

  const activeList = tracker.getActiveModules();
  assert(activeList.length === 1, 'getActiveModules 返回 1 个（module-2）');
  assert(activeList[0]!.id === 'module-2', '活动模块是 module-2');
});

// ============================================================
// 测试 6：消息索引累积
// ============================================================
test('Test 6: 消息索引正确累积', () => {
  const tracker = new ModuleTracker({ topicSwitchThreshold: 0.20, archiveDelayRounds: 10 });
  tracker.observe(1, 'TypeScript 类型', [0, 1]);
  tracker.observe(2, 'TypeScript 异步', [2, 3]);
  const module = tracker.getCurrentModule();
  assert(module !== null, '当前模块存在');
  assert(module!.messageIndices.length === 4, '累积 4 个消息索引');
  assert(JSON.stringify(module!.messageIndices) === JSON.stringify([0, 1, 2, 3]), '索引顺序正确');
});

// ============================================================
// 测试 7：中文主题切换检测
// ============================================================
test('Test 7: 中文主题切换检测', () => {
  const tracker = new ModuleTracker({ topicSwitchThreshold: 0.15, archiveDelayRounds: 5 });
  tracker.observe(1, '用户认证登录功能实现', [0, 1]);
  tracker.observe(2, '登录认证密码加密处理', [2, 3]);
  assert(tracker.getCurrentModule()!.id === 'module-1', 'Turn 1-2 同属认证模块（共享 登录/认证）');

  // Turn 3 切换到性能优化
  const r3 = tracker.observe(3, 'React 应用首屏加载性能优化 LCP', [4, 5]);
  assert(r3.newModuleCreated === true, 'Turn 3 中文→英文性能主题，创建新模块');
  assert(r3.currentModuleId === 'module-2', 'Turn 3 是 module-2');
});

// ============================================================
// 测试 8：clear 重置
// ============================================================
test('Test 8: clear 重置状态', () => {
  const tracker = new ModuleTracker();
  tracker.observe(1, 'TypeScript types', [0, 1]);
  tracker.observe(2, 'Postgres database', [2, 3]);
  assert(tracker.size === 2, '重置前有 2 个模块');
  tracker.clear();
  assert(tracker.size === 0, '重置后 0 个模块');
  assert(tracker.getCurrentModule() === null, '重置后无当前模块');
});

// ============================================================
// 汇总
// ============================================================
console.log(`\n========================================`);
console.log(`ModuleTracker 测试结果: ${pass} passed, ${fail} failed`);
console.log(`========================================`);
if (fail > 0) {
  process.exit(1);
}
