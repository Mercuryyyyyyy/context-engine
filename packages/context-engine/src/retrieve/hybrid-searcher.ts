// 混合检索管理器：整合向量检索 + 关键词检索 + RRF 融合
// 提供统一的索引和查询接口

import { VectorStore, type VectorDoc } from './vector-store.js';
import { KeywordIndex, type KeywordDoc } from './keyword-search.js';
import { reciprocalRankFusion, type SearchHit } from './hybrid-search.js';
import type { EmbedFn } from './embedder.js';

export interface HybridSearchOptions {
  // 向量检索 top-K，默认 20
  vectorTopK?: number;
  // 关键词检索 top-K，默认 20
  keywordTopK?: number;
  // 最终融合 top-K，默认 10
  finalTopK?: number;
  // 向量检索权重，默认 1
  vectorWeight?: number;
  // 关键词检索权重，默认 1
  keywordWeight?: number;
}

export interface IndexEntry {
  id: string;
  content: string;
  metadata?: Record<string, unknown>;
}

export class HybridSearcher {
  private vectorStore: VectorStore;
  private keywordIndex: KeywordIndex;
  private embedFn: EmbedFn;

  constructor(embedFn: EmbedFn) {
    this.embedFn = embedFn;
    this.vectorStore = new VectorStore(embedFn);
    this.keywordIndex = new KeywordIndex();
  }

  // 添加文档到两个索引
  async add(entry: IndexEntry): Promise<void> {
    const vecDoc: VectorDoc = { id: entry.id, content: entry.content, metadata: entry.metadata };
    const kwDoc: KeywordDoc = { id: entry.id, content: entry.content, metadata: entry.metadata };

    await this.vectorStore.add(vecDoc);
    this.keywordIndex.add(kwDoc);
  }

  // 批量添加
  async addBatch(entries: IndexEntry[]): Promise<void> {
    // 关键词索引同步加
    for (const entry of entries) {
      this.keywordIndex.add({ id: entry.id, content: entry.content, metadata: entry.metadata });
    }
    // 向量索引批量加
    await this.vectorStore.addBatch(
      entries.map((e) => ({ id: e.id, content: e.content, metadata: e.metadata }))
    );
  }

  // 删除
  remove(id: string): void {
    this.vectorStore.remove(id);
    this.keywordIndex.remove(id);
  }

  // 清空
  clear(): void {
    this.vectorStore.clear();
    this.keywordIndex.clear();
  }

  get size(): number {
    return this.vectorStore.size;
  }

  // 混合检索
  async search(
    query: string,
    options?: HybridSearchOptions
  ): Promise<SearchHit[]> {
    const vectorTopK = options?.vectorTopK ?? 20;
    const keywordTopK = options?.keywordTopK ?? 20;
    const finalTopK = options?.finalTopK ?? 10;
    const vectorWeight = options?.vectorWeight ?? 1;
    const keywordWeight = options?.keywordWeight ?? 1;

    // 并行检索
    const [vectorResults, keywordResults] = await Promise.all([
      this.vectorStore.search(query, vectorTopK),
      Promise.resolve(this.keywordIndex.search(query, keywordTopK)),
    ]);

    // 转换为统一格式
    const vectorHits: SearchHit[] = vectorResults.map((r) => ({
      id: r.id,
      score: r.score,
      doc: { content: r.doc.content, metadata: r.doc.metadata },
    }));

    const keywordHits: SearchHit[] = keywordResults.map((r) => ({
      id: r.id,
      score: r.score,
      doc: { content: r.doc.content, metadata: r.doc.metadata },
    }));

    // RRF 融合
    return reciprocalRankFusion([vectorHits, keywordHits], {
      topK: finalTopK,
      weights: [vectorWeight, keywordWeight],
    });
  }

  // 仅向量检索
  async vectorSearch(query: string, topK = 10): Promise<SearchHit[]> {
    const results = await this.vectorStore.search(query, topK);
    return results.map((r) => ({
      id: r.id,
      score: r.score,
      doc: { content: r.doc.content, metadata: r.doc.metadata },
    }));
  }

  // 仅关键词检索
  keywordSearch(query: string, topK = 10): SearchHit[] {
    const results = this.keywordIndex.search(query, topK);
    return results.map((r) => ({
      id: r.id,
      score: r.score,
      doc: { content: r.doc.content, metadata: r.doc.metadata },
    }));
  }
}
