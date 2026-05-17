import axios from 'axios';
import * as cheerio from 'cheerio';
import type { WebSearchResult } from '../../types';
import { searchConfig } from '../../config';

// ─── OpenAI Tool Definition ───────────────────────────────────────────────────
// Used when passing `tools` to the chat completion API.

export const SEARCH_TOOL_DEFINITION = {
  type: 'function' as const,
  function: {
    name: 'search_web',
    description:
      'Search the internet for up-to-date information about a cybersecurity or AI vendor. ' +
      'Returns a list of relevant web pages with titles, URLs and snippets.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            'The search query. Be specific — include the vendor name, product category and the aspect you want to research (e.g. "CrowdStrike Falcon pricing 2024", "Splunk certifications ISO 27001").',
        },
      },
      required: ['query'],
    },
  },
} as const;

// ─── Rate Limiter ─────────────────────────────────────────────────────────────

class RateLimiter {
  private lastCall = 0;
  async wait(): Promise<void> {
    const wait = searchConfig.rateLimitMs - (Date.now() - this.lastCall);
    if (wait > 0) await delay(wait);
    this.lastCall = Date.now();
  }
}

const delay = (ms: number) => new Promise(r => setTimeout(r, ms));

// ─── SearchTool ───────────────────────────────────────────────────────────────

/**
 * Performs web searches using multiple backends with automatic fallback:
 *
 *  1. DuckDuckGo Lite  – lightweight HTML, minimal bot detection
 *  2. Bing             – HTML scraping, very reliable
 *  3. DuckDuckGo JSON  – instant-answer API, last resort
 *
 * No API key required for any backend.
 * `run()` always returns a human-readable string (for tool-call result injection).
 * `search()` returns typed WebSearchResult[] for programmatic use.
 */
export class SearchTool {
  private limiter = new RateLimiter();
  private userAgents = buildUserAgentPool(searchConfig.userAgent);

  // ── Called by the agent after a tool_call ──────────────────────────────────
  async run(query: string, maxResults = 8): Promise<string> {
    const results = await this.search(query, maxResults);
    if (results.length === 0) {
      return `No results found for: "${query}". Try a shorter or different query.`;
    }
    return results
      .map(
        (r, i) =>
          `[${i + 1}] ${r.title}\n` +
          `    URL: ${r.url}\n` +
          `    ${r.snippet || '(no snippet)'}`,
      )
      .join('\n\n');
  }

  // ── Returns typed results (for tests / direct use) ─────────────────────────
  async search(query: string, maxResults = 8): Promise<WebSearchResult[]> {
    await this.limiter.wait();
    const q = sanitise(query);
    const variants = buildQueryVariants(q);

    for (const candidate of variants) {
      const ddg = await this.ddgLite(candidate, maxResults);
      if (ddg.length > 0) return uniqueByUrl(ddg).slice(0, maxResults);

      const bing = await this.bing(candidate, maxResults);
      if (bing.length > 0) return uniqueByUrl(bing).slice(0, maxResults);

      const instant = await this.ddgInstant(candidate, maxResults);
      if (instant.length > 0) return uniqueByUrl(instant).slice(0, maxResults);
    }

    return [];
  }

  // ── 1. DuckDuckGo Lite ─────────────────────────────────────────────────────

