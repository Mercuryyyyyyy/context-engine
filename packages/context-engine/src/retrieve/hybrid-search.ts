// RRF（Reciprocal Rank Fusion）混合检索融合
// 将多路检索结果按排名融合，无需归一化分数

export interface SearchHit {
  id: string;
  score: number;  // 原始分数（RRF 不依赖具体值，只看排名）
  doc?: { content: string; metadata?: Record<string, unknown> };
}

export interface RRFOptions {
  // RRF 常数 k，默认 60（经验值，源自 ElasticSearch）
  k?: number;
  // 最终返回的 top-K 数量
  topK?: number;
  // 各检索器权重（可选，默认等权）
  weights?: number[];
}

// RRF 融合
// 输入：多路检索结果（每路已按分数降序排列）
// 输出：融合后的 top-K 结果
export function reciprocalRankFusion(
  resultSets: SearchHit[][],
  options?: RRFOptions
): SearchHit[] {
  const k = options?.k ?? 60;
  const topK = options?.topK ?? 10;
  const weights = options?.weights || resultSets.map(() => 1);

  // 累加各文档的 RRF 分数
  const scoreMap = new Map<string, { score: number; doc?: SearchHit['doc'] }>();

  for (let setIdx = 0; setIdx < resultSets.length; setIdx++) {
    const results = resultSets[setIdx]!;
    const weight = weights[setIdx] ?? 1;

    for (let rank = 0; rank < results.length; rank++) {
      const hit = results[rank]!;
      const rrfScore = weight / (k + rank + 1); // rank 从 0 开始，所以 +1

      const existing = scoreMap.get(hit.id);
      if (existing) {
        existing.score += rrfScore;
        // 保留文档信息
        if (!existing.doc && hit.doc) existing.doc = hit.doc;
      } else {
        scoreMap.set(hit.id, { score: rrfScore, doc: hit.doc });
      }
    }
  }

  // 排序输出
  const fused = Array.from(scoreMap.entries())
    .map(([id, { score, doc }]) => ({ id, score, doc }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);

  return fused;
}

// 便捷函数：从多路检索结果直接融合
export function fuseResults(
  results: SearchHit[][],
  topK = 10
): SearchHit[] {
  return reciprocalRankFusion(results, { topK });
}
