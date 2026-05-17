/**
 * MITRE ATT&CK Intelligence Agent
 *
 * Query-driven ReAct agent for deep ATT&CK analysis using:
 *  1) local MITRE RAG grounding,
 *  2) web search,
 *  3) targeted page scraping.
 *
 * The agent no longer assumes vendor-centric analysis. It answers broad threat
 * intelligence questions (techniques, tactics, detections, mitigations, groups,
 * software, campaigns) and returns a MitreCoverageReport-shaped JSON payload.
 */

import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { LLMClient } from './llm-client';
import { SearchTool, SEARCH_TOOL_DEFINITION } from './tools/search';
import { ScrapeTool, SCRAPE_TOOL_DEFINITION } from './tools/scrape';
import { MitreRagTool, MITRE_TOOL_DEFINITION } from './tools/mitre';
import { AgentConfig } from '../types';
import { MitreCoverageReport, TtpCoverage } from '../types/mitre-coverage';

// ─── Constants ────────────────────────────────────────────────────────────────

const MAX_ITERATIONS = parseInt(process.env.MITRE_COVERAGE_MAX_ITERATIONS ?? '8', 10);
const MIN_RAG_PHASE_ITERATIONS = parseInt(process.env.MITRE_RAG_PHASE_ITERATIONS ?? '2', 10);
const MIN_RAG_CALLS_BEFORE_WEB = parseInt(process.env.MITRE_RAG_MIN_CALLS ?? '3', 10);
const ANALYSIS_SCOPE = 'MITRE Threat Intelligence';

const TOOLS = [
  MITRE_TOOL_DEFINITION,
  SEARCH_TOOL_DEFINITION,
  SCRAPE_TOOL_DEFINITION,
];

// ─── System prompt ────────────────────────────────────────────────────────────

function buildSystemPrompt(userQuery: string): string {
  return `You are an elite cybersecurity threat intelligence analyst specialised in MITRE ATT&CK.

Your objective is to produce a high-fidelity, evidence-based ATT&CK analysis for this user query:
"${userQuery}"

Think like a senior incident responder + detection engineer + CTI lead. Use all available tool power and maximize analytical quality.

## Tools available
- query_mitre_attack(query)  — ALWAYS call this first. Ground the analysis using local ATT&CK data.
- search_web(query)          — Expand with current threat intel, official guidance, and high-quality technical sources.
- scrape_url(url)            — Deep-read the strongest sources for precise evidence.

## Research strategy (follow in order)
1. PHASE 1 (RAG-FIRST, mandatory): run multiple query_mitre_attack calls with different focused sub-queries (core techniques, detections, mitigations, platform specifics).
2. Build a short internal synthesis from RAG findings: what is known, what is uncertain, and what gaps remain.
3. PHASE 2 (WEB ENRICHMENT): only after RAG synthesis, use search_web with targeted queries for unresolved gaps.
4. Use scrape_url on top sources to capture concrete evidence and remove ambiguity.
5. Synthesize findings into technically actionable ATT&CK coverage conclusions.

## Strict rules
1. EVIDENCE FIRST — every TTP entry must include at least one URL actually consulted.
2. SOURCE QUALITY — prioritise: MITRE ATT&CK > CISA/ENISA/NCSC > vendor advisories > respected CTI research.
3. NO HALLUCINATION — if evidence is weak, use coverageLevel "unknown".
4. ATT&CK INTEGRITY — use exact ATT&CK IDs only.
5. BE COMPREHENSIVE — prefer fewer high-confidence claims over broad low-quality claims.
6. MAX ITERATIONS — you have up to ${MAX_ITERATIONS} rounds of tool use; use them to improve quality.
7. PHASE GATING — do NOT call search_web or scrape_url until you have completed several query_mitre_attack calls and RAG synthesis.

## Coverage level definitions
- "full"    — strong, direct and explicit detection/prevention/mitigation evidence.
- "partial" — some evidence exists but is incomplete, indirect, or context-dependent.
- "none"    — explicit evidence of non-coverage or clear mismatch with scope.
- "unknown" — insufficient reliable evidence.

## Output format
Respond with ONLY the raw JSON object below — no markdown fences, no preamble.

{
  "vendor": "${ANALYSIS_SCOPE}",
  "analysisDate": "<ISO 8601 date>",
  "ttpsAddressed": [
    {
      "techniqueId": "T1566",
      "techniqueName": "Phishing",
      "tactics": ["initial-access"],
      "coverageLevel": "full|partial|none|unknown",
      "products": ["Detection/mitigation control or analytic approach"],
      "description": "One concise paragraph linking ATT&CK context to practical detection/mitigation insight.",
      "evidenceUrls": ["https://exact-url-you-accessed.com/page"]
    }
  ],
  "coverageGaps": ["T1xxx — Technique Name: brief reason for gap"],
  "overallCoverageScore": 0-10,
  "summary": "3-5 sentences with key findings, confidence caveats, and actionable next steps.",
  "sourcesConsulted": ["https://every-url-accessed.com"],
  "insufficientInfo": false
}`;
}

// ─── MitreCoverageAgent ───────────────────────────────────────────────────────

export class MitreCoverageAgent {
  private readonly llm:       LLMClient;
  private readonly search:    SearchTool;
  private readonly scrape:    ScrapeTool;
  private readonly mitre:     MitreRagTool;

  constructor(config: AgentConfig) {
    this.llm      = new LLMClient(config);
    this.search   = new SearchTool();
    this.scrape   = new ScrapeTool();
    this.mitre    = new MitreRagTool();
  }

