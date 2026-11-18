import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setupTestEnv, type TestEnv } from './helper.js';
import { claimNextJob, executeJob } from '../src/services/jobs.js';
import { getDb } from '../src/db/index.js';
import { replaceEntityChunks } from '../src/db/chunks.js';
import { matchFts5, sanitizeFtsQuery } from '../src/db/fts5.js';

describe('Search Service & Routes (Schema v2)', () => {
  let env: TestEnv;
  let token: string;

  beforeEach(async () => {
    env = setupTestEnv();

    await env.app.request('/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'carol@example.com',
        password: 'Password123!',
      }),
    });

    const login = await env.app.request('/auth/jwt/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'carol@example.com',
        password: 'Password123!',
      }),
    });
    const loginData = (await login.json()) as { access_token: string };
    token = loginData.access_token;

    // Create and index two notes via unified /resources/notes
    await env.app.request('/resources/notes', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        title: '向量检索原理',
        content: '密集向量检索使用深度神经网络模型提取文本特征，并通过余弦相似度或L2距离进行高维向量空间邻近搜索。',
        tags: ['ai', 'search'],
      }),
    });
    let j = claimNextJob();
    if (j) await executeJob(j);

    await env.app.request('/resources/notes', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        title: '全栈架构演进',
        content: '从FastAPI和Python技术栈平滑过渡到Hono与Node.js全栈TypeScript架构。',
        tags: ['architecture'],
      }),
    });
    j = claimNextJob();
    if (j) await executeJob(j);
  });

  afterEach(() => {
    env.cleanup();
  });

  it('performs hybrid search with SQLite chunks hydration and relational tag filtering', async () => {
    const searchResp = await env.app.request('/search', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        prompt: '向量检索 余弦相似度',
        window_size: 5,
      }),
    });

    expect(searchResp.status).toBe(200);
    const body = (await searchResp.json()) as {
      documents: Array<{ id: string; page_content: string; score: number; metadata: Record<string, unknown> }>;
      count: number;
    };
    expect(body.count).toBeGreaterThan(0);
    expect(body.documents[0]?.page_content).toContain('余弦相似度');
    expect(body.documents[0]?.score).toBeGreaterThan(0);
    expect(body.documents[0]?.metadata?.['id']).toBeDefined();

    // Tag filter should restrict results to matching entities via entity_tags
    const taggedResp = await env.app.request('/search', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        prompt: '架构 TypeScript',
        tags: ['architecture'],
        window_size: 5,
      }),
    });
    expect(taggedResp.status).toBe(200);
    const taggedBody = (await taggedResp.json()) as {
      documents: Array<{ page_content: string; metadata: { tag_matched?: boolean } }>;
      count: number;
    };
    expect(taggedBody.count).toBe(1);
    expect(taggedBody.documents[0]?.page_content).toContain('TypeScript');
    expect(taggedBody.documents[0]?.metadata?.tag_matched).toBe(true);
  });

  it('handles natural-language English queries and short-token LIKE fallback without stopword pollution', () => {
    const db = getDb();
    const userRow = db.prepare('SELECT id FROM users WHERE email = ?').get('carol@example.com') as { id: number };
    const userId = userRow.id;

    // Decoy resource inserted first with stopwords ("is", "an", "in", "to")
    replaceEntityChunks(db, userId, 'resource', 101, [
      {
        id: 'decoy-1',
        user_id: userId,
        entity_type: 'resource',
        entity_id: 101,
        resource_type: 'file',
        chunk_order: 0,
        page_number: 1,
        header_path: '',
        title: 'General Intro',
        source: 'intro.md',
        content: 'This is an overview in general software engineering and AI practice.',
      },
    ]);

    replaceEntityChunks(db, userId, 'resource', 102, [
      {
        id: 'target-1',
        user_id: userId,
        entity_type: 'resource',
        entity_id: 102,
        resource_type: 'file',
        chunk_order: 0,
        page_number: 1,
        header_path: '',
        title: 'Inverter Grids Paper',
        source: 'grids.md',
        content: 'Estimating output impedance challenges in inverter-based grids with Go and AI agents.',
      },
    ]);

    const ftsQuery = sanitizeFtsQuery(
      'What are the challenges in estimating output impedance in inverter-based grids?'
    );
    expect(ftsQuery).not.toContain('"in"');
    expect(ftsQuery).not.toContain('"What"');
    expect(ftsQuery).toContain('"challenges"');

    const nlHits = matchFts5(
      db,
      'What are the challenges in estimating output impedance in inverter-based grids?',
      { userId, limit: 5 }
    );
    expect(nlHits.length).toBeGreaterThan(0);
    expect(nlHits[0]?.entity_id).toBe(102);

    // <3-char ASCII query falls back to LIKE ordered by matched term count
    const shortHits = matchFts5(db, 'AI Go', { userId, limit: 5 });
    expect(shortHits.length).toBe(2);
    expect(shortHits[0]?.entity_id).toBe(102);
  });
});
