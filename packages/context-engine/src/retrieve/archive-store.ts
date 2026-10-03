// 归档存储：存储已归档模块的完整消息内容，支持检索
// 借鉴 MemGPT archival memory + Aider Repo Map 思路：
// - 归档时按消息粒度建立关键词索引（BM25）
// - 可选建立向量索引（需 embedFn）
// - 检索返回 RetrievedContext[]，与 engine.ts 的 retrieval hook 兼容
// - 检索结果只包含已归档内容，不包含近期窗口，避免跨主题误命中

import type { Message, RetrievedContext } from '../types.js';
import type { ModuleInfo } from './module-tracker.js';
import { KeywordIndex } from './keyword-search.js';
import { VectorStore, type VectorDoc } from './vector-store.js';
import { reciprocalRankFusion, type SearchHit } from './hybrid-search.js';
import type { EmbedFn } from './embedder.js';

export interface ArchivedMessage {
  moduleId: string;
  moduleSummary: string;
  startTurn: number;
  endTurn: number;
  messageIndex: number;   // 在原 history 中的索引
  role: string;
  content: string;
}

export interface ArchiveSearchOptions {
  topK?: number;
  minScore?: number;
  // 限定模块 id（可选，只搜特定模块）
  moduleIds?: string[];
}

export class ArchiveStore {
  private keywordIndex: KeywordIndex = new KeywordIndex();
  private vectorStore: VectorStore | null = null;
  private embedFn: EmbedFn | null = null;
  private messages: Map<string, ArchivedMessage> = new Map();  // docId → ArchivedMessage
  private moduleIds: Set<string> = new Set();

  constructor(embedFn?: EmbedFn) {
    if (embedFn) {
      this.embedFn = embedFn;
      this.vectorStore = new VectorStore(embedFn);
    }
  }

  /**
   * 归档一个模块的完整消息内容
   * @param module 模块信息（来自 ModuleTracker）
   * @param messages 该模块包含的所有消息（从 history 中提取）
   */
  async archive(module: ModuleInfo, messages: Message[]): Promise<void> {
    this.moduleIds.add(module.id);

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i]!;
      if (!module.messageIndices.includes(i)) continue;  // 只归档属于该模块的消息
      const content = typeof msg.content === 'string'
        ? msg.content
        : msg.content.map((p) => p.text).join('');
      if (!content.trim()) continue;

      const docId = `${module.id}-msg-${i}`;
      const archived: ArchivedMessage = {
        moduleId: module.id,
        moduleSummary: module.summary ?? '',
        startTurn: module.startTurn,
        endTurn: module.lastReferencedTurn,
        messageIndex: i,
        role: msg.role,
        content,
      };
      this.messages.set(docId, archived);

      // 关键词索引
      this.keywordIndex.add({
        id: docId,
        content,
        metadata: { moduleId: module.id, role: msg.role, turn: module.startTurn },
      });

