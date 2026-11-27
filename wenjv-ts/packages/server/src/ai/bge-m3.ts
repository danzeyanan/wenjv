import { loadConfig } from '../config.js';

export const BGE_M3_DIM = 1024;

/**
 * 纯云端 OpenAI 兼容 `/v1/embeddings` 客户端（无本地 ONNX 依赖）。
 */
export class RemoteEmbedder {
  async init(): Promise<void> {
    // 远端 HTTP 模式无需本地模型预加载
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const cfg = loadConfig();
    if (!cfg.EMBEDDING_API_KEY) {
      if (process.env['NODE_ENV'] === 'test' && process.env['WENJV_STRICT_CLOUD_KEY'] !== '1') {
        return texts.map(() => new Array(BGE_M3_DIM).fill(0.01));
      }
      throw new Error(
        'Cloud-lite 模式需要配置 EMBEDDING_API_KEY（以及 EMBEDDING_API_BASE / EMBEDDINGS_MODEL）以调用远端 Embedding 接口'
      );
    }

    const base = cfg.EMBEDDING_API_BASE.replace(/\/+$/, '');
    const url = `${base}/embeddings`;
    const batchSize = 32;
    const allVectors: number[][] = [];

    for (let i = 0; i < texts.length; i += batchSize) {
      const batch = texts.slice(i, i + batchSize);
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${cfg.EMBEDDING_API_KEY}`,
        },
        body: JSON.stringify({
          model: cfg.EMBEDDINGS_MODEL,
          input: batch,
        }),
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        throw new Error(`Embedding API 请求失败 (${res.status}): ${errText.slice(0, 300)}`);
      }

      const data = (await res.json()) as {
        data?: Array<{ index: number; embedding: number[] }>;
      };
      const items = (data.data ?? []).slice().sort((a, b) => a.index - b.index);
      if (items.length !== batch.length) {
        throw new Error(`Embedding API 返回数量不匹配: 期望 ${batch.length}, 实际 ${items.length}`);
      }
      for (const item of items) {
        allVectors.push(item.embedding);
      }
    }

    return allVectors;
  }

  async embedOne(text: string): Promise<number[]> {
    const [vec] = await this.embed([text]);
    return vec ?? new Array(BGE_M3_DIM).fill(0);
  }

  async embedDocuments(texts: string[]): Promise<number[][]> {
    return this.embed(texts);
  }

  async embedQuery(text: string): Promise<number[]> {
    return this.embedOne(text);
  }
}

export { RemoteEmbedder as BGEM3Embedder };

let _embedder: RemoteEmbedder | null = null;

export function getEmbedder(): RemoteEmbedder {
  if (!_embedder) {
    _embedder = new RemoteEmbedder();
  }
  return _embedder;
}
