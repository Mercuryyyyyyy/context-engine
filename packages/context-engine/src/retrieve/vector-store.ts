// 内存向量存储：存文档 embedding，支持暴力搜索

import { cosineSimilarity, type EmbedFn } from './embedder.js';

export interface VectorDoc {
  id: string;         // 文档 ID（如文件路径）
  content: string;    // 原始文本
  metadata?: Record<string, unknown>;  // 附加信息（如文件类型、行号范围）
}

interface IndexedDoc extends VectorDoc {
  embedding: Float32Array;
}

export class VectorStore {
  private docs: Map<string, IndexedDoc> = new Map();
  private embedFn: EmbedFn;

  constructor(embedFn: EmbedFn) {
    this.embedFn = embedFn;
  }

  // 添加单个文档（自动生成 embedding）
  async add(doc: VectorDoc): Promise<void> {
    const embedding = await this.embedFn(doc.content);
    this.docs.set(doc.id, { ...doc, embedding });
  }

  // 批量添加
  async addBatch(docs: VectorDoc[]): Promise<void> {
    // 先批量生成 embedding
    const texts = docs.map((d) => d.content);
    const embeddings: Float32Array[] = [];

    // 批量调用（每次最多 16 个，避免 API 限流）
    for (let i = 0; i < texts.length; i += 16) {
      const batch = texts.slice(i, i + 16);
      const results = await Promise.all(batch.map((t) => this.embedFn(t)));
      embeddings.push(...results);
    }

    for (let i = 0; i < docs.length; i++) {
      this.docs.set(docs[i]!.id, { ...docs[i]!, embedding: embeddings[i]! });
    }
  }

  // 删除文档
  remove(id: string): void {
    this.docs.delete(id);
  }

  // 清空
  clear(): void {
    this.docs.clear();
  }

  // 文档数
  get size(): number {
    return this.docs.size;
  }

  // 向量搜索：返回 top-K 结果
  async search(query: string, topK = 10): Promise<Array<{ id: string; score: number; doc: VectorDoc }>> {
    if (this.docs.size === 0) return [];

    const queryEmbedding = await this.embedFn(query);

    const results: Array<{ id: string; score: number; doc: VectorDoc }> = [];
    for (const [id, indexed] of this.docs) {
      const score = cosineSimilarity(queryEmbedding, indexed.embedding);
      results.push({ id, score, doc: { id: indexed.id, content: indexed.content, metadata: indexed.metadata } });
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, topK);
  }

  // 从已有 embedding 搜索（避免重复 embedding 查询）
  searchByEmbedding(queryEmbedding: Float32Array, topK = 10): Array<{ id: string; score: number; doc: VectorDoc }> {
    const results: Array<{ id: string; score: number; doc: VectorDoc }> = [];
    for (const [id, indexed] of this.docs) {
      const score = cosineSimilarity(queryEmbedding, indexed.embedding);
      results.push({ id, score, doc: { id: indexed.id, content: indexed.content, metadata: indexed.metadata } });
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, topK);
  }
}
