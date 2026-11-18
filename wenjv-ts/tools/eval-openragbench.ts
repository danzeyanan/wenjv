import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const DATA_DIR = path.join(REPO_ROOT, 'eval', 'eval', 'open_ragbench_data');
const EVAL_BASE_DIR = process.env['EVAL_BASE_DIR'] || '/tmp/wenjv_eval_55_ts';
const SENTINEL_PATH = path.join(EVAL_BASE_DIR, 'indexed_v1.json');

// Configure isolated runtime before importing server modules
process.env['WENJV_BASE_DIR'] = EVAL_BASE_DIR;
process.env['JWT_SECRET'] = 'openragbench-eval-secret-key-32-chars-ok';
process.env['MODELS_DIR'] = path.join(REPO_ROOT, 'models');
process.env['RERANK_ENABLED'] = 'true';

interface ArxivSection {
  section_id?: number | string;
  text?: string;
  tables?: Record<string, string>;
  images?: Record<string, string>;
}

interface ArxivPaper {
  id?: string;
  title?: string;
  abstract?: string;
  sections?: ArxivSection[];
}

interface QueryEntry {
  query: string;
  type?: string;
  source: string;
}

interface QrelEntry {
  doc_id: string;
  section_id?: number;
}

interface EvalStats {
  count: number;
  recallAt5: number;
  mrrAt5: number;
  hits: number;
}

function buildPaperMarkdown(docId: string, paper: ArxivPaper): string {
  const title = (paper.title || docId).trim();
  const parts: string[] = [`# ${title}`];
  if (paper.abstract?.trim()) {
    parts.push(`## Abstract\n\n${paper.abstract.trim()}`);
  }
  const sections = Array.isArray(paper.sections) ? paper.sections : [];
  for (let i = 0; i < sections.length; i++) {
    const sec = sections[i]!;
    const secHeader = `## Section ${i + 1}`;
    const secBody: string[] = [];
    if (sec.text?.trim()) {
      secBody.push(sec.text.trim());
    }
    if (sec.tables && typeof sec.tables === 'object') {
      for (const [tblName, tblMd] of Object.entries(sec.tables)) {
        if (tblMd?.trim()) {
          secBody.push(`### Table ${tblName}\n\n${tblMd.trim()}`);
        }
      }
    }
    if (secBody.length > 0) {
      parts.push(`${secHeader}\n\n${secBody.join('\n\n')}`);
    }
  }
  return parts.join('\n\n');
}

function summarizeMetrics(
  records: Array<{ source: string; hitRank: number | null }>
): Record<string, EvalStats> {
  const grouped = new Map<string, Array<number | null>>();
  for (const r of records) {
    const arr = grouped.get(r.source) ?? [];
    arr.push(r.hitRank);
    grouped.set(r.source, arr);
  }

  const out: Record<string, EvalStats> = {};
  for (const [source, ranks] of Array.from(grouped.entries()).sort()) {
    const hits = ranks.filter((r) => r !== null).length;
    const mrrSum = ranks.reduce((acc, r) => acc + (r ? 1 / r : 0), 0);
    out[source] = {
      count: ranks.length,
      hits,
      recallAt5: hits / Math.max(1, ranks.length),
      mrrAt5: mrrSum / Math.max(1, ranks.length),
    };
  }
  const totalHits = records.filter((r) => r.hitRank !== null).length;
  const totalMrr = records.reduce((acc, r) => acc + (r.hitRank ? 1 / r.hitRank : 0), 0);
  out['overall'] = {
    count: records.length,
    hits: totalHits,
    recallAt5: totalHits / Math.max(1, records.length),
    mrrAt5: totalMrr / Math.max(1, records.length),
  };
  return out;
}

