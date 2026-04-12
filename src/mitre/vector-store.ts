/**
 * SQLite-backed vector store for MITRE ATT&CK embeddings.
 *
 * Design decisions:
 *  - Vectors are stored as raw BLOB (4 bytes per float, little-endian).
 *    This avoids JSON overhead and keeps the DB compact.
 *  - At query time, ALL vectors are loaded into a JS Map (in-memory index).
 *    For ~2 000 MITRE entries × 768-dim float32 this is ~6 MB — easily
 *    manageable. This eliminates the need for an external vector DB.
 *  - Cosine similarity is computed in pure JS; no native extension required.
 *  - The schema lives here (not in the main schema.ts) so the MITRE feature
 *    is entirely self-contained and opt-in.
 */

import { getDb } from '../database/connection';
import { MitreEntry, RetrievedEntry, EmbeddingResult } from './types';

// ─── Math helpers ─────────────────────────────────────────────────────────────

/**
 * Cosine similarity between two equal-length float vectors.
 * Returns a value in [-1, 1]; 1 = identical direction.
 */
function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot   += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

function vectorNorm(v: number[]): number {
  let sum = 0;
  for (const x of v) sum += x * x;
  return Math.sqrt(sum);
}

function tokenizeQuery(input: string): string[] {
  const tokens = input
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .map(t => t.trim())
    .filter(t => t.length > 2);
  return [...new Set(tokens)];
}

// ─── Buffer ↔ vector conversion ───────────────────────────────────────────────

function vectorToBuffer(v: number[]): Buffer {
  const buf = Buffer.allocUnsafe(v.length * 4);
  for (let i = 0; i < v.length; i++) {
    buf.writeFloatLE(v[i], i * 4);
  }
  return buf;
}

// node:sqlite returns BLOBs as Uint8Array, not Buffer — use DataView so this
// works regardless of which typed-array variant comes back from SQLite.
function bufferToVector(raw: Uint8Array | Buffer | ArrayBuffer): number[] {
  const ab  = raw instanceof ArrayBuffer ? raw : (raw as Uint8Array).buffer;
  const off = raw instanceof ArrayBuffer ? 0   : (raw as Uint8Array).byteOffset;
  const len = Math.floor((raw instanceof ArrayBuffer ? raw.byteLength : (raw as Uint8Array).byteLength) / 4);
  const view = new DataView(ab, off, len * 4);
  const arr  = new Array<number>(len);
  for (let i = 0; i < len; i++) {
    arr[i] = view.getFloat32(i * 4, true); // true = little-endian
  }
  return arr;
}

// ─── MitreVectorStore ─────────────────────────────────────────────────────────

export class MitreVectorStore {
  /** In-memory similarity index: ATT&CK ID → float vector */
  private readonly index = new Map<string, number[]>();

  // ── Schema ─────────────────────────────────────────────────────────────────

  ensureSchema(): void {
    const db = getDb();
    db.exec(`
      -- Full MITRE entry metadata
      CREATE TABLE IF NOT EXISTS mitre_entries (
        id              TEXT    PRIMARY KEY,
        stix_id         TEXT    NOT NULL,
        type            TEXT    NOT NULL CHECK(type IN ('technique','tactic','group','software','mitigation')),
        name            TEXT    NOT NULL,
        description     TEXT    NOT NULL DEFAULT '',
        url             TEXT    NOT NULL DEFAULT '',
        tactics         TEXT    NOT NULL DEFAULT '[]',
        platforms       TEXT    NOT NULL DEFAULT '[]',
        data_sources    TEXT    NOT NULL DEFAULT '[]',
        detection       TEXT    NOT NULL DEFAULT '',
        ext_references  TEXT    NOT NULL DEFAULT '[]',
        is_subtechnique INTEGER NOT NULL DEFAULT 0,
        parent_id       TEXT,
        modified        TEXT    NOT NULL DEFAULT '',
        deprecated      INTEGER NOT NULL DEFAULT 0,
        ingested_at     DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      -- Vector embeddings stored as BLOB
      CREATE TABLE IF NOT EXISTS mitre_embeddings (
        entry_id    TEXT    PRIMARY KEY REFERENCES mitre_entries(id) ON DELETE CASCADE,
        vector      BLOB    NOT NULL,
        dimensions  INTEGER NOT NULL,
        model       TEXT    NOT NULL,
        embedded_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_mitre_type   ON mitre_entries(type);
      CREATE INDEX IF NOT EXISTS idx_mitre_parent ON mitre_entries(parent_id);
    `);
  }

