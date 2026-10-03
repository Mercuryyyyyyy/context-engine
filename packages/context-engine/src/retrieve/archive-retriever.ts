// 归档检索器：包装 ArchiveStore，实现 RetrievalOptions.search 接口
// 关键特性：
// 1. topic gate：检索结果与当前 query 主题不一致时拒绝注入
// 2. 检索日志：记录命中文档、得分、主题相关度、注入 token 数
// 3. 直接兼容 engine.ts 的 retrieval hook

import type { RetrievedContext } from '../types.js';
import { ArchiveStore } from './archive-store.js';
import { countTokens } from '../tokenize.js';

export interface ArchiveRetrieverOptions {
  // 检索 top-K，默认 6
  topK?: number;
  // 最低检索分数，默认 0.01
  minScore?: number;
  // topic gate 阈值：检索结果与 query 主题相关度低于此值时拒绝注入，默认 0.10
  topicGateThreshold?: number;
  // 最大注入 token 数，默认 1200
  maxTokens?: number;
}

export interface SearchLogEntry {
  id: string;
  score: number;            // 检索分数
  topicRelevance: number;   // 与当前 query 的主题相关度
  accepted: boolean;        // 是否通过 topic gate
  rejectedReason?: 'topic-gate' | 'token-budget' | 'min-score';
}

export interface SearchLog {
  query: string;
  totalRetrieved: number;     // ArchiveStore 返回的总数
  acceptedCount: number;      // 通过 topic gate 的数量
  rejectedByTopicGate: number;
  rejectedByMinScore: number;
  injectedTokens: number;
  results: SearchLogEntry[];
}

const DEFAULT_OPTIONS: Required<ArchiveRetrieverOptions> = {
  topK: 6,
  minScore: 0.01,
  topicGateThreshold: 0.10,
  maxTokens: 1200,
};

// 关键词提取（与 ModuleTracker 一致）
function extractKeywords(text: string): Set<string> {
  const terms = new Set<string>();
  const lower = text.toLowerCase();
  for (const match of lower.matchAll(/[a-z_][a-z0-9_.-]{1,}|\d+/g)) {
    terms.add(match[0]);
  }
  for (const match of lower.matchAll(/[\u4e00-\u9fff]+/g)) {
    const value = match[0];
    if (value.length <= 2) {
      terms.add(value);
    } else {
      for (let i = 0; i < value.length - 1; i++) {
        terms.add(value.slice(i, i + 2));
      }
    }
  }
  const camelParts = text.match(/[a-z]+[A-Z][a-z]+/g) || [];
  for (const word of camelParts) {
    const parts = word.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().split(' ');
    for (const p of parts) {
      if (p.length >= 2) terms.add(p);
    }
  }
  return terms;
}

// 计算查询覆盖率（与 ModuleTracker 一致）
function keywordCoverage(queryTerms: Set<string>, candidateTerms: Set<string>): number {
  if (queryTerms.size === 0 || candidateTerms.size === 0) return 0;
  let overlap = 0;
  for (const term of queryTerms) {
    if (candidateTerms.has(term)) overlap++;
  }
  return overlap / queryTerms.size;
}

export class ArchiveRetriever {
  private store: ArchiveStore;
  private options: Required<ArchiveRetrieverOptions>;
  private lastLog: SearchLog | null = null;

  constructor(store: ArchiveStore, options?: ArchiveRetrieverOptions) {
    this.store = store;
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  /**
   * 检索接口（兼容 RetrievalOptions.search）
   * 流程：ArchiveStore 检索 → minScore 过滤 → topic gate → token budget 截断
   */
  search = async (query: string, topK: number): Promise<RetrievedContext[]> => {
    const effectiveTopK = Math.min(topK, this.options.topK);
    const queryTerms = extractKeywords(query);

    // 1. ArchiveStore 检索
    const rawResults = await this.store.search(query, effectiveTopK * 2);

    // 2. minScore 过滤 + topic gate
    const logEntries: SearchLogEntry[] = [];
    const accepted: RetrievedContext[] = [];

    for (const result of rawResults) {
      const score = result.score ?? 0;
      let entry: SearchLogEntry = {
        id: result.id,
        score,
        topicRelevance: 0,
        accepted: false,
      };

      // minScore 过滤
      if (score < this.options.minScore) {
        entry.rejectedReason = 'min-score';
        logEntries.push(entry);
        continue;
      }

      // topic gate：计算检索结果与当前 query 的主题相关度
      const contentTerms = extractKeywords(result.content);
      const relevance = keywordCoverage(queryTerms, contentTerms);
      entry.topicRelevance = relevance;

      if (relevance < this.options.topicGateThreshold) {
        entry.rejectedReason = 'topic-gate';
        logEntries.push(entry);
        continue;
      }

      entry.accepted = true;
      logEntries.push(entry);
      accepted.push(result);
    }

    // 3. token budget 截断
    let injectedTokens = 0;
    const finalResults: RetrievedContext[] = [];
    for (const result of accepted) {
      const tokens = countTokens(result.content);
      if (injectedTokens + tokens > this.options.maxTokens) break;
      injectedTokens += tokens;
      finalResults.push(result);
    }

    // 4. 记录日志
    const rejectedByTopicGate = logEntries.filter((e) => e.rejectedReason === 'topic-gate').length;
    const rejectedByMinScore = logEntries.filter((e) => e.rejectedReason === 'min-score').length;

    this.lastLog = {
      query,
      totalRetrieved: rawResults.length,
      acceptedCount: finalResults.length,
      rejectedByTopicGate,
      rejectedByMinScore,
      injectedTokens,
      results: logEntries,
    };

    return finalResults;
  };

  /**
   * 获取最近一次检索的日志
   */
  getLastSearchLog(): SearchLog | null {
    return this.lastLog;
  }

  /**
   * 更新选项
   */
  updateOptions(options: Partial<ArchiveRetrieverOptions>): void {
    this.options = { ...this.options, ...options };
  }

  /**
   * 获取当前选项
   */
  getOptions(): Required<ArchiveRetrieverOptions> {
    return this.options;
  }

  /**
   * 转换为 RetrievalOptions（直接用于 EngineInput.retrieval）
   */
  toRetrievalOptions() {
    return {
      search: this.search,
      topK: this.options.topK,
      maxTokens: this.options.maxTokens,
      when: 'over-budget' as const,
      minScore: this.options.minScore,
    };
  }
}
