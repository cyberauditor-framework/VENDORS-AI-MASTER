/**
 * MITRE ATT&CK Vendor Coverage Agent
 *
 * A specialised ReAct agent whose sole task is to analyse how a given vendor's
 * products address (or fail to address) MITRE ATT&CK techniques.
 *
 * Differences from the ranking ReActAgent:
 *  - Max 3 ReAct iterations (hardcoded per spec, overridable via env).
 *  - Always calls query_mitre_attack first to ground the analysis in the local
 *    knowledge base before touching the web.
 *  - Returns a MitreCoverageReport instead of a VendorAnalysis.
 *  - If no conclusive JSON is produced after exhausting iterations, the report
 *    carries insufficientInfo: true and a plain-English message.
 *
 * Tool priority (matches spec):
 *  1. query_mitre_attack  — local RAG, zero latency, verified ATT&CK data
 *  2. search_web          — official vendor docs, security advisories
 *  3. scrape_url          — deep-read a specific page when needed
 */

import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { LLMClient } from './llm-client';
import { SearchTool, SEARCH_TOOL_DEFINITION } from './tools/search';
import { ScrapeTool, SCRAPE_TOOL_DEFINITION } from './tools/scrape';
import { MitreRagTool, MITRE_TOOL_DEFINITION } from './tools/mitre';
import { PaloAltoRagTool, PALOALTO_RAG_TOOL_DEFINITION } from './tools/paloalto-rag';
import { AgentConfig } from '../types';
import { MitreCoverageReport, TtpCoverage } from '../types/mitre-coverage';

// ─── Constants ────────────────────────────────────────────────────────────────

const MAX_ITERATIONS = parseInt(process.env.MITRE_COVERAGE_MAX_ITERATIONS ?? '3', 10);

const TOOLS = [
  MITRE_TOOL_DEFINITION,
  PALOALTO_RAG_TOOL_DEFINITION,
  SEARCH_TOOL_DEFINITION,
  SCRAPE_TOOL_DEFINITION,
];

// ─── System prompt ────────────────────────────────────────────────────────────

function buildSystemPrompt(vendorName: string): string {
  return `You are a leading cybersecurity analyst specialising in threat intelligence and MITRE ATT&CK framework analysis. Your task is to produce a detailed, evidence-based report on how ${vendorName}'s products address specific ATT&CK Tactics, Techniques, and Procedures (TTPs).

## Tools available
- query_mitre_attack(query)  — ALWAYS call this first. Searches the local MITRE ATT&CK knowledge base and returns verified technique data. Use it to identify which techniques are relevant to ${vendorName} and its security domain.
- search_web(query)          — Search for ${vendorName} official documentation, security advisories, and technical whitepapers. Prioritise official sources (${vendorName}.com, docs.${vendorName.toLowerCase().replace(/\s+/g, '')}.com, security blogs from the vendor).
- scrape_url(url)            — Read a specific page in full when a search result looks highly relevant.

## Research strategy (follow in order)
1. Call query_mitre_attack to retrieve ATT&CK techniques relevant to ${vendorName}'s security domain (e.g. "endpoint detection", "network security", "identity protection").
2. Call search_web to find ${vendorName} official documentation describing how specific products counter those techniques.
3. Call scrape_url on the most relevant official pages to extract precise product names, feature descriptions, and configuration details.

## Strict rules
1. EVIDENCE FIRST — every TTP entry must cite at least one real source URL you actually accessed.
2. DATA SOURCE PRIORITY — official vendor documentation > security advisories > analyst reports > secondary blogs.
3. NO HALLUCINATION — if you cannot find evidence for a technique, omit it or mark coverageLevel "unknown". Never invent product names or feature descriptions.
4. ATT&CK IDs — always use the exact MITRE ATT&CK ID (e.g. T1566, T1078.003). Never fabricate IDs.
5. MAX ITERATIONS — you have at most ${MAX_ITERATIONS} tool-call rounds. If you still lack enough evidence after ${MAX_ITERATIONS} rounds, set insufficientInfo to true and explain why in the summary.

## Coverage level definitions
- "full"    — vendor has a dedicated product feature or control that directly detects/prevents the technique.
- "partial" — vendor provides some capability but it requires additional configuration or third-party integration.
- "none"    — vendor explicitly does not address this technique, or it is outside their product scope.
- "unknown" — insufficient public documentation found.

## Output format
Respond with ONLY the raw JSON object below — no markdown fences, no preamble.

{
  "vendor": "${vendorName}",
  "analysisDate": "<ISO 8601 date>",
  "ttpsAddressed": [
    {
      "techniqueId": "T1566",
      "techniqueName": "Phishing",
      "tactics": ["initial-access"],
      "coverageLevel": "full|partial|none|unknown",
      "products": ["Product Name — specific feature"],
      "description": "One paragraph explaining how ${vendorName} addresses this technique with specific product evidence.",
      "evidenceUrls": ["https://exact-url-you-accessed.com/page"]
    }
  ],
  "coverageGaps": ["T1xxx — Technique Name: brief reason for gap"],
  "overallCoverageScore": 0-10,
  "summary": "2–3 sentences summarising ${vendorName}'s overall ATT&CK coverage, strengths, and key gaps.",
  "sourcesConsulted": ["https://every-url-accessed.com"],
  "insufficientInfo": false
}`;
}

