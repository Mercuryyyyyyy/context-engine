// repo-map 测试：用本项目自己的源码验证 tree-sitter 解析
// 运行: pnpm --filter @context/engine exec tsx src/__test__/repo-map.test.ts
// 也可从 monorepo 根目录运行（路径基于 import.meta.url，不依赖 cwd）

import { buildRepoMap } from '../retrieve/repo-map.js';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
// 测试目录：context-engine 包的 src（__test__ 的上级目录）
const testDir = join(__dirname, '..');

async function main() {
  console.log(`测试目录: ${testDir}\n`);

  // 测试 1：完整 repo map（给足预算避免截断）
  console.log('=== 测试1: 完整 repo map ===');
  const result = await buildRepoMap(testDir, { maxTokens: 20000 });
  console.log(`文件数: ${result.fileCount}`);
  console.log(`符号数: ${result.symbolCount}`);
  console.log(`截断: ${result.truncated}`);
  console.log(`\n--- repo map 内容 ---`);
  console.log(result.text);
  console.log(`--- end ---\n`);

  // 验证基本正确性
  let pass = 0;
  let fail = 0;
  const check = (cond: boolean, name: string) => {
    if (cond) { pass++; console.log(`  ✓ ${name}`); }
    else { fail++; console.log(`  ✗ ${name}`); }
  };

  console.log('=== 验证 ===');
  check(result.fileCount > 0, '解析了至少 1 个文件');
  check(result.symbolCount > 0, '提取了至少 1 个符号');
  check(!result.truncated, '未触发截断（token 预算充足）');

  // 应该包含已知的符号
  check(result.text.includes('runEngine'), '包含 runEngine 函数');
  check(result.text.includes('buildRepoMap'), '包含 buildRepoMap 函数');
  check(result.text.includes('reversibleCompress'), '包含 reversibleCompress 函数');
  check(result.text.includes('countTokens'), '包含 countTokens 函数');

  // 测试 2：小预算触发截断
  console.log('\n=== 测试2: 小预算截断 ===');
  const result2 = await buildRepoMap(testDir, { maxTokens: 100 });
  console.log(`符号数: ${result2.symbolCount}, 截断: ${result2.truncated}`);
  check(result2.truncated, '小预算触发截断');
  check(result2.symbolCount < result.symbolCount, '截断后符号数更少');

  // 测试 3：不存在的目录
  console.log('\n=== 测试3: 空目录 ===');
  const result3 = await buildRepoMap(join(__dirname, 'nonexistent-dir'));
  check(result3.fileCount === 0, '空目录文件数为 0');
  check(result3.symbolCount === 0, '空目录符号数为 0');

  // 汇总
  console.log(`\n--- 汇总 ---`);
  console.log(`通过: ${pass}, 失败: ${fail}`);
  console.log(`结果: ${fail === 0 ? 'PASS ✓' : 'FAIL ✗'}`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('Test error:', e);
  process.exit(1);
});