async function main(): Promise<void> {
  const reindex = process.argv.includes('--reindex');
  if (reindex && fs.existsSync(EVAL_BASE_DIR)) {
    fs.rmSync(EVAL_BASE_DIR, { recursive: true, force: true });
  }
  fs.mkdirSync(EVAL_BASE_DIR, { recursive: true });

  const { getDb, initTables, closeDb } = await import('../packages/server/src/db/index.js');
  const { replaceEntityChunks, getChunksByIds } = await import('../packages/server/src/db/chunks.js');
  const { matchFts5 } = await import('../packages/server/src/db/fts5.js');
  const { structureAwareChunk, RecursiveTextSplitter } = await import(
    '../packages/server/src/chunker/structure.js'
  );
  const { getEmbedder } = await import('../packages/server/src/ai/bge-m3.js');
  const { getReranker } = await import('../packages/server/src/ai/reranker.js');
  const { getTextStore } = await import('../packages/server/src/vector/text-store.js');
  const { searchDocuments } = await import('../packages/server/src/services/search.js');

  const docIds = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'picked_docs.json'), 'utf8')) as string[];
  const qids = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'picked_qids.json'), 'utf8')) as string[];
  const queries = JSON.parse(
    fs.readFileSync(path.join(DATA_DIR, 'pdf', 'arxiv', 'queries.json'), 'utf8')
  ) as Record<string, QueryEntry>;
  const qrels = JSON.parse(
    fs.readFileSync(path.join(DATA_DIR, 'pdf', 'arxiv', 'qrels.json'), 'utf8')
  ) as Record<string, QrelEntry>;

  const db = getDb();
  initTables(db);

  // Ensure eval user exists
  const evalEmail = 'eval@openragbench.org';
  let userRow = db.prepare('SELECT id FROM users WHERE email = ?').get(evalEmail) as
    | { id: number }
    | undefined;
  if (!userRow) {
    const res = db
      .prepare('INSERT INTO users(email, username, hashed_password, is_active, is_verified) VALUES (?, ?, ?, 1, 1)')
      .run(evalEmail, 'openragbench_eval', 'disabled-eval-hash');
    userRow = { id: Number(res.lastInsertRowid) };
  }
  const userId = userRow.id;

  const embedder = getEmbedder();
  await embedder.init();
  const textStore = getTextStore();
  await textStore.init();
  const reranker = getReranker();
  await reranker.init();

  let docToResourceId: Record<string, number> = {};
  let totalChunks = 0;

  if (fs.existsSync(SENTINEL_PATH) && !reindex) {
    const cached = JSON.parse(fs.readFileSync(SENTINEL_PATH, 'utf8')) as {
      docToResourceId: Record<string, number>;
      totalChunks: number;
    };
    docToResourceId = cached.docToResourceId;
    totalChunks = cached.totalChunks;
    console.log(`[1/3] Reusing existing TS index (${Object.keys(docToResourceId).length} docs, ${totalChunks} chunks)`);
  } else {
    console.log(`[1/3] Indexing ${docIds.length} ArXiv papers with TS structureAwareChunk + BGE-M3 ONNX...`);
    const tIngest = Date.now();
    const splitter = new RecursiveTextSplitter({ chunkSize: 1000, chunkOverlap: 150 });

    const insertResStmt = db.prepare(`
      INSERT INTO resources(user_id, type, title, filename, original_filename, content_type, status)
      VALUES (?, 'file', ?, ?, ?, 'text/markdown', 'finished')
    `);

    for (let dIdx = 0; dIdx < docIds.length; dIdx++) {
      const docId = docIds[dIdx]!;
      const corpusPath = path.join(DATA_DIR, 'pdf', 'arxiv', 'corpus', `${docId}.json`);
      const paper = JSON.parse(fs.readFileSync(corpusPath, 'utf8')) as ArxivPaper;
      const title = (paper.title || docId).trim();
      const markdown = buildPaperMarkdown(docId, paper);

      const resInfo = insertResStmt.run(userId, title, `${docId}.md`, `${docId}.md`);
      const resourceId = Number(resInfo.lastInsertRowid);
      docToResourceId[docId] = resourceId;

      const chunks = structureAwareChunk(markdown, splitter);
      const texts = chunks.map((c) => c.indexing_text);
      const vectors = await embedder.embedDocuments(texts);

      const chunkRows = [];
      const vectorRows = [];
      for (let i = 0; i < chunks.length; i++) {
        const c = chunks[i]!;
        const chunkId = crypto
          .createHash('sha256')
          .update(`resource:${resourceId}:${c.header_str}:${i}:${c.indexing_text.slice(0, 64)}`)
          .digest('hex')
          .slice(0, 32);
        chunkRows.push({
          id: chunkId,
          user_id: userId,
          entity_type: 'resource' as const,
          entity_id: resourceId,
          resource_type: 'file' as const,
          chunk_order: i,
          page_number: c.page_number || 1,
          header_path: c.header_str || '',
          title,
          source: `${docId}.md`,
          content: c.indexing_text,
        });
        vectorRows.push({
          id: chunkId,
          vector: vectors[i]!,
          user_id: userId,
          entity_type: 'resource' as const,
          entity_id: resourceId,
          resource_type: 'file' as const,
        });
      }
      replaceEntityChunks(db, userId, 'resource', resourceId, chunkRows);
      await textStore.addVectors(vectorRows);
      totalChunks += chunks.length;

      if ((dIdx + 1) % 10 === 0 || dIdx + 1 === docIds.length) {
        const elapsed = ((Date.now() - tIngest) / 1000).toFixed(1);
        console.log(`  Indexed ${dIdx + 1}/${docIds.length} docs (${totalChunks} chunks) in ${elapsed}s`);
      }
    }

    fs.writeFileSync(
      SENTINEL_PATH,
      JSON.stringify({ docToResourceId, totalChunks }, null, 2),
      'utf8'
    );
  }

  // Evaluate 1: Actual production searchDocuments() (RRF k=60, 1:1 + BGE-Reranker ON)
  console.log(`\n[2/3] Evaluating production TS searchDocuments() on ${qids.length} queries...`);
  db.prepare('DELETE FROM query_result_cache').run();
  const prodRecords: Array<{ source: string; hitRank: number | null; qid: string }> = [];
  const tProd = Date.now();

  for (let i = 0; i < qids.length; i++) {
    const qid = qids[i]!;
    const q = queries[qid]!;
    const rel = qrels[qid]!;
    const goldResourceId = String(docToResourceId[rel.doc_id]);

    const hits = await searchDocuments({
      prompt: q.query,
      userId,
      userEmail: evalEmail,
      windowSize: 5,
    });

    let hitRank: number | null = null;
    for (let r = 0; r < Math.min(5, hits.length); r++) {
      if (String(hits[r]!.metadata.resource_id || '') === goldResourceId) {
        hitRank = r + 1;
        break;
      }
    }
    prodRecords.push({ source: q.source, hitRank, qid });
  }
  const prodSec = (Date.now() - tProd) / 1000;

  // Evaluate 2: Controlled ablation on the exact same candidates:
  // (a) RRF k=60 (1:1) no rerank
  // (b) RRF k=5 (vec=1.0, kw=0.8) no rerank
  // (c) RRF k=5 (vec=1.0, kw=0.8) + BGE-Reranker
  console.log('[3/3] Running RRF parameter ablation (k=60 vs k=5, w_kw=0.8) & rerank ablation...');
  const k60NoRerank: Array<{ source: string; hitRank: number | null }> = [];
  const k5NoRerank: Array<{ source: string; hitRank: number | null }> = [];
  const k5Rerank: Array<{ source: string; hitRank: number | null }> = [];

  for (const qid of qids) {
    const q = queries[qid]!;
    const rel = qrels[qid]!;
    const goldResourceId = String(docToResourceId[rel.doc_id]);

    const ftsRows = matchFts5(db, q.query, { userId, limit: 50 });
    const qVec = await embedder.embedQuery(q.query);
    const vecRows = await textStore.search(qVec, { userId, limit: 50 });
    const chunkMap = getChunksByIds(
      db,
      vecRows.map((v) => v.id),
      userId
    );

    const scoreRrf = (k: number, wVec: number, wKw: number) => {
      const m = new Map<string, { score: number; content: string; resourceId: string }>();
      ftsRows.forEach((row, rank) => {
        const s = wKw * (1.0 / (k + rank + 1));
        const prev = m.get(row.chunk_id);
        if (prev) prev.score += s;
        else m.set(row.chunk_id, { score: s, content: row.content, resourceId: String(row.entity_id) });
      });
      vecRows.forEach((vRow, rank) => {
        const ch = chunkMap.get(vRow.id);
        if (!ch) return;
        const s = wVec * (1.0 / (k + rank + 1));
        const prev = m.get(ch.id);
        if (prev) prev.score += s;
        else m.set(ch.id, { score: s, content: ch.content, resourceId: String(ch.entity_id) });
      });
      return Array.from(m.entries())
        .map(([id, val]) => ({ id, ...val }))
        .sort((a, b) => b.score - a.score);
    };

    const firstHitRank = (list: Array<{ resourceId: string }>): number | null => {
      for (let r = 0; r < Math.min(5, list.length); r++) {
        if (list[r]!.resourceId === goldResourceId) return r + 1;
      }
      return null;
    };

    const list60 = scoreRrf(60, 1.0, 1.0);
    const list5 = scoreRrf(5, 1.0, 0.8);
    k60NoRerank.push({ source: q.source, hitRank: firstHitRank(list60) });
    k5NoRerank.push({ source: q.source, hitRank: firstHitRank(list5) });

    const top30 = list5.slice(0, 30);
    if (top30.length > 0) {
      const rr = await reranker.rerank(
        q.query,
        top30.map((c) => c.content)
      );
      const reranked = rr.map((item) => top30[item.index]!).filter(Boolean);
      k5Rerank.push({ source: q.source, hitRank: firstHitRank(reranked) });
    } else {
      k5Rerank.push({ source: q.source, hitRank: null });
    }
  }

  const report = {
    corpus: { docs: docIds.length, chunks: totalChunks, queries: qids.length },
    ts_prod_k60_rerank: { latencyTotalSec: Number(prodSec.toFixed(2)), metrics: summarizeMetrics(prodRecords) },
    ts_k60_no_rerank: { metrics: summarizeMetrics(k60NoRerank) },
    ts_k5_wkw08_no_rerank: { metrics: summarizeMetrics(k5NoRerank) },
    ts_k5_wkw08_rerank: { metrics: summarizeMetrics(k5Rerank) },
    misses_ts_prod: prodRecords.filter((r) => r.hitRank === null).map((r) => ({ qid: r.qid, source: r.source })),
  };

  fs.writeFileSync(path.join(EVAL_BASE_DIR, 'report.json'), JSON.stringify(report, null, 2), 'utf8');
  console.log('\n=== WENJV-TS OPEN RAGBENCH 55-QUERY RETRIEVAL RESULTS ===');
  console.log(JSON.stringify(report, null, 2));

  closeDb();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
