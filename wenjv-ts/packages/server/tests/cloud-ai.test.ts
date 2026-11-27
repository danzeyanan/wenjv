import { afterEach, describe, expect, it, vi } from 'vitest';
import { RemoteEmbedder } from '../src/ai/bge-m3.js';
import { RemoteReranker } from '../src/ai/reranker.js';
import { SigLIP2Engine } from '../src/ai/siglip2.js';

describe('Cloud-lite AI providers', () => {
  const origEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...origEnv };
    vi.restoreAllMocks();
  });

  it('RemoteEmbedder calls OpenAI-compatible /embeddings and returns sorted vectors', async () => {
    process.env['EMBEDDING_API_BASE'] = 'https://api.example.com/v1';
    process.env['EMBEDDING_API_KEY'] = 'test-key';
    process.env['EMBEDDINGS_MODEL'] = 'BAAI/bge-m3';

    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          data: [
            { index: 1, embedding: [0.2, 0.3] },
            { index: 0, embedding: [0.1, 0.4] },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    );

    const embedder = new RemoteEmbedder();
    const vectors = await embedder.embed(['hello', 'world']);
    expect(vectors).toEqual([
      [0.1, 0.4],
      [0.2, 0.3],
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://api.example.com/v1/embeddings');
  });

  it('RemoteEmbedder throws clear error when EMBEDDING_API_KEY is missing', async () => {
    process.env['EMBEDDING_API_KEY'] = '';
    process.env['WENJV_STRICT_CLOUD_KEY'] = '1';

    const embedder = new RemoteEmbedder();
    await expect(embedder.embed(['hello'])).rejects.toThrow('EMBEDDING_API_KEY');
  });

  it('RemoteReranker falls back to passthrough order when RERANK_API_KEY is empty', async () => {
    process.env['RERANK_API_KEY'] = '';

    const reranker = new RemoteReranker();
    const res = await reranker.rerank('q', ['docA', 'docB', 'docC'], 2);
    expect(res.map((r) => r.index)).toEqual([0, 1]);
  });

  it('RemoteReranker calls /rerank and sorts by relevance_score', async () => {
    process.env['RERANK_ENABLED'] = 'true';
    process.env['RERANK_PROVIDER'] = 'openai';
    process.env['RERANK_API_BASE'] = 'https://api.example.com/v1';
    process.env['RERANK_API_KEY'] = 'test-rerank-key';
    process.env['RERANK_MODEL'] = 'BAAI/bge-reranker-v2-m3';

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          results: [
            { index: 0, relevance_score: 0.2 },
            { index: 1, relevance_score: 0.9 },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    );

    const reranker = new RemoteReranker();
    const res = await reranker.rerank('q', ['docA', 'docB'], 2);
    expect(res).toEqual([
      { index: 1, score: 0.9, relevanceScore: 0.9 },
      { index: 0, score: 0.2, relevanceScore: 0.2 },
    ]);
  });

  it('SigLIP2Engine stub disables vision without onnxruntime', async () => {
    const engine = new SigLIP2Engine();
    expect(engine.isVisionSupported()).toBe(false);
    const vec = await engine.embedImage(Buffer.from('fake'));
    expect(vec).toHaveLength(768);
  });
});
