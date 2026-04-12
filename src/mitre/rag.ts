/**
 * MITRE ATT&CK RAG pipeline
 *
 * End-to-end flow:
 *   user query
 *     → EmbeddingClient.embed()          (LM Studio /v1/embeddings)
 *     → MitreVectorStore.search()        (cosine similarity over SQLite-backed index)
 *     → formatContext()                  (structured Markdown context block)
 *     → injected into LLM system prompt  (done in react-agent.ts)
 *
 * The MitreRag class is intentionally lazy-initialised: the vector index is
 * loaded from SQLite only on the first query, so cold startup is not penalised.
 *
 * Hallucination mitigation strategy
 * ──────────────────────────────────
 * 1. Every retrieved entry includes its ATT&CK URL — the LLM is instructed to
 *    cite it rather than paraphrase freely.
 * 2. A similarity score is surfaced per entry so the LLM (and the user) can
 *    judge relevance.
 * 3. A configurable threshold (MITRE_SIMILARITY_THRESHOLD, default 0.25)
 *    filters low-confidence matches before they reach the prompt.
 * 4. topK is capped at 10 to prevent context flooding.
 */

import { EmbeddingClient } from './embeddings';
import { MitreVectorStore } from './vector-store';
import { fetchMitreStixBundle } from './ingest';
import { MitreEntry, MitreRagResult, RetrievedEntry } from './types';
import { agentConfig } from '../config';

// ─── Config ───────────────────────────────────────────────────────────────────

export interface MitreRagConfig {
  /** LM Studio embedding model — should be a dedicated text-embedding model */
  embeddingModel: string;
  /** Number of top entries to retrieve per query */
  topK: number;
  /** Minimum cosine similarity to include an entry (0–1) */
  similarityThreshold: number;
  /** Maximum characters of context to inject into the LLM prompt */
  maxContextChars: number;
}

export function buildMitreRagConfig(overrides?: Partial<MitreRagConfig>): MitreRagConfig {
  const base: MitreRagConfig = {
    embeddingModel:      process.env.EMBEDDING_MODEL ?? agentConfig.model,
    topK:                parseInt(process.env.MITRE_TOP_K ?? '5', 10),
    similarityThreshold: parseFloat(process.env.MITRE_SIMILARITY_THRESHOLD ?? '0.25'),
    maxContextChars:     parseInt(process.env.MITRE_MAX_CONTEXT_CHARS ?? '4000', 10),
  };
  return { ...base, ...overrides };
}

// ─── MitreRag ─────────────────────────────────────────────────────────────────

export class MitreRag {
  private readonly embedClient: EmbeddingClient;
  private readonly store: MitreVectorStore;
  private readonly config: MitreRagConfig;
  private initialized = false;

