// 混合检索测试：RRF 融合 + 关键词检索 + 向量检索（mock embedding）
// 运行: pnpm --filter @context/engine exec tsx src/__test__/hybrid-search.test.ts

import { reciprocalRankFusion } from '../retrieve/hybrid-search.js';
import { KeywordIndex } from '../retrieve/keyword-search.js';
import { VectorStore } from '../retrieve/vector-store.js';
import { HybridSearcher } from '../retrieve/hybrid-searcher.js';
import { cosineSimilarity } from '../retrieve/embedder.js';
import type { EmbedFn } from '../retrieve/embedder.js';

async function main() {
  let pass = 0;
  let fail = 0;
  const check = (cond: boolean, name: string) => {
    if (cond) { pass++; console.log(`  ✓ ${name}`); }
    else { fail++; console.log(`  ✗ ${name}`); }
  };

  // 测试 1：cosineSimilarity 基本正确性
  console.log('\n=== 测试1: cosineSimilarity ===');
  const v1 = Float32Array.from([1, 0, 0]);
  const v2 = Float32Array.from([0, 1, 0]);
  const v3 = Float32Array.from([1, 0, 0]);
  const sim0 = cosineSimilarity(v1, v2);
  const sim1 = cosineSimilarity(v1, v3);
  console.log(`  正交: ${sim0.toFixed(4)}, 相同: ${sim1.toFixed(4)}`);
  check(Math.abs(sim0) < 0.001, '正交向量相似度 ≈ 0');
  check(Math.abs(sim1 - 1) < 0.001, '相同向量相似度 ≈ 1');

  // 测试 2：RRF 融合
  console.log('\n=== 测试2: RRF 融合 ===');
  const set1 = [
    { id: 'a', score: 0.9 },
    { id: 'b', score: 0.8 },
    { id: 'c', score: 0.7 },
  ];
  const set2 = [
    { id: 'b', score: 0.95 },
    { id: 'd', score: 0.85 },
    { id: 'a', score: 0.75 },
  ];
  const fused = reciprocalRankFusion([set1, set2], { topK: 4 });
  console.log(`  融合结果: ${fused.map((f) => `${f.id}(${f.score.toFixed(4)})`).join(', ')}`);

  // b 在两路都排第一/第二，应该排名靠前
  check(fused[0]!.id === 'b', 'b 排名第一（两路都靠前）');
  check(fused.length === 4, '返回 4 个结果');
  check(fused[0]!.score > fused[1]!.score, '分数降序');

  // 测试 3：KeywordIndex TF-IDF
  console.log('\n=== 测试3: KeywordIndex TF-IDF ===');
  const kwIndex = new KeywordIndex();
  kwIndex.add({ id: 'file1.ts', content: 'export function parseConfig(config) { return config }' });
  kwIndex.add({ id: 'file2.ts', content: 'export class ConfigParser { parse() {} }' });
  kwIndex.add({ id: 'file3.ts', content: 'const config = { port: 8080 }' });

  const kwResults = kwIndex.search('config parser', 5);
  console.log(`  搜索 "config parser": ${kwResults.map((r) => `${r.id}(${r.score.toFixed(2)})`).join(', ')}`);
  check(kwResults.length > 0, '有结果');
  check(kwResults.length <= 3, '结果数 ≤ 文档数');

  const commonTermIndex = new KeywordIndex();
  commonTermIndex.add({ id: 'a', content: '缓存 IndexedDB TTL' });
  commonTermIndex.add({ id: 'b', content: '缓存 EventEmitter 订阅' });
  const commonResults = commonTermIndex.search('缓存', 2);
  check(commonResults.length === 2, '所有文档都包含的领域词经平滑 IDF 后仍可检索');

  // 测试 4：VectorStore with mock embedding
  console.log('\n=== 测试4: VectorStore with mock embedding ===');
  // mock embedder：把文本哈希成固定维度向量
  const mockEmbed: EmbedFn = (text: string): Promise<Float32Array> => {
    const dim = 128;
    const vec = new Float32Array(dim);
    // 简单哈希：字符 n-gram
    const lower = text.toLowerCase();
    for (let i = 0; i < lower.length - 2; i++) {
      const trigram = lower.slice(i, i + 3);
      const hash = trigram.split('').reduce((s, c) => (s * 31 + c.charCodeAt(0)) & 0x7fffffff, 0);
      vec[hash % dim]! += 1;
    }
    // L2 归一化
    let norm = 0;
    for (const v of vec) norm += v * v;
    norm = Math.sqrt(norm);
    if (norm > 0) for (let i = 0; i < dim; i++) vec[i]! /= norm;
    return Promise.resolve(vec);
  };

  const store = new VectorStore(mockEmbed);
  await store.add({ id: 'doc1', content: 'The quick brown fox jumps over the lazy dog' });
  await store.add({ id: 'doc2', content: 'A quick fox is running fast' });
  await store.add({ id: 'doc3', content: 'The weather is nice today' });

  const vecResults = await store.search('quick fox running', 3);
  console.log(`  向量搜索 "quick fox running": ${vecResults.map((r) => `${r.id}(${r.score.toFixed(4)})`).join(', ')}`);
  check(vecResults.length > 0, '有结果');
  // doc1 和 doc2 都有 quick fox，应该比 doc3 更相关
  check(vecResults[0]!.id === 'doc1' || vecResults[0]!.id === 'doc2', '最相关的是 doc1 或 doc2');

  // 测试 5：HybridSearcher 混合检索
  console.log('\n=== 测试5: HybridSearcher 混合检索 ===');
  const searcher = new HybridSearcher(mockEmbed);
  await searcher.addBatch([
    { id: 'file1.ts', content: 'export function parseConfig(config) { return config }' },
    { id: 'file2.ts', content: 'export class ConfigParser { parse() {} }' },
    { id: 'file3.ts', content: 'const config = { port: 8080 }' },
    { id: 'file4.ts', content: 'function validateInput(input) { return true }' },
  ]);

  check(searcher.size === 4, '索引了 4 个文档');

  const hybridResults = await searcher.search('parseConfig', { finalTopK: 3 });
  console.log(`  混合搜索 "parseConfig": ${hybridResults.map((r) => `${r.id}(${r.score.toFixed(4)})`).join(', ')}`);
  check(hybridResults.length > 0, '有结果');

  // file1 定义了 parseConfig，应该排第一
  check(hybridResults[0]!.id === 'file1.ts', 'file1.ts 排第一（定义了 parseConfig）');

  // 测试 6：仅关键词 vs 仅向量 vs 混合
  console.log('\n=== 测试6: 检索方式对比 ===');
  const kwOnly = searcher.keywordSearch('config', 3);
  const vecOnly = await searcher.vectorSearch('config', 3);
  const hybrid = await searcher.search('config', { finalTopK: 3 });

  console.log(`  关键词: ${kwOnly.map((r) => r.id).join(', ')}`);
  console.log(`  向量:   ${vecOnly.map((r) => r.id).join(', ')}`);
  console.log(`  混合:   ${hybrid.map((r) => r.id).join(', ')}`);

  check(kwOnly.length > 0, '关键词检索有结果');
  check(vecOnly.length > 0, '向量检索有结果');
  check(hybrid.length > 0, '混合检索有结果');

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
