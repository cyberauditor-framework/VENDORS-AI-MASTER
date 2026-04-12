import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import {
  AgentConfig,
  ReActStep,
  VendorAnalysis,
  Vendor,
  RankingCriteria,
  SearchRecord,
  AcquisitionMode,
  MarketPosition,
  GeographicRegion,
} from '../types';
import { LLMClient } from './llm-client';
import { SearchTool, SEARCH_TOOL_DEFINITION } from './tools/search';
import { ScrapeTool,  SCRAPE_TOOL_DEFINITION  } from './tools/scrape';
import { MitreRagTool, MITRE_TOOL_DEFINITION  } from './tools/mitre';
import {
  calculateWeightedScore as calculateCategoryWeightedScore,
  getCriteriaProfileForCategory,
} from '../analysis/ranking';

// ─── System Prompt ────────────────────────────────────────────────────────────

function buildSystemPrompt(categoryName: string): string {
  const criteriaProfile = getCriteriaProfileForCategory(categoryName);
  const criteriaList = criteriaProfile
    .map((c, i) => `${i + 1}. ${c.label} (${(c.weight * 100).toFixed(0)}%) [${c.category}]`)
    .join('\n');
  const rankingCriteriaSchema = criteriaProfile
    .map(c => `    "${c.key}": 0-10`)
    .join(',\n');
  const rationaleSchema = criteriaProfile
    .map(c => `    "${c.key}": "One sentence citing specific evidence for this score"`)
    .join(',\n');
  const evidenceSchema = criteriaProfile
    .map(c => `    "${c.key}": ["https://..."]`)
    .join(',\n');

  return `You are a senior cybersecurity analyst conducting rigorous, evidence-based vendor research for an enterprise knowledge base. Accuracy and traceability are paramount.

## Tools
- search_web(query)           — search the internet; use 3-5 targeted queries covering: overview, pricing, certifications, analyst recognition, recent news/awards.
- scrape_url(url)             — read a full page; scrape the vendor's official website AND at least one independent analyst or review source.
- query_mitre_attack(query)   — semantic search over the MITRE ATT&CK knowledge base; use this to identify which ATT&CK techniques a vendor detects or mitigates, grounding your scoring in verified framework data. Always cite the returned ATT&CK IDs and URLs.

## Strict research rules
1. EVIDENCE FIRST — every score and every field must be supported by something you actually found. Do not infer or assume.
2. NO HALLUCINATION — never fabricate certifications, awards, features or pricing. If a fact cannot be confirmed, omit it or use the conservative defaults listed below.
3. CERTIFICATIONS — only list ones explicitly confirmed in official documentation, trust centres, or press releases. Include the standard name exactly (e.g. "ISO 27001:2022", "SOC 2 Type II", "FedRAMP Moderate").
4. AWARDS — include year and exact award name as found in sources (e.g. "Gartner Magic Quadrant Leader 2024 – SIEM"). Omit if year or category cannot be confirmed.
5. PRICING — describe the actual pricing model (tiers, per-seat, consumption-based, etc.) as found. If undisclosed, write "Enterprise pricing – contact vendor".
6. WEBSITE — must be the canonical official domain. Do not use blog subdomains or redirect URLs.
7. RESOURCE LINKS — only include the exact URLs you actually accessed that contained meaningful information. Verify each URL is complete and starts with https://.
8. SOURCES USED — record every URL you searched or scraped that informed your analysis.
9. RATIONALE — for every rankingCriteria score, write one concrete sentence citing the specific evidence that justifies that number.
10. CRITERION EVIDENCE — for each criterion include at least 1-3 high-quality URLs proving the claim (vendor docs, analyst reports, trust centers, technical write-ups).

## Scoring rubric (apply to every criterion)
| Score | Meaning |
|-------|---------|
| 0–2   | Non-existent or critically deficient |
| 3–4   | Below category average; notable gaps |
| 5–6   | Meets category baseline; no major gaps |
| 7–8   | Above average; strong, differentiated offering |
| 9–10  | Best-in-class; clear category leader |

## Category-specific criteria for ${categoryName}
${criteriaList}

## Output format
Respond with ONLY the raw JSON object below — no markdown fences, no preamble, no explanation.

{
  "name": "string — official product/vendor name",
  "description": "3-4 sentence factual description covering what the product does, who it targets, and its main differentiator",
  "advantages": ["specific, evidence-backed advantage", ...],
  "disadvantages": ["specific, evidence-backed disadvantage", ...],
  "pricingModel": "string — actual pricing structure found, or 'Enterprise pricing – contact vendor'",
  "foundedYear": number | null,
  "securityCertifications": ["ISO 27001:2022", "SOC 2 Type II", ...],
  "geographicRegion": "global|north-america|europe|asia-pacific|latin-america|middle-east-africa|unknown",
  "resourceLinks": ["https://exact-url-you-accessed.com/page", ...],
  "awards": ["Exact Award Name Year – Category", ...],
  "acquisitionMode": "commercial|open-source|freemium|subscription|license|cloud-only|hybrid|unknown",
  "website": "https://official-domain.com",
  "marketPosition": "leader|challenger|visionary|niche|unknown",
  "rankingCriteria": {
${rankingCriteriaSchema}
  },
  "rationale": {
${rationaleSchema},
    "overall":              "2-3 sentence summary justifying the final weighted score and market position"
  },
  "criterionEvidence": {
${evidenceSchema}
  },
  "sourcesUsed": ["https://every-url-accessed.com", ...]
}`;
}

