import type Database from 'better-sqlite3';
import type { ChunkEntityType, ChunkResourceType } from './chunks.js';

export interface EntityFilterRef {
  entity_type: ChunkEntityType;
  entity_id: number;
}

export interface FtsMatchRow {
  chunk_id: string;
  user_id: number;
  entity_type: ChunkEntityType;
  entity_id: number;
  resource_type: ChunkResourceType;
  chunk_order: number;
  page_number: number;
  header_path: string;
  title: string;
  source: string;
  content: string;
  bm25_score: number;
}

export interface MatchFts5Options {
  userId?: number | null | undefined;
  limit?: number | undefined;
  includeSources?: string[] | null | undefined;
  resourceType?: ChunkResourceType | null | undefined;
  entityType?: ChunkEntityType | null | undefined;
  entityRefs?: EntityFilterRef[] | null | undefined;
}

function escapeLikePattern(term: string): string {
  return term.replace(/[\\%_]/g, '\\$&');
}

const FTS_STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'if', 'in', 'on', 'at', 'to', 'for', 'of', 'with',
  'by', 'from', 'as', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'have', 'has', 'had',
  'do', 'does', 'did', 'can', 'could', 'will', 'would', 'should', 'may', 'might', 'what',
  'which', 'who', 'whom', 'whose', 'where', 'when', 'why', 'how', 'that', 'this', 'these',
  'those', 'it', 'its', 'into', 'about', 'using', 'based',
]);

function extractSearchWords(text: string): { cjkWords: string[]; asciiWords: string[]; rawWords: string[] } {
  const cleaned = text.replace(/[^\p{L}\p{N}_\u4e00-\u9fff]/gu, ' ');
  const rawWords = cleaned.split(/\s+/).map((t) => t.trim()).filter((t) => t.length >= 1);
  const cjkWords: string[] = [];
  const allAscii: string[] = [];

  for (const word of rawWords) {
    if (/[\u4e00-\u9fff]/.test(word)) {
      const cjkChars = word.match(/[\u4e00-\u9fff]/g) || [];
      if (cjkChars.length > 0) {
        cjkWords.push(cjkChars.join(''));
      }
      const embeddedAscii = word.match(/[A-Za-z0-9_]+/g) || [];
      allAscii.push(...embeddedAscii);
    } else {
      allAscii.push(word);
    }
  }

  const nonStopAscii = allAscii.filter((w) => !FTS_STOPWORDS.has(w.toLowerCase()));
  const asciiWords = nonStopAscii.length > 0 ? nonStopAscii : allAscii;
  return { cjkWords, asciiWords, rawWords };
}

export function sanitizeFtsQuery(text: string): string {
  const { cjkWords, asciiWords } = extractSearchWords(text);
  const terms: string[] = [];

  for (const cw of cjkWords) {
    const chars = Array.from(cw);
    for (let i = 0; i <= chars.length - 3; i++) {
      terms.push(chars.slice(i, i + 3).join(''));
    }
  }

  // SQLite FTS5 trigram only indexes tokens of >= 3 characters; shorter tokens always miss MATCH.
  for (const aw of asciiWords) {
    if (Array.from(aw).length >= 3) {
      terms.push(aw);
    }
  }

  if (terms.length === 0) {
    return '';
  }

  const uniqueTerms = Array.from(new Set(terms)).slice(0, 40);
  return uniqueTerms.map((t) => `"${t}"`).join(' OR ');
}

/**
 * Create external-content FTS5 virtual table bound to `chunks` + sync triggers.
 * Eliminates dual-write drift and duplicated text storage.
 */