      // 向量索引（可选）
      if (this.vectorStore && this.embedFn) {
        const vecDoc: VectorDoc = {
          id: docId,
          content,
          metadata: { moduleId: module.id, role: msg.role, turn: module.startTurn },
        };
        await this.vectorStore.add(vecDoc);
      }
    }
  }

  /**
   * 关键词检索（BM25）
   */
  searchKeyword(query: string, options?: ArchiveSearchOptions): RetrievedContext[] {
    const topK = options?.topK ?? 6;
    const minScore = options?.minScore ?? 0;
    const results = this.keywordIndex.search(query, topK * 2);  // 多取一些用于过滤

    return results
      .filter((r) => {
        if (options?.moduleIds && !options.moduleIds.includes(r.doc.metadata?.moduleId as string)) {
          return false;
        }
        return r.score >= minScore;
      })
      .slice(0, topK)
      .map((r) => {
        const archived = this.messages.get(r.id);
        return {
          id: r.id,
          content: archived?.content ?? r.doc.content,
          score: r.score,
          metadata: {
            moduleId: r.doc.metadata?.moduleId,
            role: r.doc.metadata?.role,
            turn: r.doc.metadata?.turn,
            moduleSummary: archived?.moduleSummary,
            source: 'archive-keyword',
          },
        };
      });
  }

  /**
   * 向量检索（需要 embedFn）
   */
  async searchVector(query: string, options?: ArchiveSearchOptions): Promise<RetrievedContext[]> {
    if (!this.vectorStore) return [];
    const topK = options?.topK ?? 6;
    const minScore = options?.minScore ?? 0;
    const results = await this.vectorStore.search(query, topK * 2);

    return results
      .filter((r) => {
        if (options?.moduleIds && !options.moduleIds.includes(r.doc.metadata?.moduleId as string)) {
          return false;
        }
        return r.score >= minScore;
      })
      .slice(0, topK)
      .map((r) => {
        const archived = this.messages.get(r.id);
        return {
          id: r.id,
          content: archived?.content ?? r.doc.content,
          score: r.score,
          metadata: {
            moduleId: r.doc.metadata?.moduleId,
            role: r.doc.metadata?.role,
            turn: r.doc.metadata?.turn,
            moduleSummary: archived?.moduleSummary,
            source: 'archive-vector',
          },
        };
      });
  }

  /**
   * 混合检索（关键词 + 向量 + RRF 融合）
   * 如果没有 embedFn，退化为纯关键词检索
   */
  async searchHybrid(query: string, options?: ArchiveSearchOptions): Promise<RetrievedContext[]> {
    if (!this.vectorStore) {
      return this.searchKeyword(query, options);
    }

    const topK = options?.topK ?? 6;
    const keywordResults = this.searchKeyword(query, { ...options, topK: topK * 2 });
    const vectorResults = await this.searchVector(query, { ...options, topK: topK * 2 });

    // 转换为 SearchHit 格式
    const keywordHits: SearchHit[] = keywordResults.map((r) => ({
      id: r.id,
      score: r.score ?? 0,
      doc: { content: r.content, metadata: r.metadata },
    }));
    const vectorHits: SearchHit[] = vectorResults.map((r) => ({
      id: r.id,
      score: r.score ?? 0,
      doc: { content: r.content, metadata: r.metadata },
    }));

    // RRF 融合
    const fused = reciprocalRankFusion([keywordHits, vectorHits], { topK });

    return fused.map((hit) => ({
      id: hit.id,
      content: hit.doc?.content ?? '',
      score: hit.score,
      metadata: {
        ...hit.doc?.metadata,
        source: 'archive-hybrid',
      },
    }));
  }

  /**
   * 默认检索方法（兼容 RetrievalOptions.search 接口）
   * 有 embedFn 时用混合检索，否则用关键词检索
   */
  async search(query: string, topK: number): Promise<RetrievedContext[]> {
    if (this.vectorStore) {
      return this.searchHybrid(query, { topK });
    }
    return this.searchKeyword(query, { topK });
  }

  /**
   * 获取指定模块的所有归档消息
   */
  getModuleMessages(moduleId: string): ArchivedMessage[] {
    return Array.from(this.messages.values())
      .filter((m) => m.moduleId === moduleId)
      .sort((a, b) => a.messageIndex - b.messageIndex);
  }

  /**
   * 获取所有已归档模块 id
   */
  getArchivedModuleIds(): string[] {
    return Array.from(this.moduleIds);
  }

  /**
   * 获取归档消息总数
   */
  get size(): number {
    return this.messages.size;
  }

  /**
   * 获取已归档模块数
   */
  get moduleCount(): number {
    return this.moduleIds.size;
  }

  /**
   * 清空
   */
  clear(): void {
    this.keywordIndex.clear();
    this.vectorStore?.clear();
    this.messages.clear();
    this.moduleIds.clear();
  }
}
