/**
 * Palo Alto Networks MITRE ATT&CK RAG tool for the MITRE Coverage Agent.
 *
 * This tool calls the Python FastAPI microservice (src/paloalto-rag/main.py)
 * which is backed by ChromaDB + LM Studio embeddings and contains content from:
 *   - TechDocs (official product documentation)
 *   - Unit 42 threat intelligence blog
 *   - Cortex XDR MITRE ATT&CK integration docs
 *   - MITRE ATT&CK Evaluations results for Palo Alto
 *
 * Compared to the generic MITRE RAG (query_mitre_attack), this tool provides:
 *   - Product-specific evidence (Strata / Prisma / Cortex / Unit42)
 *   - Prevention vs. Detection distinction
 *   - Confidence scores derived from cosine similarity
 *   - Authoritative source attribution from official PA documentation
 */

import type { ChatCompletionTool } from 'openai/resources/chat/completions';
import axios from 'axios';

const PALOALTO_RAG_URL = (process.env.PALOALTO_RAG_URL ?? 'http://localhost:8765').replace(/\/$/, '');

// ─── Tool definition ──────────────────────────────────────────────────────────

export const PALOALTO_RAG_TOOL_DEFINITION: ChatCompletionTool = {
  type: 'function',
  function: {
    name: 'query_paloalto_rag',
    description:
      'Search the Palo Alto Networks knowledge base for MITRE ATT&CK coverage evidence. ' +
      'This RAG is fed from official TechDocs, Unit 42 threat intelligence, ' +
      'Cortex XDR MITRE documentation, and official MITRE ATT&CK Evaluations. ' +
      'Use this tool when analysing Palo Alto Networks — it returns product-specific ' +
      'evidence with a Confidence Score and Source Attribution section. ' +
      'Can automatically filter by product_line (Strata, Prisma, Cortex, Unit42) ' +
      'and action_type (Prevention, Detection, Investigation, Intelligence). ' +
      'Example queries: "Cortex XDR T1059 detection", ' +
      '"Prisma Access lateral movement prevention", ' +
      '"Unit 42 ransomware T1486".',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            'Natural-language query. Include ATT&CK IDs, product names, or technique descriptions. ' +
            'The service auto-extracts metadata filters (product line, action type, MITRE ID) ' +
            'from the query text.',
        },
        top_k: {
          type: 'number',
          description: 'How many chunks to retrieve (1–10, default 5).',
        },
        product_line: {
          type: 'string',
          enum: ['Strata', 'Prisma', 'Cortex', 'Unit42', 'General'],
          description: 'Optional — restrict results to a specific Palo Alto product family.',
        },
        action_type: {
          type: 'string',
          enum: ['Prevention', 'Detection', 'Investigation', 'Intelligence', 'General'],
          description: 'Optional — restrict results by coverage type.',
        },
      },
      required: ['query'],
    },
  },
};

// ─── PaloAltoRagTool ──────────────────────────────────────────────────────────

export class PaloAltoRagTool {
  private readonly baseUrl: string;

  constructor() {
    this.baseUrl = PALOALTO_RAG_URL;
  }

  /**
   * Execute a query against the Palo Alto RAG service.
   * Returns a formatted string suitable for injection as a tool_call result.
   */
  async run(
    query: string,
    topK?: number,
    productLine?: string,
    actionType?: string,
  ): Promise<string> {
    const filters: Record<string, string> = {};
    if (productLine && productLine !== 'General') filters['product_line'] = productLine;
    if (actionType  && actionType  !== 'General') filters['action_type']  = actionType;

    try {
      const resp = await axios.post<PaloAltoQueryResponse>(
        `${this.baseUrl}/query`,
        {
          query,
          top_k:          topK ?? 5,
          filters:        Object.keys(filters).length ? filters : undefined,
          use_self_query: true,
        },
        { timeout: 30_000 },
      );

      const data = resp.data;
      const pct  = ((data.confidence_score ?? 0) * 100).toFixed(1);

      if (!data.chunks?.length) {
        return (
          `[PaloAlto RAG] No relevant documentation found for "${query}".\n` +
          'Run: npm run paloalto:ingest  (ingests default TechDocs + Unit 42 + Cortex XDR docs)\n' +
          `Service URL: ${this.baseUrl}`
        );
      }

      let out = data.answer ?? '';

      out += `\n\n---\n**Confidence Score:** ${pct}%`;

      if (data.applied_filter && Object.keys(data.applied_filter).length) {
        const f = Object.entries(data.applied_filter)
          .map(([k, v]) => `${k}=${v}`)
          .join(', ');
        out += `\n**Applied Filter:** ${f}`;
      }

      if (data.sources?.length) {
        out += '\n\n**Source Attribution:**';
        for (const s of data.sources.slice(0, 6)) {
          out += `\n- ${s.title || s.url}  <${s.url}>`;
        }
      }

      return out;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      const isConnRefused = msg.includes('ECONNREFUSED') || msg.includes('connect ECONNRESET');
      return isConnRefused
        ? `[PaloAlto RAG] Service not running — start with: npm run paloalto:start\n(${msg})`
        : `[PaloAlto RAG] Query failed: ${msg}`;
    }
  }

  /** Check if the Python service is reachable. */
  async ping(): Promise<boolean> {
    try {
      await axios.get(`${this.baseUrl}/health`, { timeout: 5_000 });
      return true;
    } catch {
      return false;
    }
  }
}

// ─── Response types ───────────────────────────────────────────────────────────

interface SourceAttribution {
  url:         string;
  title:       string;
  source_type: string;
  chunk_index: number;
}

interface RetrievedChunk {
  content:     string;
  score:       number;
  metadata:    Record<string, unknown>;
  attribution: SourceAttribution;
}

interface PaloAltoQueryResponse {
  answer:           string;
  confidence_score: number;
  sources:          SourceAttribution[];
  chunks:           RetrievedChunk[];
  applied_filter?:  Record<string, string> | null;
}