  // ── Ingestion ──────────────────────────────────────────────────────────────

  /** Persist a batch of MITRE entries (upsert by primary key). */
  upsertEntries(entries: MitreEntry[]): void {
    const db = getDb();
    const stmt = db.prepare(`
      INSERT OR REPLACE INTO mitre_entries
        (id, stix_id, type, name, description, url,
         tactics, platforms, data_sources, detection,
         ext_references, is_subtechnique, parent_id, modified, deprecated)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `);

    for (const e of entries) {
      stmt.run(
        e.id, e.stixId, e.type, e.name, e.description, e.url,
        JSON.stringify(e.tactics),
        JSON.stringify(e.platforms),
        JSON.stringify(e.dataSources),
        e.detection,
        JSON.stringify(e.references),
        e.isSubtechnique ? 1 : 0,
        e.parentId ?? null,
        e.modified,
        e.deprecated ? 1 : 0,
      );
    }
  }

  /** Persist embedding vectors (upsert). Also updates the in-memory index. */
  upsertEmbeddings(embeddings: EmbeddingResult[]): void {
    const db = getDb();
    const stmt = db.prepare(`
      INSERT OR REPLACE INTO mitre_embeddings (entry_id, vector, dimensions, model)
      VALUES (?, ?, ?, ?)
    `);

    for (const emb of embeddings) {
      stmt.run(emb.entryId, vectorToBuffer(emb.vector), emb.dimensions, emb.model);
      this.index.set(emb.entryId, emb.vector);
    }
  }

  // ── Index management ───────────────────────────────────────────────────────

  /**
   * Load all stored embeddings into the in-memory index.
   * Call once at startup (after schema is ensured).
   */
  loadIndex(): void {
    const db = getDb();
    type Row = { entry_id: string; vector: Buffer };
    const rows = db
      .prepare('SELECT entry_id, vector FROM mitre_embeddings')
      .all() as Row[];

    this.index.clear();
    for (const row of rows) {
      this.index.set(row.entry_id, bufferToVector(row.vector));
    }
  }

  /** Number of entries currently in the in-memory index. */
  get indexSize(): number {
    return this.index.size;
  }

  // ── Similarity search ──────────────────────────────────────────────────────

  /**
   * Find the `topK` most similar MITRE entries to `queryVector`.
   *
   * @param queryVector  Embedding of the user's query (must match stored dimensions).
   * @param topK         Maximum number of results to return.
   * @param threshold    Minimum cosine similarity to include a result (0–1).
   * @throws {Error}     When all stored vectors have a different dimension than the query.
   */
  search(queryVector: number[], topK = 5, threshold = 0.25): RetrievedEntry[] {
    if (this.index.size === 0) return [];

    if (vectorNorm(queryVector) <= 1e-9) {
      throw new Error(
        'Query embedding is a zero vector. The configured EMBEDDING_MODEL is returning degenerate embeddings. ' +
        'Load a compatible embedding model in LM Studio and re-run: npm run mitre:reset && npm run mitre:ingest',
      );
    }

    // Detect dimension mismatch before scoring — gives a clear error instead of
    // silently returning 0 results when the stored embeddings use a different model.
    let dimMismatch = 0;

    // Score every entry
    const scored: Array<{ id: string; score: number }> = [];
    for (const [id, vec] of this.index) {
      if (vec.length !== queryVector.length) { dimMismatch++; continue; }
      const score = cosineSimilarity(queryVector, vec);
      if (score >= threshold) scored.push({ id, score });
    }

    if (dimMismatch > 0 && scored.length === 0) {
      const storedModel = this.getEmbeddingModel() ?? 'unknown';
      throw new Error(
        `Embedding dimension mismatch: stored vectors are ${this.indexSize} entries from model "${storedModel}", ` +
        `but the query vector has ${queryVector.length} dimensions. ` +
        `Run 'npm run mitre:reset && npm run mitre:ingest' to rebuild the index with the current EMBEDDING_MODEL.`,
      );
    }

    // Sort descending and take topK
    scored.sort((a, b) => b.score - a.score);
    const top = scored.slice(0, topK);
    if (top.length === 0) return [];

    // Hydrate with full entry metadata
    const entries = this.fetchEntriesByIds(top.map(s => s.id));
    const byId = new Map(entries.map(e => [e.id, e]));

    return top
      .map(s => {
        const entry = byId.get(s.id);
        if (!entry) return null;
        return { entry, score: s.score };
      })
      .filter((r): r is RetrievedEntry => r !== null);
  }

