// API Embedding：调用 OpenAI 兼容的 embeddings 端点
// 支持 OpenAI text-embedding-3-small、智谱、通义等兼容 API

export interface EmbedderConfig {
  apiKey: string;
  baseURL: string;    // 如 https://api.openai.com
  model: string;      // 如 text-embedding-3-small
}

export type EmbedFn = (text: string) => Promise<Float32Array>;

// 默认 embedding 实现：调 OpenAI 兼容 API
export function createEmbedder(config: EmbedderConfig): EmbedFn {
  return async (text: string): Promise<Float32Array> => {
    // 截断超长文本（大多数 API 限制 8192 token）
    const truncated = text.slice(0, 32000);

    const resp = await fetch(`${config.baseURL}/v1/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        input: truncated,
      }),
    });

    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      throw new Error(`Embedding API error ${resp.status}: ${errText.slice(0, 200)}`);
    }

    const data = (await resp.json()) as {
      data?: Array<{ embedding?: number[] }>;
    };
    const embedding = data.data?.[0]?.embedding;
    if (!embedding || embedding.length === 0) {
      throw new Error('Embedding API returned empty embedding');
    }

    return Float32Array.from(embedding);
  };
}

// 批量 embedding（减少 API 调用次数）
export async function embedBatch(
  texts: string[],
  embedFn: EmbedFn,
  batchSize = 16
): Promise<Float32Array[]> {
  const results: Float32Array[] = [];
  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);
    const embeddings = await Promise.all(batch.map((t) => embedFn(t)));
    results.push(...embeddings);
  }
  return results;
}

// 余弦相似度（假设向量已归一化则等价于点积）
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}
