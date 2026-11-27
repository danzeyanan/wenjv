import { loadConfig } from '../config.js';

export interface RerankResult {
  index: number;
  score: number;
  relevanceScore: number;
}

/**
 * 纯云端 `/v1/rerank` 客户端（兼容 SiliconFlow / Jina / Cohere 协议）。
 * 若未启用或未配置 RERANK_API_KEY，则按原顺序透传（fail-open）。
 */
export class RemoteReranker {
  async init(): Promise<void> {
    // 远端 HTTP 模式无需本地模型预加载
  }

  async rerank(query: string, documents: string[], topK?: number): Promise<RerankResult[]> {
    if (documents.length === 0) return [];
    const limit = topK ?? documents.length;
    const cfg = loadConfig();

    if (!cfg.RERANK_ENABLED || cfg.RERANK_PROVIDER === 'none' || !cfg.RERANK_API_KEY) {
      return documents.slice(0, limit).map((_, idx) => {
        const s = 1 - idx * 0.001;
        return { index: idx, score: s, relevanceScore: s };
      });
    }

    const base = cfg.RERANK_API_BASE.replace(/\/+$/, '');
    const url = `${base}/rerank`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.RERANK_API_KEY}`,
      },
      body: JSON.stringify({
        model: cfg.RERANK_MODEL,
        query,
        documents,
        top_n: limit,
      }),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Rerank API 请求失败 (${res.status}): ${errText.slice(0, 300)}`);
    }

    const data = (await res.json()) as {
      results?: Array<{ index: number; relevance_score: number }>;
    };
    const results = (data.results ?? []).map((r) => ({
      index: r.index,
      score: r.relevance_score,
      relevanceScore: r.relevance_score,
    }));
    results.sort((a, b) => b.score - a.score);
    return results.slice(0, limit);
  }
}

export { RemoteReranker as BGEReranker };

let _reranker: RemoteReranker | null = null;

export function getReranker(): RemoteReranker {
  if (!_reranker) {
    _reranker = new RemoteReranker();
  }
  return _reranker;
}
