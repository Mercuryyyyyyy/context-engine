// PageRank 符号排序：构建文件级有向图，按重要性排序
// 借鉴 Aider repomap 的图构建思路，自实现 PageRank 算法

// 图的节点：文件路径
// 图的边：文件 A 引用了文件 B 中定义的符号 → A→B
// 边权：引用次数（同一对文件多次引用则权重更高）

export interface GraphEdge {
  from: string;
  to: string;
  weight: number;
}

export interface PageRankOptions {
  // 阻尼因子，默认 0.85
  dampingFactor?: number;
  // 最大迭代次数，默认 100
  maxIterations?: number;
  // 收敛阈值，默认 1e-6
  tolerance?: number;
  // 个性化向量：给某些节点额外加权（如用户当前关注的文件）
  // key=文件路径，value=权重
  personalization?: Map<string, number>;
}

export interface PageRankResult {
  // 文件路径 → PageRank 值
  ranks: Map<string, number>;
  // 迭代次数
  iterations: number;
  // 是否收敛
  converged: boolean;
}

// 构建邻接表
function buildAdjacencyList(
  edges: GraphEdge[],
  nodes: Set<string>
): Map<string, Map<string, number>> {
  const adj = new Map<string, Map<string, number>>();

  // 初始化所有节点
  for (const node of nodes) {
    adj.set(node, new Map());
  }

  // 累加边权
  for (const edge of edges) {
    if (!adj.has(edge.from)) adj.set(edge.from, new Map());
    if (!adj.has(edge.to)) adj.set(edge.to, new Map());

    const fromAdj = adj.get(edge.from)!;
    fromAdj.set(edge.to, (fromAdj.get(edge.to) || 0) + edge.weight);
  }

  return adj;
}

// PageRank 迭代算法
export function computePageRank(
  edges: GraphEdge[],
  allNodes: Set<string>,
  options?: PageRankOptions
): PageRankResult {
  const d = options?.dampingFactor ?? 0.85;
  const maxIter = options?.maxIterations ?? 100;
  const tol = options?.tolerance ?? 1e-6;
  const personalization = options?.personalization;

  const nodes = Array.from(allNodes);
  const N = nodes.length;

  if (N === 0) {
    return { ranks: new Map(), iterations: 0, converged: true };
  }

  // 构建邻接表
  const adj = buildAdjacencyList(edges, allNodes);

  // 计算每个节点的出度（带权）
  const outWeight = new Map<string, number>();
  for (const [node, neighbors] of adj) {
    let total = 0;
    for (const w of neighbors.values()) total += w;
    outWeight.set(node, total);
  }

  // 初始化 PR 值
  let ranks = new Map<string, number>();
  let newRanks = new Map<string, number>();

  // 个性化向量归一化
  let personalVector = new Map<string, number>();
  if (personalization && personalization.size > 0) {
    let total = 0;
    for (const v of personalization.values()) total += v;
    if (total > 0) {
      for (const node of nodes) {
        personalVector.set(node, (personalization.get(node) || 0) / total);
      }
    } else {
      // personalization 全为 0，退化为均匀分布
      for (const node of nodes) personalVector.set(node, 1 / N);
    }
  } else {
    for (const node of nodes) personalVector.set(node, 1 / N);
  }

  // 初始值 = 个性化向量
  for (const node of nodes) {
    ranks.set(node, personalVector.get(node) || 1 / N);
  }

  // 迭代
  let iter = 0;
  let converged = false;

  for (iter = 0; iter < maxIter; iter++) {
    let delta = 0;

    for (const node of nodes) {
      // 计算入链贡献
      let incomingSum = 0;

      // 遍历所有节点，找指向当前节点的边
      for (const [src, neighbors] of adj) {
        const w = neighbors.get(node);
        if (w && w > 0) {
          const srcOut = outWeight.get(src) || 0;
          if (srcOut > 0) {
            incomingSum += (ranks.get(src) || 0) * (w / srcOut);
          }
        }
      }

      // 处理悬挂节点（出度为0的节点）：其 PR 值均匀分配给所有节点
      let danglingSum = 0;
      for (const src of nodes) {
        if ((outWeight.get(src) || 0) === 0) {
          danglingSum += ranks.get(src) || 0;
        }
      }
      incomingSum += danglingSum / N;

      // PageRank 公式
      const newRank = (1 - d) * (personalVector.get(node) || 1 / N) + d * incomingSum;
      newRanks.set(node, newRank);

      delta += Math.abs(newRank - (ranks.get(node) || 0));
    }

    // 交换
    [ranks, newRanks] = [newRanks, ranks];

    if (delta < tol) {
      converged = true;
      break;
    }
  }

  // 归一化（确保总和为1）
  let total = 0;
  for (const v of ranks.values()) total += v;
  if (total > 0) {
    for (const [k, v] of ranks) ranks.set(k, v / total);
  }

  return { ranks, iterations: iter + 1, converged };
}

// 从符号定义和引用构建图边
// defMap: 符号名 → 定义所在文件
// refs: 每个文件的引用符号列表
export function buildGraphFromSymbols(
  defMap: Map<string, string[]>,  // 符号名 → 定义所在文件列表
  fileRefs: Map<string, string[]> // 文件 → 该文件引用的符号名列表
): GraphEdge[] {
  const edges: GraphEdge[] = [];

  for (const [fromFile, refNames] of fileRefs) {
    for (const refName of refNames) {
      const defFiles = defMap.get(refName);
      if (defFiles) {
        for (const toFile of defFiles) {
          // 不自引用
          if (fromFile !== toFile) {
            edges.push({ from: fromFile, to: toFile, weight: 1 });
          }
        }
      }
    }
  }

  return edges;
}