export function createFts5Table(db: Database.Database): void {
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
      title,
      source,
      content,
      content='chunks',
      content_rowid='rowid',
      tokenize='trigram'
    );

    CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
      INSERT INTO chunks_fts(rowid, title, source, content)
      VALUES (new.rowid, new.title, new.source, new.content);
    END;

    CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
      INSERT INTO chunks_fts(chunks_fts, rowid, title, source, content)
      VALUES ('delete', old.rowid, old.title, old.source, old.content);
    END;

    CREATE TRIGGER IF NOT EXISTS chunks_au AFTER UPDATE ON chunks BEGIN
      INSERT INTO chunks_fts(chunks_fts, rowid, title, source, content)
      VALUES ('delete', old.rowid, old.title, old.source, old.content);
      INSERT INTO chunks_fts(rowid, title, source, content)
      VALUES (new.rowid, new.title, new.source, new.content);
    END;
  `);
}

function appendCommonFilters(
  whereParts: string[],
  params: (string | number)[],
  options: MatchFts5Options
): boolean {
  if (options.userId !== undefined && options.userId !== null) {
    whereParts.push('c.user_id = ?');
    params.push(options.userId);
  }
  if (options.entityType) {
    whereParts.push('c.entity_type = ?');
    params.push(options.entityType);
  }
  if (options.resourceType) {
    whereParts.push('c.resource_type = ?');
    params.push(options.resourceType);
  }
  if (options.includeSources && options.includeSources.length > 0) {
    const cleanSources = options.includeSources.filter(Boolean).map(String);
    if (cleanSources.length > 0) {
      const marks = cleanSources.map(() => '?').join(',');
      whereParts.push(`(c.source IN (${marks}) OR c.title IN (${marks}))`);
      params.push(...cleanSources, ...cleanSources);
    }
  }
  if (options.entityRefs !== undefined && options.entityRefs !== null) {
    if (options.entityRefs.length === 0) {
      return false;
    }
    const refClauses: string[] = [];
    for (const ref of options.entityRefs) {
      refClauses.push('(c.entity_type = ? AND c.entity_id = ?)');
      params.push(ref.entity_type, ref.entity_id);
    }
    whereParts.push('(' + refClauses.join(' OR ') + ')');
  }
  return true;
}

export function matchFts5(
  db: Database.Database,
  prompt: string,
  options: MatchFts5Options = {}
): FtsMatchRow[] {
  const limit = options.limit ?? 50;
  const terms = sanitizeFtsQuery(prompt);
  let rows: FtsMatchRow[] = [];

  if (terms) {
    const whereParts: string[] = ['chunks_fts MATCH ?'];
    const params: (string | number)[] = [terms];
    if (!appendCommonFilters(whereParts, params, options)) {
      return [];
    }

    const sql = `
      SELECT c.id AS chunk_id, c.user_id, c.entity_type, c.entity_id, c.resource_type,
             c.chunk_order, c.page_number, c.header_path, c.title, c.source, c.content,
             f.rank AS bm25_score
      FROM chunks_fts f
      JOIN chunks c ON c.rowid = f.rowid
      WHERE ${whereParts.join(' AND ')}
      ORDER BY f.rank
      LIMIT ?
    `;
    params.push(limit);

    try {
      rows = db.prepare(sql).all(...params) as FtsMatchRow[];
    } catch (err) {
      console.warn('[FTS5] Match query failed:', err instanceof Error ? err.message : String(err));
      rows = [];
    }
  }

  // Fallback to LIKE substring search when trigram FTS5 returns nothing (e.g. 1-2 char tokens)
  if (rows.length === 0 && prompt && prompt.trim().length > 0) {
    const { cjkWords, asciiWords, rawWords } = extractSearchWords(prompt);
    const meaningful = Array.from(new Set([...cjkWords, ...asciiWords]));
    const fallbackTerms = (meaningful.length > 0 ? meaningful : rawWords).slice(0, 8);

    if (fallbackTerms.length > 0) {
      const fallbackWhere: string[] = [];
      const fallbackParams: (string | number)[] = [];

      const termConditions: string[] = [];
      const scoreExprs: string[] = [];
      const scoreParams: string[] = [];

      for (const w of fallbackTerms) {
        const pat = `%${escapeLikePattern(w)}%`;
        const cond = "(c.content LIKE ? ESCAPE '\\' OR c.title LIKE ? ESCAPE '\\' OR c.source LIKE ? ESCAPE '\\')";
        termConditions.push(cond);
        fallbackParams.push(pat, pat, pat);
        scoreExprs.push(`(CASE WHEN ${cond} THEN 1 ELSE 0 END)`);
        scoreParams.push(pat, pat, pat);
      }
      fallbackWhere.push('(' + termConditions.join(' OR ') + ')');

      if (!appendCommonFilters(fallbackWhere, fallbackParams, options)) {
        return [];
      }

      const fSql = `
        SELECT c.id AS chunk_id, c.user_id, c.entity_type, c.entity_id, c.resource_type,
               c.chunk_order, c.page_number, c.header_path, c.title, c.source, c.content,
               -(${scoreExprs.join(' + ')}) AS bm25_score
        FROM chunks c
        WHERE ${fallbackWhere.join(' AND ')}
        ORDER BY (${scoreExprs.join(' + ')}) DESC, c.id ASC
        LIMIT ?
      `;

      try {
        rows = db
          .prepare(fSql)
          .all(...scoreParams, ...fallbackParams, ...scoreParams, limit) as FtsMatchRow[];
      } catch {
        rows = [];
      }
    }
  }

  return rows;
}
