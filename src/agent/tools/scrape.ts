import axios from 'axios';
import * as cheerio from 'cheerio';
import { searchConfig } from '../../config';

// ─── OpenAI Tool Definition ───────────────────────────────────────────────────

export const SCRAPE_TOOL_DEFINITION = {
  type: 'function' as const,
  function: {
    name: 'scrape_url',
    description:
      'Fetch and read the text content of a specific web page. ' +
      'Use this after finding a relevant URL from search_web to get detailed information.',
    parameters: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'The full URL of the web page to read (must start with http:// or https://).',
        },
      },
      required: ['url'],
    },
  },
} as const;

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);
const MAX_CHARS = 4000;

// ─── ScrapeTool ───────────────────────────────────────────────────────────────

/**
 * Fetches and extracts readable text from a URL.
 *
 * Strategy:
 *  1. Direct fetch + Cheerio text extraction (fastest)
 *  2. Jina AI Reader  (r.jina.ai/{url})  — handles JS-heavy or paywalled pages
 *
 * All URLs are validated before fetching (SSRF prevention).
 * `run()` returns a plain-text string ready for injection into the LLM context.
 */
export class ScrapeTool {

  // ── Called by the agent after a tool_call ──────────────────────────────────
  async run(url: string): Promise<string> {
    const safe = validateUrl(url);
    if (!safe) {
      return `[Skipped — invalid or blocked URL: ${url}]`;
    }

    // 1. Direct fetch
    const direct = await this.directFetch(safe);
    if (direct && direct.length > 100) return direct;

    // 2. Jina AI Reader fallback (handles JS-heavy pages)
    return this.jinaReader(safe);
  }

  // ── 1. Direct fetch + Cheerio ──────────────────────────────────────────────

  private async directFetch(url: string): Promise<string> {
    try {
      const res = await axios.get(url, {
        headers: {
          'User-Agent': searchConfig.userAgent,
          Accept: 'text/html,application/xhtml+xml,text/plain',
        },
        timeout: searchConfig.scrapeTimeoutMs,
        maxRedirects: 3,
        responseType: 'text',
        maxContentLength: 2 * 1024 * 1024,
        validateStatus: (s) => s < 400,
      });

      const ct = String(res.headers['content-type'] ?? '');
      if (!ct.includes('text/html') && !ct.includes('text/plain')) {
        return '';
      }

      return extractText(res.data as string);
    } catch {
      return '';
    }
  }

  // ── 2. Jina AI Reader ──────────────────────────────────────────────────────
  // Free tier, no API key needed. Converts any URL to clean LLM-friendly text.
  // Docs: https://jina.ai/reader/

  private async jinaReader(url: string): Promise<string> {
    try {
      const res = await axios.get(`https://r.jina.ai/${url}`, {
        headers: {
          'User-Agent': searchConfig.userAgent,
          Accept: 'text/plain',
          'X-Return-Format': 'text',
        },
        timeout: searchConfig.scrapeTimeoutMs + 4000, // Jina is slower
        maxRedirects: 3,
        responseType: 'text',
        maxContentLength: 2 * 1024 * 1024,
      });

      const text = String(res.data ?? '').trim();
      return text.slice(0, MAX_CHARS) || `[Jina Reader returned empty content for ${url}]`;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return `[Scrape failed for ${url}: ${msg.slice(0, 120)}]`;
    }
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Returns the sanitised URL or null if it is unsafe (SSRF prevention).
 */
function validateUrl(raw: string): string | null {
  try {
    const url = new URL(raw.startsWith('http') ? raw : 'https://' + raw);

    if (!ALLOWED_PROTOCOLS.has(url.protocol)) return null;

    const h = url.hostname.toLowerCase();
    if (
      h === 'localhost' ||
      h === '127.0.0.1' ||
      h.startsWith('192.168.') ||
      h.startsWith('10.') ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(h) ||
      h.endsWith('.local')
    ) return null;

    // Block Jina Reader self-reference (infinite loop)
    if (h === 'r.jina.ai' || h === 's.jina.ai') return null;

    return url.toString();
  } catch {
    return null;
  }
}

function extractText(html: string): string {
  const $ = cheerio.load(html);

  $('script,style,nav,footer,header,aside,form,iframe,noscript,[class*="cookie"],[class*="banner"],[id*="ad"],[class*="ad-"]').remove();

  let text = '';
  const main = $('article,main,[role="main"],.content,#content,.post-content,.entry-content').first();
  text = main.length ? main.text() : $('body').text();

  return text
    .replace(/\t/g, ' ')
    .replace(/ {2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, MAX_CHARS);
}