  /**
   * Run MITRE ATT&CK analysis for a free-form intelligence query.
   */
  async analyseCoverage(
    queryText: string,
    onStep?: (type: string, content: string) => void,
  ): Promise<MitreCoverageReport> {
    const effectiveQuery = queryText.trim();
    if (!effectiveQuery) {
      return insufficientReport('Empty query. Provide a MITRE-focused question or topic.');
    }

    // ── Step 0: Pre-inject RAG context ────────────────────────────────────────
    // Always query the RAG upfront and embed the results in the first user
    // message. This guarantees the model has ATT&CK data even if it never
    // calls query_mitre_attack itself (small models often skip tool calls).
    onStep?.('thought', 'Pre-loading MITRE ATT&CK context from local knowledge base…');
    let ragPreamble = '';
    try {
      const preQuery = `${effectiveQuery} ATT&CK technique detection mitigation telemetry`;
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

    const messages: ChatCompletionMessageParam[] = [
      { role: 'system', content: buildSystemPrompt(effectiveQuery) },
      {
        role: 'user',
        content:
          `Analyse this MITRE ATT&CK intelligence query in depth: "${effectiveQuery}".` +
          ragPreamble +
          `\n\nUse all tools strategically: first query_mitre_attack, then multiple focused search_web calls, ` +
          `and scrape_url for top sources. ` +
          `Produce the JSON report described in the system prompt.`,
      },
    ];

    let finalJson: string | null = null;
    let iteration = 0;
    let mitreCallCount = 0;
    let webCallCount = 0;
    let scrapeCallCount = 0;
    let enforcedMitreRetry = false;
    let ragPhaseTransitionInjected = false;

    // ── ReAct loop (max MAX_ITERATIONS) ──────────────────────────────────────
    while (iteration < MAX_ITERATIONS) {
      iteration++;
      onStep?.('thought', `Iteration ${iteration}/${MAX_ITERATIONS}`);

      // Hard-gate phase 1: the first iterations are RAG-only.
      const forceTool = iteration <= MIN_RAG_PHASE_ITERATIONS ? 'query_mitre_attack' : undefined;
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
            mitreCallCount++;
            onStep?.('observation', result.slice(0, 600));

          } else if (fn === 'search_web') {
            if (mitreCallCount < MIN_RAG_CALLS_BEFORE_WEB) {
              result =
                `search_web deferred: complete RAG-first phase first ` +
                `(${mitreCallCount}/${MIN_RAG_CALLS_BEFORE_WEB} query_mitre_attack calls).`;
              onStep?.('observation', result);
              messages.push({ role: 'tool', tool_call_id: call.id, content: result });
              continue;
            }
            const query = args.query ?? '';
            onStep?.('action', `search_web("${query}")`);
            const hits = await this.search.search(query, 10);
            result = hits.length > 0
              ? hits.map((r, i) => `[${i + 1}] ${r.title}\n    URL: ${r.url}\n    ${r.snippet}`).join('\n\n')
              : `No results for: "${query}"`;
            webCallCount++;
            onStep?.('observation', result.slice(0, 600));

          } else if (fn === 'scrape_url') {
            if (mitreCallCount < MIN_RAG_CALLS_BEFORE_WEB) {
              result =
                `scrape_url deferred: complete RAG-first phase first ` +
                `(${mitreCallCount}/${MIN_RAG_CALLS_BEFORE_WEB} query_mitre_attack calls).`;
              onStep?.('observation', result);
              messages.push({ role: 'tool', tool_call_id: call.id, content: result });
              continue;
            }
            const url = args.url ?? '';
            onStep?.('action', `scrape_url("${url}")`);
            result = await this.scrape.run(url);
            scrapeCallCount++;
            onStep?.('observation', result.slice(0, 600));

          } else {
            result = `Unknown tool: ${fn}`;
          }

          messages.push({ role: 'tool', tool_call_id: call.id, content: result });
        }

        // Some backends only support string tool_choice values and may ignore
        // function-name forcing. If MITRE wasn't called in the first round,
        // add a strict corrective turn and do not consume an iteration budget.
        if (iteration === 1 && mitreCallCount === 0 && !enforcedMitreRetry) {
          enforcedMitreRetry = true;
          iteration--;
          onStep?.('thought', 'MITRE tool was skipped; enforcing query_mitre_attack before continuing.');
          messages.push({
            role: 'user',
            content:
              'Before any other tool, call query_mitre_attack now with a focused query for this analysis topic ' +
              '(for example: the user query + ATT&CK techniques/detections/mitigations). ' +
              'Do not return final JSON yet.',
          });
        }

        // Inject an explicit transition from RAG grounding to web enrichment.
        if (
          !ragPhaseTransitionInjected &&
          mitreCallCount >= MIN_RAG_CALLS_BEFORE_WEB &&
          webCallCount === 0 &&
          scrapeCallCount === 0
        ) {
          ragPhaseTransitionInjected = true;
          messages.push({
            role: 'user',
            content:
              'RAG phase complete. Now do a brief synthesis of ATT&CK findings and identify top evidence gaps. ' +
              'Then call search_web and scrape_url only for those unresolved gaps, and finally return full JSON.',
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

    return parseReport(finalJson);
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

function parseReport(jsonStr: string | null): MitreCoverageReport {
  if (!jsonStr) {
    return insufficientReport('Agent produced no parseable JSON response.');
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
      typeof data.summary === 'string' && data.summary
        ? data.summary
        : 'Insufficient Information – Unable to provide a complete response.',
    );
  }

  return {
    vendor:               ANALYSIS_SCOPE,
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

function insufficientReport(reason: string): MitreCoverageReport {
  return {
    vendor:               ANALYSIS_SCOPE,
    analysisDate:         new Date().toISOString(),
    ttpsAddressed:        [],
    coverageGaps:         [],
    overallCoverageScore: 0,
    summary:              reason,
    sourcesConsulted:     [],
    insufficientInfo:     true,
  };
}