  constructor(overrides?: Partial<MitreRagConfig>) {
    this.config      = buildMitreRagConfig(overrides);
    this.store       = new MitreVectorStore();
    this.embedClient = new EmbeddingClient(
      agentConfig.lmStudioUrl,
      agentConfig.apiKey,
      this.config.embeddingModel,
    );
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  /**
   * Idempotent: ensures the schema exists and loads the vector index.
   * Safe to call multiple times.
   */
  async init(): Promise<void> {
    if (this.initialized) return;
    this.store.ensureSchema();
    if (this.store.getEmbeddingCount() > 0) {
      this.store.loadIndex();
    }
    this.initialized = true;
  }

  // ── Query pipeline ─────────────────────────────────────────────────────────

  /**
   * Full RAG query:
   *   1. Embed the user's query via LM Studio.
   *   2. Find the topK closest MITRE entries by cosine similarity.
   *   3. Return both structured results and a pre-formatted context block.
   *
   * @throws When the embedding model is unreachable.
   */
  async query(userQuery: string, topKOverride?: number): Promise<MitreRagResult> {
    await this.init();

    const topK = Math.min(topKOverride ?? this.config.topK, 10);

    // Knowledge base empty → informative no-op
    if (this.store.indexSize === 0) {
      const entryCount = this.store.getEntryCount();
      const msg =
        entryCount === 0
          ? '[MITRE ATT&CK knowledge base is empty. Run: npm run mitre:ingest]'
          : `[MITRE ATT&CK: ${entryCount} entries stored but no embeddings yet. ` +
            'Ensure EMBEDDING_MODEL is set and run: npm run mitre:ingest]';
      return {
        query: userQuery,
        entries: [],
        formattedContext: msg,
        totalEntries: 0,
      };
    }

    let retrieved: RetrievedEntry[] = [];
    let formattedContext = '';

    try {
      // Step 1 — embed the query
      const queryVector = await this.embedClient.embed(userQuery);

      // Step 2 — similarity search
      retrieved = this.store.search(
        queryVector,
        topK,
        this.config.similarityThreshold,
      );

      // Step 3 — format into an LLM-ready context block
      formattedContext = formatContext(retrieved, this.config.maxContextChars);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      const isEmbeddingFailure = msg.includes('zero vector') || msg.includes('dimension mismatch');

      if (!isEmbeddingFailure) throw err;

      // Fallback: lexical retrieval keeps MITRE lookups usable even when
      // LM Studio embeddings are unavailable or degenerate.
      retrieved = this.store.searchKeyword(userQuery, topK);
      const fallback = formatContext(retrieved, this.config.maxContextChars);
      formattedContext =
        '[MITRE RAG fallback] Semantic embeddings unavailable; using lexical retrieval.\n\n' +
        fallback;
    }

    return {
      query: userQuery,
      entries: retrieved,
      formattedContext,
      totalEntries: this.store.indexSize,
    };
  }

  // ── Status ─────────────────────────────────────────────────────────────────

  isReady(): boolean {
    return this.initialized && this.store.indexSize > 0;
  }

  getStatus(): { entries: number; embeddings: number; indexLoaded: number } {
    return {
      entries:     this.store.getEntryCount(),
      embeddings:  this.store.getEmbeddingCount(),
      indexLoaded: this.store.indexSize,
    };
  }
}

// ─── Ingestion pipeline ───────────────────────────────────────────────────────

export interface IngestionResult {
  entriesIngested: number;
  embeddingsGenerated: number;
  embeddingModel: string | null;
  skippedEmbeddings: boolean;
}

/**
 * Full ingestion pipeline:
 *   1. Fetch STIX bundle from GitHub.
 *   2. Persist all entries to SQLite.
 *   3. Generate and persist embeddings for entries that don't have them.
 *   4. Load the updated index into memory.
 *
 * Idempotent — safe to re-run. Only new/changed entries are re-embedded.
 */
export async function runIngestionPipeline(
  onProgress?: (msg: string) => void,
): Promise<IngestionResult> {
  const cfg   = buildMitreRagConfig();
  const store = new MitreVectorStore();
  store.ensureSchema();

  // ── 1. Fetch STIX data ──────────────────────────────────────────────────────
  const entries = await fetchMitreStixBundle(onProgress);

  // ── 2. Persist entries ──────────────────────────────────────────────────────
  onProgress?.(`Persisting ${entries.length.toLocaleString()} entries to database...`);
  store.upsertEntries(entries);

  // ── 3. Embeddings ────────────────────────────────────────────────────────────
  const embedClient = new EmbeddingClient(
    agentConfig.lmStudioUrl,
    agentConfig.apiKey,
    cfg.embeddingModel,
  );

  onProgress?.(`Checking embedding model "${cfg.embeddingModel}" in LM Studio...`);
  const modelReady = await embedClient.ping();

  if (!modelReady) {
    onProgress?.(
      `[WARN] Embedding model "${cfg.embeddingModel}" did not respond from LM Studio.\n` +
      `       Set EMBEDDING_MODEL in .env to a loaded embedding model\n` +
      `       (e.g. nomic-embed-text-v1.5, all-minilm-l6-v2, mxbai-embed-large-v1).\n` +
      `       Entries are stored — re-run 'npm run mitre:ingest' after loading the model.`,
    );
    return {
      entriesIngested:     entries.length,
      embeddingsGenerated: 0,
      embeddingModel:      null,
      skippedEmbeddings:   true,
    };
  }

  const needsEmbedding = store.getEntriesWithoutEmbeddings();
  if (needsEmbedding.length === 0) {
    onProgress?.('All entries already have embeddings — nothing to do.');
    store.loadIndex();
    return {
      entriesIngested:     entries.length,
      embeddingsGenerated: 0,
      embeddingModel:      cfg.embeddingModel,
      skippedEmbeddings:   false,
    };
  }

  onProgress?.(
    `Generating embeddings for ${needsEmbedding.length.toLocaleString()} entries` +
    ` using "${cfg.embeddingModel}"...`,
  );

  let totalEmbedded = 0;
  const BATCH_SIZE  = 50; // flush to DB every N entries to avoid OOM

  for (let i = 0; i < needsEmbedding.length; i += BATCH_SIZE) {
    const batch = needsEmbedding.slice(i, i + BATCH_SIZE);

    const results = await embedClient.embedBatch(batch, (done) => {
      const overall = i + done;
      if (overall % 200 === 0 || overall === needsEmbedding.length) {
        onProgress?.(`  Embedded ${overall.toLocaleString()} / ${needsEmbedding.length.toLocaleString()}...`);
      }
    });

    store.upsertEmbeddings(results);
    totalEmbedded += results.length;
  }

  // ── 4. Load index ────────────────────────────────────────────────────────────
  store.loadIndex();
  onProgress?.(
    `Done. ${entries.length.toLocaleString()} entries | ` +
    `${totalEmbedded.toLocaleString()} embeddings generated.`,
  );

  return {
    entriesIngested:     entries.length,
    embeddingsGenerated: totalEmbedded,
    embeddingModel:      cfg.embeddingModel,
    skippedEmbeddings:   false,
  };
}

// ─── Context formatter ────────────────────────────────────────────────────────

/**
 * Produces a structured Markdown block suitable for LLM context injection.
 * Entries are truncated to stay within `maxChars`.
 */
function formatContext(entries: RetrievedEntry[], maxChars: number): string {
  if (entries.length === 0) {
    return 'No relevant MITRE ATT&CK entries found above the similarity threshold.';
  }

  const header = `## MITRE ATT&CK Context (${entries.length} relevant entries)\n\n`;
  const blocks: string[] = [];
  let usedChars = header.length;

  for (const { entry, score } of entries) {
    const block = formatEntry(entry, score);
    if (usedChars + block.length > maxChars) break;
    blocks.push(block);
    usedChars += block.length + 1; // +1 for the trailing newline
  }

  return header + blocks.join('\n');
}

function formatEntry(entry: MitreEntry, score: number): string {
  const pct   = (score * 100).toFixed(1);
  const lines: string[] = [];

  lines.push(`### [${entry.id}] ${entry.name}  _(${pct}% match)_`);
  lines.push(`**Type:** ${entry.type} | **Reference:** ${entry.url}`);

  if (entry.tactics.length > 0) {
    lines.push(`**Tactics:** ${entry.tactics.join(', ')}`);
  }
  if (entry.platforms.length > 0) {
    lines.push(`**Platforms:** ${entry.platforms.join(', ')}`);
  }
  if (entry.isSubtechnique && entry.parentId) {
    lines.push(`**Parent Technique:** ${entry.parentId}`);
  }

  if (entry.description) {
    const desc = entry.description.length > 500
      ? entry.description.slice(0, 500) + '…'
      : entry.description;
    lines.push(`\n**Description:** ${desc}`);
  }

  if (entry.detection) {
    const det = entry.detection.length > 300
      ? entry.detection.slice(0, 300) + '…'
      : entry.detection;
    lines.push(`\n**Detection:** ${det}`);
  }

  return lines.join('\n');
}