// Tools passed to every chat completion call
const TOOLS = [SEARCH_TOOL_DEFINITION, SCRAPE_TOOL_DEFINITION, MITRE_TOOL_DEFINITION];

// ─── ReAct Agent ──────────────────────────────────────────────────────────────

export class ReActAgent {
  private llm:    LLMClient;
  private search: SearchTool;
  private scrape: ScrapeTool;
  private mitre:  MitreRagTool;
  private config: AgentConfig;

  constructor(config: AgentConfig) {
    this.config = config;
    this.llm    = new LLMClient(config);
    this.search = new SearchTool();
    this.scrape = new ScrapeTool();
    this.mitre  = new MitreRagTool();
  }

  async analyzeVendor(
    vendorName:   string,
    categoryName: string,
    categoryId:   number,
    onStep?: (step: ReActStep) => void,
  ): Promise<VendorAnalysis> {
    const startTime = Date.now();
    const steps:         ReActStep[]    = [];
    const searchRecords: SearchRecord[] = [];

    const addStep = (type: ReActStep['type'], content: string) => {
      const step: ReActStep = { type, content, timestamp: new Date().toISOString() };
      steps.push(step);
      onStep?.(step);
    };

    // Build the conversation history in OpenAI format
    const messages: ChatCompletionMessageParam[] = [
      { role: 'system', content: buildSystemPrompt(categoryName) },
      {
        role: 'user',
        content:
          `Research the following vendor and extract structured data.\n\n` +
          `Vendor: ${vendorName}\nCategory: ${categoryName}\n\n` +
          `Use the search_web and scrape_url tools to gather information, then output the JSON.`,
      },
    ];

    let finalJson: string | null = null;
    let iteration = 0;

    while (iteration < this.config.maxReActIterations) {
      iteration++;

      // ── Ask the model ──────────────────────────────────────────────────────
      const { toolCalls, text } = await this.llm.chatWithTools(messages, TOOLS);

      // ── Model wants to call tools ──────────────────────────────────────────
      if (toolCalls.length > 0) {
        // Record the assistant turn (with its tool_calls)
        messages.push({ role: 'assistant', content: text || null, tool_calls: toolCalls });

        for (const call of toolCalls) {
          const fnName = call.function.name;
          let args: Record<string, string>;
          try {
            args = JSON.parse(call.function.arguments);
          } catch {
            args = {};
          }

          let result = '';

          if (fnName === 'search_web') {
            const query = args.query ?? '';
            addStep('action', `search_web("${query}")`);

            // Single call — reuse results for both the LLM context and search records
            const searchResults = await this.search.search(query, this.config.maxSearchResults);

            searchResults.forEach(r => {
              searchRecords.push({ query, sourceUrl: r.url, snippet: r.snippet });
            });

            result = searchResults.length > 0
              ? searchResults
                  .map((r, i) => `[${i + 1}] ${r.title}\n    URL: ${r.url}\n    ${r.snippet || '(no snippet)'}`)
                  .join('\n\n')
              : `No results found for: "${query}". Try a shorter or different query.`;

            addStep('observation', result.slice(0, 800));

          } else if (fnName === 'scrape_url') {
            const url = args.url ?? '';
            addStep('action', `scrape_url("${url}")`);

            result = await this.scrape.run(url);

            searchRecords.push({
              query:          `scrape: ${vendorName}`,
              sourceUrl:      url,
              snippet:        result.slice(0, 300),
              scrapedContent: result,
            });

            addStep('observation', result.slice(0, 800));

          } else if (fnName === 'query_mitre_attack') {
            const query = args.query ?? '';
            const topK  = args.top_k ? parseInt(String(args.top_k), 10) : undefined;
            addStep('action', `query_mitre_attack("${query}")`);

            result = await this.mitre.run(query, topK);

            addStep('observation', result.slice(0, 800));

          } else {
            result = `Unknown tool: ${fnName}`;
          }

          // Inject the tool result back into the conversation
          messages.push({
            role:         'tool',
            tool_call_id: call.id,
            content:      result,
          });
        }

        // Continue the loop so the model can decide what to do next
        continue;
      }

      // ── Model replied with text (should be the final JSON) ─────────────────
      if (text) {
        addStep('thought', text.slice(0, 300));
        messages.push({ role: 'assistant', content: text });

        // Try to parse JSON from the response
        finalJson = extractJson(text);
        if (finalJson) {
          addStep('answer', finalJson.slice(0, 300));
          break;
        }

        // Model replied with text but no JSON yet — ask it to produce the JSON
        if (iteration < this.config.maxReActIterations - 1) {
          messages.push({
            role:    'user',
            content: 'You have gathered enough information. Now output ONLY the JSON object described above — no markdown, no explanation.',
          });
        }
      }
    }

    // If we still have no JSON after all iterations, do one final forced request
    if (!finalJson) {
      try {
        messages.push({
          role:    'user',
          content: 'Output the JSON now. No tools, no explanation — just the raw JSON object.',
        });
        const { text: forced } = await this.llm.chatWithTools(messages);
        finalJson = extractJson(forced) ?? forced;
        addStep('answer', (finalJson ?? '{}').slice(0, 300));
      } catch {
        finalJson = '{}';
      }
    }

    // ── Parse the final JSON ──────────────────────────────────────────────────
    const data   = parseFinalJson(finalJson ?? '{}', vendorName, categoryName);
    const vendor: Vendor = {
      name:                   vendorName,
      categoryId,
      categoryName,
      description:            data.description,
      advantages:             data.advantages,
      disadvantages:          data.disadvantages,
      pricingModel:           data.pricingModel,
      foundedYear:            data.foundedYear,
      securityCertifications: data.securityCertifications,
      geographicRegion:       data.geographicRegion as GeographicRegion,
      resourceLinks:          data.resourceLinks,
      awards:                 data.awards,
      acquisitionMode:        data.acquisitionMode as AcquisitionMode,
      website:                data.website,
      rankingScore:           calculateCategoryWeightedScore(data.rankingCriteria, categoryName),
      marketPosition:         data.marketPosition as MarketPosition,
      criterionEvidence:      data.criterionEvidence,
      rawAnalysis:            finalJson ?? undefined,
    };

    const rankingCriteria: Omit<RankingCriteria, 'id' | 'vendorId'> = data.rankingCriteria;

    addStep('reflection', buildReflection(vendor));

    return {
      vendor,
      rankingCriteria: { ...rankingCriteria, vendorId: 0 },
      searchRecords,
      reactSteps:      steps,
      processingTimeMs: Date.now() - startTime,
    };
  }
}

