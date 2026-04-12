import * as dotenv from 'dotenv';
import * as path from 'path';
import * as fs from 'fs';
import { AgentConfig } from '../types';

dotenv.config();

function requireEnv(key: string, defaultValue?: string): string {
  const value = process.env[key] ?? defaultValue;
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}. Copy .env.example to .env and fill in values.`);
  }
  return value;
}

function numericEnv(key: string, defaultValue: number): number {
  const raw = process.env[key];
  if (!raw) return defaultValue;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : defaultValue;
}

// ─── Paths ────────────────────────────────────────────────────────────────────

export const ROOT_DIR = path.resolve(__dirname, '..', '..');
export const DATA_DIR = path.resolve(ROOT_DIR, 'data');
export const REPORTS_DIR = path.resolve(ROOT_DIR, process.env.EXPORT_DIR ?? 'reports');
export const DB_PATH = path.resolve(ROOT_DIR, process.env.DB_PATH ?? 'data/vendors.db');

// Ensure data and reports dirs exist
[DATA_DIR, REPORTS_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// ─── LM Studio / Agent Config ─────────────────────────────────────────────────

export const agentConfig: AgentConfig = {
  lmStudioUrl: requireEnv('LM_STUDIO_URL', 'http://localhost:1234/v1'),
  apiKey: requireEnv('LM_STUDIO_API_KEY', 'lm-studio'),
  model: requireEnv('LM_STUDIO_MODEL', 'gemma-3-4b'),
  temperature: numericEnv('AGENT_TEMPERATURE', 0),
  maxTokens: numericEnv('AGENT_MAX_TOKENS', 4096),
  maxSearchResults: numericEnv('AGENT_MAX_SEARCH_RESULTS', 8),
  maxReActIterations: numericEnv('AGENT_MAX_REACT_ITERATIONS', 6),
};

// ─── Web Search Config ────────────────────────────────────────────────────────

export const searchConfig = {
  rateLimitMs: numericEnv('SEARCH_RATE_LIMIT_MS', 1500),
  requestTimeoutMs: numericEnv('SEARCH_REQUEST_TIMEOUT_MS', 10_000),
  scrapeTimeoutMs: numericEnv('WEB_SCRAPE_TIMEOUT_MS', 8_000),
  userAgent:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
};
