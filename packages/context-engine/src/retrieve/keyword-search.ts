// 简单 TF-IDF 关键词检索（零依赖实现）
// 不引入 wink-bm25 等库，用简化版 TF-IDF 做精确匹配补充

import { countTokens } from '../tokenize.js';

export interface KeywordDoc {
  id: string;
  content: string;
  metadata?: Record<string, unknown>;
}

// 简单分词：按非字母数字分割，转小写，过滤停用词和短词
const STOP_WORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'must', 'can', 'this', 'that', 'these',
  'those', 'i', 'you', 'he', 'she', 'it', 'we', 'they', 'what', 'which',
  'who', 'when', 'where', 'why', 'how', 'all', 'each', 'every', 'some',
  'any', 'no', 'not', 'as', 'of', 'at', 'by', 'for', 'with', 'about',
  'to', 'from', 'in', 'on', 'or', 'and', 'but', 'if', 'then', 'else',
  '的', '了', '在', '是', '我', '有', '和', '就', '不', '人', '都', '一',
  '一个', '上', '也', '很', '到', '说', '要', '去', '你', '会', '着', '没有',
  '看', '好', '自己', '这',
]);

function tokenize(text: string): string[] {
  // 按非字母数字（含中文）分割
  // 中文按字符分，英文按单词分
  const tokens: string[] = [];

  // 英文单词
  const englishWords = text.toLowerCase().match(/[a-z][a-z0-9_]*/g) || [];
  for (const word of englishWords) {
    if (word.length >= 2 && !STOP_WORDS.has(word)) {
      tokens.push(word);
    }
  }

  // 中文按双字符滑窗（简化分词）
  const chineseChars = text.match(/[\u4e00-\u9fa5]+/g) || [];
  for (const segment of chineseChars) {
    if (segment.length <= 2) {
      if (!STOP_WORDS.has(segment)) tokens.push(segment);
    } else {
      // 双字符滑窗
      for (let i = 0; i < segment.length - 1; i++) {
        const bigram = segment.slice(i, i + 2);
        if (!STOP_WORDS.has(bigram)) tokens.push(bigram);
      }
    }
  }

  // 代码符号：驼峰分割
  const camelSplit = text.match(/[a-z]+[A-Z][a-z]+/g) || [];
  for (const word of camelSplit) {
    const parts = word.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().split(' ');
    for (const p of parts) {
      if (p.length >= 2 && !STOP_WORDS.has(p)) tokens.push(p);
    }
  }

  return tokens;
}

// TF-IDF 索引
export class KeywordIndex {
  private docs: Map<string, { doc: KeywordDoc; tokens: string[]; tokenFreq: Map<string, number> }> = new Map();
  private df: Map<string, number> = new Map(); // 文档频率
  private totalDocs = 0;

  add(doc: KeywordDoc): void {
    const tokens = tokenize(doc.content);
    const tokenFreq = new Map<string, number>();

    for (const token of tokens) {
      tokenFreq.set(token, (tokenFreq.get(token) || 0) + 1);
    }

    // 更新 DF
    for (const token of tokenFreq.keys()) {
      this.df.set(token, (this.df.get(token) || 0) + 1);
    }

    this.totalDocs++;
    this.docs.set(doc.id, { doc, tokens, tokenFreq });
  }

  remove(id: string): void {
    const entry = this.docs.get(id);
    if (!entry) return;

    // 更新 DF
    for (const token of entry.tokenFreq.keys()) {
      const count = this.df.get(token);
      if (count !== undefined) {
        if (count <= 1) this.df.delete(token);
        else this.df.set(token, count - 1);
      }
    }

    this.totalDocs--;
    this.docs.delete(id);
  }

  clear(): void {
    this.docs.clear();
    this.df.clear();
    this.totalDocs = 0;
  }

  get size(): number {
    return this.docs.size;
  }

  // TF-IDF 搜索
  search(query: string, topK = 10): Array<{ id: string; score: number; doc: KeywordDoc }> {
    if (this.docs.size === 0) return [];

    const queryTokens = [...new Set(tokenize(query))];
    if (queryTokens.length === 0) return [];

    const results: Array<{ id: string; score: number; doc: KeywordDoc }> = [];
    const avgDocLength = Array.from(this.docs.values())
      .reduce((sum, entry) => sum + entry.tokens.length, 0) / Math.max(this.totalDocs, 1);
    const k1 = 1.2;
    const b = 0.75;

    for (const [id, entry] of this.docs) {
      let score = 0;

      for (const qToken of queryTokens) {
        const tf = entry.tokenFreq.get(qToken);
        if (!tf) continue;

        // BM25 风格平滑 IDF：常见但有区分力的领域词不再退化为 0 分。
        const df = this.df.get(qToken) || 0;
        const idfScore = df > 0
          ? Math.log(1 + (this.totalDocs - df + 0.5) / (df + 0.5))
          : 0;
        const lengthNorm = 1 - b + b * (entry.tokens.length / Math.max(avgDocLength, 1));
        const tfScore = (tf * (k1 + 1)) / (tf + k1 * lengthNorm);
        score += tfScore * idfScore;
      }

      // 按 query 维度归一化，便于不同长度 query 使用统一 minScore。
      score /= queryTokens.length;

      if (score > 0) {
        results.push({ id, score, doc: entry.doc });
      }
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, topK);
  }
}
