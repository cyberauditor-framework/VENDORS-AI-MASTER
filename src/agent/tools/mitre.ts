/**
 * MITRE ATT&CK RAG tool for the ReAct agent.
 *
 * Exposes `query_mitre_attack` as an OpenAI-compatible tool definition so the
 * LLM can call it the same way it calls `search_web` and `scrape_url`.
 *
 * The MitreRagTool class wraps MitreRag with agent-friendly ergonomics:
 *  - Lazy init (first call triggers schema check + index load)
 *  - Graceful degradation when the knowledge base is empty
 *  - Truncated, structured text output suitable for tool_call injection
 */

import type { ChatCompletionTool } from 'openai/resources/chat/completions';
import { MitreRag } from '../../mitre/rag';

// ─── OpenAI Tool Definition ───────────────────────────────────────────────────

export const MITRE_TOOL_DEFINITION: ChatCompletionTool = {
  type: 'function',
  function: {
    name: 'query_mitre_attack',
    description:
      'Semantic search over the MITRE ATT&CK knowledge base. ' +
      'Returns the most relevant techniques, tactics, threat groups, software, ' +
      'and mitigations for a given natural-language query. ' +
      'Use this tool to ground threat intelligence analysis in verified ATT&CK framework data. ' +
      'Cite returned entry IDs and URLs in your analysis.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            'Natural-language description of what you are looking for. ' +
            'Be specific about the behaviour, technique name, or threat actor. ' +
            'Examples: "ransomware data encryption techniques", ' +
            '"lateral movement via remote services", ' +
            '"APT29 credential access tactics", ' +
            '"phishing spearphishing attachment".',
        },
        top_k: {
          type: 'number',
          description:
            'How many entries to retrieve (1–10, default 5). ' +
            'Use a higher value for broad exploration; lower for targeted lookups.',
        },
      },
      required: ['query'],
    },
  },
};

// ─── MitreRagTool ─────────────────────────────────────────────────────────────

/** Singleton RAG instance shared across all tool invocations in a session. */
let _rag: MitreRag | null = null;

function getRag(): MitreRag {
  if (!_rag) _rag = new MitreRag();
  return _rag;
}

export class MitreRagTool {
  /**
   * Execute a MITRE ATT&CK RAG query and return a formatted string
   * suitable for injecting as a tool_call result into the LLM conversation.
   *
   * @param query  Natural-language query from the LLM.
   * @param topK   Number of results requested (optional).
   */
  async run(query: string, topK?: number): Promise<string> {
    const rag = getRag();

    try {
      await rag.init();
      const result = await rag.query(query, topK);

      if (result.entries.length === 0) {
        const hasData = result.totalEntries > 0;
        return hasData
          ? `No MITRE ATT&CK entries matched "${query}" above the relevance threshold.\n` +
            `Try rephrasing with more specific technique names or behaviour descriptions.\n` +
            `(Index contains ${result.totalEntries} entries.)`
          : result.formattedContext; // contains the "not ingested" message
      }

      return result.formattedContext;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      const isDimMismatch = msg.includes('dimension mismatch');
      const isZeroVector = msg.includes('zero vector') || msg.includes('degenerate embeddings');
      return (
        `MITRE ATT&CK query failed: ${msg}\n\n` +
        (isDimMismatch
          ? 'ACTION REQUIRED — model mismatch detected:\n' +
            '  1. Stop the server.\n' +
            `  2. Ensure "${process.env.EMBEDDING_MODEL ?? 'your embedding model'}" is loaded in LM Studio.\n` +
            '  3. Run: npm run mitre:reset && npm run mitre:ingest\n' +
            '  4. Restart the server.\n'
          : isZeroVector
          ? 'ACTION REQUIRED — embedding model is returning zero vectors:\n' +
            '  1. In LM Studio, load a known-good embedding model (example: nomic-ai/text-embedding-nomic-embed-text-v1.5).\n' +
            '  2. Set EMBEDDING_MODEL to that exact loaded model id in .env.\n' +
            '  3. Run: npm run mitre:reset && npm run mitre:ingest\n' +
            '  4. Verify with: npm run mitre:diagnose -- --query "ransomware encryption techniques"\n'
          : 'Possible causes:\n' +
            '  1. LM Studio is not running or the embedding model is not loaded.\n' +
            '  2. EMBEDDING_MODEL in .env does not match a loaded model.\n' +
            '  3. The MITRE knowledge base has not been ingested (run: npm run mitre:ingest).\n')
      );
    }
  }
}