  /**
   * Lexical fallback when embedding retrieval is unavailable.
   * Scores by simple token overlap across key entry fields.
   */
  searchKeyword(query: string, topK = 5): RetrievedEntry[] {
    const tokens = tokenizeQuery(query);
    if (tokens.length === 0) return [];

    const db = getDb();
    const rows = db
      .prepare('SELECT * FROM mitre_entries')
      .all() as Record<string, unknown>[];

    const scored = rows
      .map(row => {
        const entry = rowToEntry(row);
        const haystack = [
          entry.id,
          entry.name,
          entry.description,
          entry.detection,
          entry.tactics.join(' '),
          entry.platforms.join(' '),
          entry.dataSources.join(' '),
        ].join(' ').toLowerCase();

        const matches = tokens.filter(t => haystack.includes(t)).length;
        if (matches === 0) return null;

        const exactIdBoost = entry.id.toLowerCase() === query.trim().toLowerCase() ? 0.25 : 0;
        const score = Math.min(1, matches / tokens.length + exactIdBoost);
        return { entry, score };
      })
      .filter((r): r is RetrievedEntry => r !== null)
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.max(1, Math.min(topK, 10)));

    return scored;
  }

  // ── DB helpers ─────────────────────────────────────────────────────────────

  fetchEntriesByIds(ids: string[]): MitreEntry[] {
    if (ids.length === 0) return [];
    const db = getDb();
    const placeholders = ids.map(() => '?').join(',');
    const rows = db
      .prepare(`SELECT * FROM mitre_entries WHERE id IN (${placeholders})`)
      .all(...ids) as Record<string, unknown>[];
    return rows.map(rowToEntry);
  }

  /** Returns entries that have been ingested but not yet embedded. */
  getEntriesWithoutEmbeddings(): MitreEntry[] {
    const db = getDb();
    const rows = db
      .prepare(`
        SELECT me.*
        FROM   mitre_entries me
        LEFT JOIN mitre_embeddings emb ON emb.entry_id = me.id
        WHERE  emb.entry_id IS NULL
      `)
      .all() as Record<string, unknown>[];
    return rows.map(rowToEntry);
  }

  getEntryCount(): number {
    const db = getDb();
    const row = db
      .prepare('SELECT COUNT(*) AS n FROM mitre_entries')
      .get() as { n: number };
    return row.n;
  }

  getEmbeddingCount(): number {
    const db = getDb();
    const row = db
      .prepare('SELECT COUNT(*) AS n FROM mitre_embeddings')
      .get() as { n: number };
    return row.n;
  }

  /** Returns the embedding model name used for stored vectors (or null). */
  getEmbeddingModel(): string | null {
    const db = getDb();
    const row = db
      .prepare('SELECT model FROM mitre_embeddings LIMIT 1')
      .get() as { model: string } | undefined;
    return row?.model ?? null;
  }
}

// ─── Row → domain object ──────────────────────────────────────────────────────

function rowToEntry(row: Record<string, unknown>): MitreEntry {
  return {
    id:             String(row.id ?? ''),
    stixId:         String(row.stix_id ?? ''),
    type:           String(row.type ?? 'technique') as MitreEntry['type'],
    name:           String(row.name ?? ''),
    description:    String(row.description ?? ''),
    url:            String(row.url ?? ''),
    tactics:        safeParse(row.tactics, []),
    platforms:      safeParse(row.platforms, []),
    dataSources:    safeParse(row.data_sources, []),
    detection:      String(row.detection ?? ''),
    references:     safeParse(row.ext_references, []),
    isSubtechnique: Boolean(row.is_subtechnique),
    parentId:       row.parent_id != null ? String(row.parent_id) : undefined,
    modified:       String(row.modified ?? ''),
    deprecated:     Boolean(row.deprecated),
  };
}

function safeParse<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string') return fallback;
  try { return JSON.parse(value) as T; } catch { return fallback; }
}