// ─── MitreCoverageAgent ───────────────────────────────────────────────────────

/** Returns true if the vendor name refers to Palo Alto Networks. */
function isPaloAlto(vendorName: string): boolean {
  const n = vendorName.toLowerCase();
  return n.includes('palo alto') || n.includes('paloalto') || n === 'pan' || n === 'panw';
}

export class MitreCoverageAgent {
  private readonly llm:       LLMClient;
  private readonly search:    SearchTool;
  private readonly scrape:    ScrapeTool;
  private readonly mitre:     MitreRagTool;
  private readonly paloalto:  PaloAltoRagTool;

  constructor(config: AgentConfig) {
    this.llm      = new LLMClient(config);
    this.search   = new SearchTool();
    this.scrape   = new ScrapeTool();
    this.mitre    = new MitreRagTool();
    this.paloalto = new PaloAltoRagTool();
  }

  /**
   * Run the coverage analysis for a vendor.
   *
   * @param vendorName  The vendor to analyse (e.g. "Microsoft", "Palo Alto Networks").
   * @param onStep      Optional callback for real-time progress in the CLI.
   */
  async analyseVendor(
    vendorName: string,
    onStep?: (type: string, content: string) => void,
  ): Promise<MitreCoverageReport> {
    const startTime = Date.now();

    // ── Step 0: Pre-inject RAG context ────────────────────────────────────────
    // Always query the RAG upfront and embed the results in the first user
    // message. This guarantees the model has ATT&CK data even if it never
    // calls query_mitre_attack itself (small models often skip tool calls).
    onStep?.('thought', 'Pre-loading MITRE ATT&CK context from local knowledge base…');
    let ragPreamble = '';
    try {
      const preQuery = `${vendorName} security techniques detection endpoint network identity`;
      const ragResult = await this.mitre.run(preQuery, 8);
      if (ragResult && !ragResult.startsWith('MITRE ATT&CK query failed') && !ragResult.startsWith('[MITRE')) {
        ragPreamble = `\n\n## Pre-loaded MITRE ATT&CK Context\n${ragResult}`;
        onStep?.('observation', `RAG pre-load: ${ragResult.slice(0, 200)}`);
      } else {
        onStep?.('observation', `RAG pre-load skipped: ${ragResult.slice(0, 200)}`);
      }
    } catch {
      // Non-fatal — continue without pre-loaded context
    }

    // ── Step 0b: Palo Alto-specific pre-injection ─────────────────────────────
    // When analysing Palo Alto Networks, also query the dedicated PA RAG so
    // the model receives product-specific evidence with confidence scores.
    if (isPaloAlto(vendorName)) {
      onStep?.('thought', 'Palo Alto Networks detected — pre-loading product-specific RAG…');
      try {
        const paAvailable = await this.paloalto.ping();
        if (paAvailable) {
          const paResult = await this.paloalto.run(
            'Palo Alto Networks Cortex XDR Prisma Strata MITRE ATT&CK detection prevention coverage',
            6,
          );
          if (paResult && !paResult.includes('[PaloAlto RAG] No relevant') && !paResult.includes('[PaloAlto RAG] Service not running')) {
            ragPreamble += `\n\n## Pre-loaded Palo Alto Networks Documentation\n${paResult}`;
            onStep?.('observation', `PA RAG pre-load: ${paResult.slice(0, 200)}`);
          }
        } else {
          onStep?.('observation', 'PA RAG service not running — using generic ATT&CK context only. Start with: npm run paloalto:start');
        }
      } catch {
        // Non-fatal
      }
    }

    const messages: ChatCompletionMessageParam[] = [
      { role: 'system', content: buildSystemPrompt(vendorName) },
      {
        role: 'user',
        content:
          `Analyse how ${vendorName} addresses MITRE ATT&CK techniques.` +
          ragPreamble +
          `\n\nNow call query_mitre_attack to find additional relevant techniques for ${vendorName}'s ` +
          `security domain, then use search_web to find evidence in official ${vendorName} documentation. ` +
          `Produce the JSON report described in the system prompt.`,
      },
    ];

    let finalJson: string | null = null;
    let iteration = 0;
    let mitreQueried = false;
    let enforcedMitreRetry = false;

    // ── ReAct loop (max MAX_ITERATIONS) ──────────────────────────────────────
    while (iteration < MAX_ITERATIONS) {
      iteration++;
      onStep?.('thought', `Iteration ${iteration}/${MAX_ITERATIONS}`);

      // Force query_mitre_attack on the first iteration so the model cannot
      // skip it. After that switch to auto so it can choose freely.
      const forceTool = iteration === 1 ? 'query_mitre_attack' : undefined;
      const { toolCalls, text } = await this.llm.chatWithTools(messages, TOOLS, forceTool);

      // ── Model called tools ────────────────────────────────────────────────
      if (toolCalls.length > 0) {
        messages.push({ role: 'assistant', content: text || null, tool_calls: toolCalls });

        for (const call of toolCalls) {
          const fn = call.function.name;
          let args: Record<string, string> = {};
          try { args = JSON.parse(call.function.arguments); } catch { /* use empty */ }

          let result = '';

          if (fn === 'query_mitre_attack') {
            const query = args.query ?? '';
            onStep?.('action', `query_mitre_attack("${query}")`);
            result = await this.mitre.run(query, args.top_k ? parseInt(args.top_k, 10) : undefined);
            mitreQueried = true;
            onStep?.('observation', result.slice(0, 600));

          } else if (fn === 'query_paloalto_rag') {
            const query = args.query ?? '';
            onStep?.('action', `query_paloalto_rag("${query}")`);
            result = await this.paloalto.run(
              query,
              args.top_k       ? parseInt(args.top_k, 10) : undefined,
              args.product_line ?? undefined,
              args.action_type  ?? undefined,
            );
            onStep?.('observation', result.slice(0, 600));

          } else if (fn === 'search_web') {
            const query = args.query ?? '';
            onStep?.('action', `search_web("${query}")`);
            const hits = await this.search.search(query, 8);
            result = hits.length > 0
              ? hits.map((r, i) => `[${i + 1}] ${r.title}\n    URL: ${r.url}\n    ${r.snippet}`).join('\n\n')
              : `No results for: "${query}"`;
            onStep?.('observation', result.slice(0, 600));

          } else if (fn === 'scrape_url') {
            const url = args.url ?? '';
            onStep?.('action', `scrape_url("${url}")`);
            result = await this.scrape.run(url);
            onStep?.('observation', result.slice(0, 600));

          } else {
            result = `Unknown tool: ${fn}`;
          }

          messages.push({ role: 'tool', tool_call_id: call.id, content: result });
        }

        // Some backends only support string tool_choice values and may ignore
        // function-name forcing. If MITRE wasn't called in the first round,
        // add a strict corrective turn and do not consume an iteration budget.
        if (iteration === 1 && !mitreQueried && !enforcedMitreRetry) {
          enforcedMitreRetry = true;
          iteration--;
          onStep?.('thought', 'MITRE tool was skipped; enforcing query_mitre_attack before continuing.');
          messages.push({
            role: 'user',
            content:
              'Before any other tool, call query_mitre_attack now with a focused query for this vendor ' +
              '(for example: vendor name + endpoint/network/identity ATT&CK coverage). ' +
              'Do not return final JSON yet.',
          });
        }

        continue;
      }

      // ── Model replied with text ───────────────────────────────────────────
      if (text) {
        messages.push({ role: 'assistant', content: text });
        finalJson = extractJson(text);
        if (finalJson) {
          onStep?.('answer', finalJson.slice(0, 300));
          break;
        }

        // Has text but no JSON yet — nudge towards output
        if (iteration < MAX_ITERATIONS) {
          messages.push({
            role: 'user',
            content: 'Output the JSON report now. No markdown, no explanation — only the raw JSON object.',
          });
        }
      }
    }

    // ── Final forced JSON attempt ─────────────────────────────────────────────
    if (!finalJson) {
      try {
        messages.push({
          role: 'user',
          content:
            'You have reached the maximum number of iterations. ' +
            'Output whatever JSON you have now. ' +
            'If information is insufficient, set insufficientInfo to true. ' +
            'No markdown — only raw JSON.',
        });
        const { text: forced } = await this.llm.chatWithTools(messages);
        finalJson = extractJson(forced) ?? forced;
      } catch {
        finalJson = null;
      }
    }

    return parseReport(finalJson, vendorName);
  }
}

