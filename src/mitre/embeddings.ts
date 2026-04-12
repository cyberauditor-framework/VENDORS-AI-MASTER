/**
 * Embedding generation for MITRE ATT&CK entries.
 *
 * Uses the LM Studio /v1/embeddings endpoint (OpenAI-compatible) so no
 * additional packages are needed beyond the `openai` SDK already in the project.
 *
 * Embedding model selection
 * ─────────────────────────
 * Set EMBEDDING_MODEL in .env to a dedicated embedding model loaded in LM Studio
 * (e.g. nomic-embed-text-v1.5, all-minilm-l6-v2, mxbai-embed-large-v1).
 *
 * If EMBEDDING_MODEL is not set, the pipeline falls back to the generation model
 * (LM_STUDIO_MODEL). Most generation models DO support /v1/embeddings via LM Studio,
 * but a dedicated embedding model will yield significantly better retrieval quality.
 */

import OpenAI from 'openai';
import { MitreEntry, EmbeddingResult } from './types';

function embeddingNorm(vector: number[]): number {
  let sum = 0;
  for (const v of vector) sum += v * v;
  return Math.sqrt(sum);
}

function validateEmbeddingVector(vector: number[], model: string): number[] {
  if (!Array.isArray(vector) || vector.length === 0) {
    throw new Error(`Embedding model "${model}" returned an empty vector.`);
  }

  const allFinite = vector.every(v => Number.isFinite(v));
  if (!allFinite) {
    throw new Error(`Embedding model "${model}" returned non-finite values (NaN/Infinity).`);
  }

  const norm = embeddingNorm(vector);
  if (norm <= 1e-9) {
    throw new Error(
      `Embedding model "${model}" returned a zero vector (norm=${norm}). ` +
      'LM Studio model appears incompatible with /v1/embeddings.',
    );
  }

  return vector;
}

// ─── Text builder ─────────────────────────────────────────────────────────────

/**
 * Builds a structured text representation of a MITRE entry suitable for
 * embedding. The quality of this representation directly impacts retrieval.
 *
 * Strategy:
 *  - Lead with the ATT&CK ID and name for exact-ID lookups
 *  - Include type, tactics, platforms early (high signal, low noise)
 *  - Truncate long description/detection fields to avoid token waste
 */
export function buildEmbedText(entry: MitreEntry): string {
  const lines: string[] = [];

  // Header — unambiguous identifier
  lines.push(`[${entry.id}] ${entry.name}`);
  lines.push(`Type: ${entry.type}`);

  if (entry.tactics.length > 0) {
    lines.push(`Tactics: ${entry.tactics.join(', ')}`);
  }
  if (entry.platforms.length > 0) {
    lines.push(`Platforms: ${entry.platforms.join(', ')}`);
  }
  if (entry.dataSources.length > 0) {
    // Cap at 6 sources — beyond that we hit diminishing returns
    lines.push(`Data Sources: ${entry.dataSources.slice(0, 6).join(', ')}`);
  }

  // Main content
  if (entry.description) {
    // 700 chars captures the key behaviours without exceeding typical context limits
    lines.push(`\nDescription: ${entry.description.slice(0, 700)}`);
  }
  if (entry.detection) {
    lines.push(`\nDetection: ${entry.detection.slice(0, 350)}`);
  }

  return lines.join('\n');
}

// ─── Embedding client ─────────────────────────────────────────────────────────

export class EmbeddingClient {
  private readonly openai: OpenAI;
  private readonly model: string;

  constructor(baseURL: string, apiKey: string, model: string) {
    this.openai = new OpenAI({ baseURL, apiKey });
    this.model = model;
  }

  /**
   * Embed a single text string. Returns a raw float vector.
   */
  async embed(text: string): Promise<number[]> {
    const response = await this.openai.embeddings.create({
      model: this.model,
      input: text,
      // Force float format — the OpenAI SDK v4 requests base64 by default and
      // LM Studio's base64 decoding produces zero vectors on some models.
      encoding_format: 'float',
    });
    return validateEmbeddingVector(response.data[0].embedding, this.model);
  }

  /**
   * Embed all entries in `entries`, calling `onProgress` every 50 items.
   * Failures are logged to stderr and skipped — partial results are still stored.
   */
  async embedBatch(
    entries: MitreEntry[],
    onProgress?: (done: number, total: number) => void,
  ): Promise<EmbeddingResult[]> {
    const results: EmbeddingResult[] = [];

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      try {
        const text = buildEmbedText(entry);
        const vector = await this.embed(text);
        results.push({
          entryId: entry.id,
          vector,
          model: this.model,
          dimensions: vector.length,
        });
      } catch (err) {
        process.stderr.write(
          `  [WARN] Could not embed ${entry.id} (${entry.name}): ` +
          `${err instanceof Error ? err.message : err}\n`,
        );
      }

      onProgress?.(i + 1, entries.length);
    }

    return results;
  }

  /**
   * Lightweight connectivity check — embeds a dummy string and verifies a
   * non-empty vector is returned. Returns false on any error.
   */
  async ping(): Promise<boolean> {
    try {
      const vec = await this.embed('test connectivity');
      return Array.isArray(vec) && vec.length > 0;
    } catch {
      return false;
    }
  }

  get modelName(): string {
    return this.model;
  }
}