// ─── JSON helpers ─────────────────────────────────────────────────────────────

/** Extract the first valid {...} JSON block from a string. */
function extractJson(raw: string): string | null {
  // Strip markdown fences
  const clean = raw
    .replace(/^```json\s*/im, '')
    .replace(/^```\s*/im,     '')
    .replace(/```\s*$/im,     '')
    .trim();

  // Direct parse
  try { JSON.parse(clean); return clean; } catch { /* fall through */ }

  // Find first {...} block (may span lines)
  const match = clean.match(/\{[\s\S]*\}/);
  if (match) {
    try { JSON.parse(match[0]); return match[0]; } catch { /* fall through */ }
  }
  return null;
}

function parseFinalJson(jsonStr: string, vendorName: string, categoryName: string): any {
  let data: any = {};
  try {
    data = JSON.parse(jsonStr);
  } catch {
    const m = jsonStr.match(/\{[\s\S]*\}/);
    if (m) try { data = JSON.parse(m[0]); } catch { /* use defaults */ }
  }

  const profile = getCriteriaProfileForCategory(categoryName);
  const defaultCriteria = profile.reduce((acc, item) => {
    (acc as any)[item.key] = 5;
    return acc;
  }, {} as Record<string, number>);

  const defaultCriterionEvidence = profile.reduce((acc, item) => {
    acc[item.key] = [];
    return acc;
  }, {} as Record<string, string[]>);

  // Merge and normalize source links so persisted URLs are clickable in UI/reports.
  const resourceLinks: string[] = Array.isArray(data.resourceLinks) ? data.resourceLinks : [];
  const sourcesUsed:   string[] = Array.isArray(data.sourcesUsed)   ? data.sourcesUsed   : [];
  const allLinks = [...new Set([...resourceLinks, ...sourcesUsed])]
    .map(normalizeHttpUrl)
    .filter((u): u is string => Boolean(u));

  // Normalize website and fall back to first valid source when model returns an invalid value.
  const normalizedWebsite = normalizeHttpUrl(data.website);
  const website = normalizedWebsite ?? allLinks[0] ?? '';

  return {
    name:                   data.name                                            ?? vendorName,
    description:            data.description                                     ?? `${vendorName} is a cybersecurity/AI solution provider.`,
    advantages:             Array.isArray(data.advantages)    ? data.advantages    : [],
    disadvantages:          Array.isArray(data.disadvantages) ? data.disadvantages : [],
    pricingModel:           data.pricingModel                                    ?? 'Enterprise pricing – contact vendor',
    foundedYear:            typeof data.foundedYear === 'number' ? data.foundedYear : null,
    securityCertifications: Array.isArray(data.securityCertifications) ? data.securityCertifications : [],
    geographicRegion:       data.geographicRegion                                ?? 'unknown',
    resourceLinks:          allLinks,
    awards:                 Array.isArray(data.awards)        ? data.awards        : [],
    acquisitionMode:        data.acquisitionMode                                 ?? 'unknown',
    website,
    marketPosition:         data.marketPosition                                  ?? 'unknown',
    rankingCriteria:        { ...defaultCriteria, ...(data.rankingCriteria ?? {}) },
    rationale:              (data.rationale && typeof data.rationale === 'object') ? data.rationale : null,
    criterionEvidence:      {
      ...defaultCriterionEvidence,
      ...((data.criterionEvidence && typeof data.criterionEvidence === 'object') ? data.criterionEvidence : {}),
    },
    sourcesUsed:            allLinks,
  };
}

function normalizeHttpUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;

  let value = raw.trim();
  if (!value) return null;

  // Unwrap markdown links: [label](url)
  const md = value.match(/^\[[^\]]+\]\(([^)]+)\)$/);
  if (md?.[1]) value = md[1].trim();

  // Strip wrapping quotes and punctuation frequently produced by models.
  value = value.replace(/^['"`\s]+|['"`\s,.;:!?]+$/g, '');
  if (!value) return null;

  // Convert schemeless URLs into absolute HTTPS links.
  if (value.startsWith('//')) value = `https:${value}`;
  if (!/^https?:\/\//i.test(value)) value = `https://${value}`;

  try {
    const u = new URL(value);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (!u.hostname) return null;
    return u.toString();
  } catch {
    return null;
  }
}

function buildReflection(vendor: Vendor): string {
  const gaps: string[] = [];
  if (!vendor.website)                        gaps.push('no website');
  if (!vendor.foundedYear)                    gaps.push('founded year unknown');
  if (vendor.advantages.length === 0)         gaps.push('no advantages extracted');
  if (vendor.securityCertifications.length === 0) gaps.push('no certifications');

  const base = `Score: ${vendor.rankingScore.toFixed(2)}/10 — Position: ${vendor.marketPosition}`;
  return gaps.length === 0 ? `Analysis complete. ${base}.` : `Completed with gaps (${gaps.join(', ')}). ${base}.`;
}