// ─── JSON helpers ─────────────────────────────────────────────────────────────

function extractJson(raw: string): string | null {
  const clean = raw
    .replace(/^```json\s*/im, '')
    .replace(/^```\s*/im, '')
    .replace(/```\s*$/im, '')
    .trim();
  try { JSON.parse(clean); return clean; } catch { /* fall through */ }
  const match = clean.match(/\{[\s\S]*\}/);
  if (match) {
    try { JSON.parse(match[0]); return match[0]; } catch { /* fall through */ }
  }
  return null;
}

function parseReport(jsonStr: string | null, vendorName: string): MitreCoverageReport {
  if (!jsonStr) {
    return insufficientReport(vendorName, 'Agent produced no parseable JSON response.');
  }

  let data: any = {};
  try {
    data = JSON.parse(jsonStr);
  } catch {
    const m = jsonStr.match(/\{[\s\S]*\}/);
    if (m) try { data = JSON.parse(m[0]); } catch { /* use defaults */ }
  }

  // Normalise ttpsAddressed
  const ttps: TtpCoverage[] = Array.isArray(data.ttpsAddressed)
    ? data.ttpsAddressed.map((t: any): TtpCoverage => ({
        techniqueId:   String(t.techniqueId   ?? ''),
        techniqueName: String(t.techniqueName ?? ''),
        tactics:       Array.isArray(t.tactics)      ? t.tactics      : [],
        coverageLevel: ['full', 'partial', 'none', 'unknown'].includes(t.coverageLevel)
          ? t.coverageLevel
          : 'unknown',
        products:      Array.isArray(t.products)     ? t.products     : [],
        description:   String(t.description  ?? ''),
        evidenceUrls:  Array.isArray(t.evidenceUrls) ? t.evidenceUrls : [],
      }))
    : [];

  if (data.insufficientInfo === true && ttps.length === 0) {
    return insufficientReport(
      vendorName,
      typeof data.summary === 'string' && data.summary
        ? data.summary
        : 'Insufficient Information – Unable to provide a complete response.',
    );
  }

  return {
    vendor:               String(data.vendor ?? vendorName),
    analysisDate:         String(data.analysisDate ?? new Date().toISOString()),
    ttpsAddressed:        ttps,
    coverageGaps:         Array.isArray(data.coverageGaps)      ? data.coverageGaps      : [],
    overallCoverageScore: typeof data.overallCoverageScore === 'number'
      ? Math.min(10, Math.max(0, data.overallCoverageScore))
      : 0,
    summary:              String(data.summary          ?? ''),
    sourcesConsulted:     Array.isArray(data.sourcesConsulted)  ? data.sourcesConsulted  : [],
    insufficientInfo:     Boolean(data.insufficientInfo),
  };
}

function insufficientReport(vendorName: string, reason: string): MitreCoverageReport {
  return {
    vendor:               vendorName,
    analysisDate:         new Date().toISOString(),
    ttpsAddressed:        [],
    coverageGaps:         [],
    overallCoverageScore: 0,
    summary:              reason,
    sourcesConsulted:     [],
    insufficientInfo:     true,
  };
}
