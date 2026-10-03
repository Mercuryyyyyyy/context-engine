// PageRank 排序测试：验证符号引用图构建和排序效果
// 运行: pnpm --filter @context/engine exec tsx src/__test__/pagerank.test.ts
// 也可从 monorepo 根目录运行（路径基于 import.meta.url，不依赖 cwd）

import { buildRepoMap } from '../retrieve/repo-map.js';
import { computePageRank, buildGraphFromSymbols } from '../retrieve/pagerank.js';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const testDir = join(__dirname, '..');

async function main() {
  let pass = 0;
  let fail = 0;
  const check = (cond: boolean, name: string) => {
    if (cond) { pass++; console.log(`  ✓ ${name}`); }
    else { fail++; console.log(`  ✗ ${name}`); }
  };

  // 测试 1：PageRank 基本算法
  console.log('\n=== 测试1: PageRank 基本算法 ===');
  // 构造简单图：A→B, B→C, C→A（环）
  const edges = [
    { from: 'A', to: 'B', weight: 1 },
    { from: 'B', to: 'C', weight: 1 },
    { from: 'C', to: 'A', weight: 1 },
  ];
  const nodes = new Set(['A', 'B', 'C']);
  const pr = computePageRank(edges, nodes);
  console.log(`  迭代次数: ${pr.iterations}, 收敛: ${pr.converged}`);
  console.log(`  A: ${pr.ranks.get('A')?.toFixed(4)}, B: ${pr.ranks.get('B')?.toFixed(4)}, C: ${pr.ranks.get('C')?.toFixed(4)}`);

  check(pr.converged, '算法收敛');
  check(pr.ranks.size === 3, '3个节点都有 rank');

  // 环形图，三个节点 rank 应接近
  const ranks = ['A', 'B', 'C'].map((n) => pr.ranks.get(n)!);
  const maxDiff = Math.max(...ranks) - Math.min(...ranks);
  check(maxDiff < 0.01, `环形图节点 rank 接近 (最大差: ${maxDiff.toFixed(6)})`);

  // 总和应接近 1
  const total = ranks.reduce((s, r) => s + r, 0);
  check(Math.abs(total - 1) < 0.01, `rank 总和 ≈ 1 (实际: ${total.toFixed(4)})`);

  // 测试 2：星形图，中心节点 rank 应更高
  console.log('\n=== 测试2: 星形图（中心更重要）===');
  const starEdges = [
    { from: 'leaf1', to: 'center', weight: 1 },
    { from: 'leaf2', to: 'center', weight: 1 },
    { from: 'leaf3', to: 'center', weight: 1 },
  ];
  const starNodes = new Set(['center', 'leaf1', 'leaf2', 'leaf3']);
  const starPr = computePageRank(starEdges, starNodes);
  const centerRank = starPr.ranks.get('center')!;
  const leafRanks = ['leaf1', 'leaf2', 'leaf3'].map((n) => starPr.ranks.get(n)!);
  console.log(`  center: ${centerRank.toFixed(4)}, leaves: ${leafRanks.map((r) => r.toFixed(4)).join(', ')}`);

  check(centerRank > Math.max(...leafRanks), '中心节点 rank > 叶子节点');
  check(leafRanks.every((r) => Math.abs(r - leafRanks[0]!) < 0.001), '叶子节点 rank 相同');

  // 测试 3：buildGraphFromSymbols
  console.log('\n=== 测试3: buildGraphFromSymbols ===');
  const defMap = new Map([
    ['foo', ['fileA.ts']],
    ['bar', ['fileB.ts']],
  ]);
  const fileRefs = new Map([
    ['fileB.ts', ['foo']],  // fileB 引用 fileA 的 foo
    ['fileA.ts', ['bar']],  // fileA 引用 fileB 的 bar
  ]);
  const graphEdges = buildGraphFromSymbols(defMap, fileRefs);
  console.log(`  边数: ${graphEdges.length}`);
  check(graphEdges.length === 2, '构建了 2 条边');
  check(
    graphEdges.some((e) => e.from === 'fileB.ts' && e.to === 'fileA.ts'),
    'fileB → fileA 边存在'
  );

  // 测试 4：实际项目 repo map with PageRank
  console.log('\n=== 测试4: 实际项目 PageRank 排序 ===');
  const resultWithPR = await buildRepoMap(testDir);
  const resultAlpha = await buildRepoMap(testDir, { disablePageRank: true });

  console.log(`  PageRank 排序的文件数: ${resultWithPR.fileCount}`);
  console.log(`  字母序排序的文件数: ${resultAlpha.fileCount}`);

  check(resultWithPR.ranking !== undefined, 'PageRank 结果包含 ranking');
  check(resultWithPR.ranking!.length > 0, 'ranking 非空');

  // 打印前 5 个文件的排序
  console.log('\n  PageRank 排序前 5:');
  for (const r of resultWithPR.ranking!.slice(0, 5)) {
    console.log(`    ${r.rank.toFixed(4)}  ${r.path}`);
  }

  console.log('\n  字母序排序前 5:');
  const alphaFiles = resultAlpha.text.split('\n').filter((l) => l && !l.startsWith(' ')).slice(0, 5);
  for (const f of alphaFiles) {
    console.log(`    ${f}`);
  }

  // PageRank 排序和字母序应该不同
  const prFirstFile = resultWithPR.ranking![0]!.path;
  const alphaFirstFile = alphaFiles[0]!;
  check(prFirstFile !== alphaFirstFile, `排序不同 (PR: ${prFirstFile}, Alpha: ${alphaFirstFile})`);

  // 测试 5：focusFiles 加权
  console.log('\n=== 测试5: focusFiles 个性化加权 ===');
  const resultFocused = await buildRepoMap(testDir, {
    focusFiles: ['engine.ts'],
  });

  check(resultFocused.ranking !== undefined, 'focused 结果包含 ranking');
  // engine.ts 应该排名靠前
  const engineRank = resultFocused.ranking!.findIndex((r) => r.path.endsWith('engine.ts'));
  console.log(`  engine.ts 排名: ${engineRank + 1}/${resultFocused.ranking!.length}`);
  check(engineRank >= 0 && engineRank < 3, `engine.ts 排名前 3 (实际: ${engineRank + 1})`);

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