  private async ddgLite(query: string, max: number): Promise<WebSearchResult[]> {
    // Retry once with a short back-off — DDG Lite occasionally returns 202
    // (soft rate-limit) with an empty page; a single retry almost always succeeds.
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt > 0) await delay(2000);
      for (const ua of this.userAgents) {
        try {
          const res = await axios.get('https://lite.duckduckgo.com/lite/', {
            params: { q: query },
            headers: {
              'User-Agent': ua,
              Accept: 'text/html,application/xhtml+xml',
              'Accept-Language': 'en-US,en;q=0.9',
              Referer: 'https://lite.duckduckgo.com/',
            },
            timeout: searchConfig.requestTimeoutMs,
            maxRedirects: 5,
            validateStatus: (s) => s < 500,
          });

          const $ = cheerio.load(res.data as string);
          const titles = $('a.result-link');
          const snippets = $('td.result-snippet');
          const results: WebSearchResult[] = [];

          titles.each((i, el) => {
            const title = $(el).text().trim();
            const rawHref = $(el).attr('href') ?? '';
            const url = unwrapDdgRedirect(rawHref);
            const snippet = $(snippets[i]).text().trim();
            if (title && url) results.push({ title, url, snippet, source: 'duckduckgo-lite' });
          });

          if (results.length > 0) return results.slice(0, max);

          // DDG can respond with soft-rate-limit pages (202). Try next UA / retry loop.
          if (res.status === 202) continue;
        } catch {
          // try next UA or fall through to Bing
        }
      }
    }
    return [];
  }

  // ── 2. Bing HTML scraping ──────────────────────────────────────────────────

  private async bing(query: string, max: number): Promise<WebSearchResult[]> {
    for (const ua of this.userAgents) {
      try {
        const res = await axios.get('https://www.bing.com/search', {
          params: { q: query, count: max },
          headers: {
            'User-Agent': ua,
            Accept: 'text/html,application/xhtml+xml',
            'Accept-Language': 'en-US,en;q=0.9',
          },
          timeout: searchConfig.requestTimeoutMs,
          maxRedirects: 3,
          validateStatus: (s) => s < 500,
        });

        const $ = cheerio.load(res.data as string);
        const results: WebSearchResult[] = [];

        $('li.b_algo').each((_i, el) => {
          const anchor = $(el).find('h2 a').first();
          const snippet = $(el).find('.b_caption p, .b_algoSlug').first();

          const title = anchor.text().trim();
          const url = anchor.attr('href') ?? '';
          const snip = snippet.text().trim();

          if (title && url.startsWith('http')) {
            results.push({ title, url, snippet: snip, source: 'bing' });
          }
        });

        if (results.length > 0) return results.slice(0, max);
      } catch {
        // Try next UA.
      }
    }

    return [];
  }

  // ── 3. DuckDuckGo Instant Answer JSON ──────────────────────────────────────

  private async ddgInstant(query: string, max: number): Promise<WebSearchResult[]> {
    try {
      const res = await axios.get('https://api.duckduckgo.com/', {
        params: { q: query, format: 'json', no_html: 1, skip_disambig: 1 },
        headers: { 'User-Agent': searchConfig.userAgent },
        timeout: searchConfig.requestTimeoutMs,
      });

      const data = res.data as any;
      const results: WebSearchResult[] = [];

      if (data.AbstractURL && data.Abstract) {
        results.push({
          title:   data.Heading ?? query,
          url:     data.AbstractURL,
          snippet: data.Abstract,
          source:  'duckduckgo-instant',
        });
      }

      (data.RelatedTopics ?? []).slice(0, max - 1).forEach((t: any) => {
        if (t.FirstURL && t.Text) {
          results.push({ title: t.Text.slice(0, 80), url: t.FirstURL, snippet: t.Text, source: 'duckduckgo-instant' });
        }
      });

      return results.slice(0, max);
    } catch {
      return [];
    }
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sanitise(q: string): string {
  return q.replace(/[<>"'`]/g, '').trim().slice(0, 200);
}

function unwrapDdgRedirect(raw: string): string {
  if (!raw) return '';
  if (raw.startsWith('//duckduckgo.com/l/?')) {
    try {
      const u = new URL('https:' + raw);
      const uddg = u.searchParams.get('uddg');
      if (uddg) return decodeURIComponent(uddg);
    } catch {
      return raw;
    }
  }
  if (raw.startsWith('http://') || raw.startsWith('https://')) return raw;
  return 'https://' + raw;
}

function buildUserAgentPool(primary: string): string[] {
  const fallbackAgents = [
    'Mozilla/5.0',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
  ];

  const pool = [primary, ...fallbackAgents]
    .map(v => String(v ?? '').trim())
    .filter(Boolean);

  return Array.from(new Set(pool));
}

function buildQueryVariants(query: string): string[] {
  const words = query.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [''];

  const noiseTerms = new Set([
    'features',
    'feature',
    'pricing',
    'price',
    'certifications',
    'certification',
    'analyst',
    'reports',
    'report',
    'review',
    'reviews',
    'overview',
  ]);

  const compact = words
    .filter(w => !noiseTerms.has(w.toLowerCase()))
    .join(' ')
    .trim();

  const short = words.slice(0, 5).join(' ').trim();
  const brand = words.slice(0, 2).join(' ').trim();

  const variants = [query, compact, short, brand]
    .map(v => v.trim())
    .filter(v => v.length >= 3);

  return Array.from(new Set(variants)).slice(0, 4);
}

function uniqueByUrl(results: WebSearchResult[]): WebSearchResult[] {
  const seen = new Set<string>();
  const deduped: WebSearchResult[] = [];

  for (const r of results) {
    if (!r.url || seen.has(r.url)) continue;
    seen.add(r.url);
    deduped.push(r);
  }

  return deduped;
}
