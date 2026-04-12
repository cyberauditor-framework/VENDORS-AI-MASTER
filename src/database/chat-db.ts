/**
 * Dedicated SQLite database for MITRE ATT&CK chatbot conversation history.
 *
 * Kept entirely separate from vendors.db so chatbot data never pollutes
 * the vendor analysis store and can be wiped independently.
 *
 * File location: data/mitre-chat.db  (next to vendors.db)
 *
 * Schema
 * ──────
 *  conversations   — one row per chat session
 *  messages        — every user query and agent reply within a session
 *  coverage_reports— structured MitreCoverageReport, linked 1:1 to agent messages
 */

import * as path from 'path';
import * as fs   from 'fs';
import { MitreCoverageReport } from '../types/mitre-coverage';
import { TtpCoverage } from '../types/mitre-coverage';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');

// ─── Connection ───────────────────────────────────────────────────────────────

const DB_PATH = path.resolve(__dirname, '../../data/mitre-chat.db');

// Ensure the data directory exists
const dataDir = path.dirname(DB_PATH);
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

let _chatDb: InstanceType<typeof DatabaseSync> | null = null;

function getChatDb(): InstanceType<typeof DatabaseSync> {
  if (_chatDb) return _chatDb;
  _chatDb = new DatabaseSync(DB_PATH);
  _chatDb.exec('PRAGMA journal_mode = WAL');
  _chatDb.exec('PRAGMA foreign_keys = ON');
  _chatDb.exec('PRAGMA synchronous = NORMAL');
  return _chatDb;
}

// ─── Schema ───────────────────────────────────────────────────────────────────

export function runChatMigrations(): void {
  const db = getChatDb();
  db.exec(`
    -- One row per chat session; title is auto-set to first vendor queried
    CREATE TABLE IF NOT EXISTS conversations (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      title      TEXT    NOT NULL DEFAULT 'Nueva conversación',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Each turn in a conversation (user query or agent response)
    CREATE TABLE IF NOT EXISTS messages (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      role            TEXT    NOT NULL CHECK(role IN ('user','agent')),
      content         TEXT    NOT NULL,
      vendor          TEXT,
      created_at      DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Full MitreCoverageReport payload + extracted key metrics for fast listing
    CREATE TABLE IF NOT EXISTS coverage_reports (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id    INTEGER NOT NULL UNIQUE REFERENCES messages(id) ON DELETE CASCADE,
      conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      vendor        TEXT    NOT NULL,
      report_json   TEXT    NOT NULL,
      overall_score REAL    NOT NULL DEFAULT 0,
      ttp_count     INTEGER NOT NULL DEFAULT 0,
      gap_count     INTEGER NOT NULL DEFAULT 0,
      insufficient  INTEGER NOT NULL DEFAULT 0,
      created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_messages_conv   ON messages(conversation_id);
    CREATE INDEX IF NOT EXISTS idx_reports_conv    ON coverage_reports(conversation_id);
    CREATE INDEX IF NOT EXISTS idx_reports_vendor  ON coverage_reports(vendor);
  `);
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface Conversation {
  id: number;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount?: number;
}

export interface ChatMessage {
  id: number;
  conversationId: number;
  role: 'user' | 'agent';
  content: string;
  vendor?: string;
  createdAt: string;
  report?: StoredCoverageReport;
}

export interface StoredCoverageReport {
  id: number;
  vendor: string;
  overallScore: number;
  ttpCount: number;
  gapCount: number;
  insufficient: boolean;
  report: MitreCoverageReport;
  createdAt: string;
}

export interface VendorStat {
  vendor: string;
  analysisCount: number;
  lastAnalyzed: string;
  latestScore: number;
  latestTtpCount: number;
  latestGapCount: number;
  scoreHistory: number[];
}

export interface SavedMergedSelection {
  conversationId: number;
  messageId: number;
  reportId: number;
  report: MitreCoverageReport;
}

// ─── Conversation CRUD ────────────────────────────────────────────────────────

export function createConversation(title?: string): number {
  const db = getChatDb();
  const result = db.prepare(
    `INSERT INTO conversations (title) VALUES (?)`,
  ).run(title ?? 'Nueva conversación') as { lastInsertRowid: number };
  return result.lastInsertRowid;
}

export function renameConversation(id: number, title: string): void {
  getChatDb().prepare(
    `UPDATE conversations SET title = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
  ).run(title, id);
}

export function deleteConversation(id: number): void {
  getChatDb().prepare(`DELETE FROM conversations WHERE id = ?`).run(id);
}

export function listConversations(): Conversation[] {
  const db = getChatDb();
  const rows = db.prepare(`
    SELECT c.id, c.title, c.created_at, c.updated_at,
           COUNT(m.id) AS message_count
    FROM conversations c
    LEFT JOIN messages m ON m.conversation_id = c.id
    GROUP BY c.id
    ORDER BY c.updated_at DESC
  `).all() as any[];
  return rows.map(rowToConversation);
}

export function getConversation(id: number): Conversation | null {
  const row = getChatDb().prepare(
    `SELECT * FROM conversations WHERE id = ?`,
  ).get(id) as any;
  return row ? rowToConversation(row) : null;
}

// ─── Message operations ───────────────────────────────────────────────────────

export function addMessage(
  conversationId: number,
  role: 'user' | 'agent',
  content: string,
  vendor?: string,
): number {
  const db = getChatDb();
  const result = db.prepare(
    `INSERT INTO messages (conversation_id, role, content, vendor) VALUES (?, ?, ?, ?)`,
  ).run(conversationId, role, content, vendor ?? null) as { lastInsertRowid: number };

  // Touch the conversation's updated_at
  db.prepare(
    `UPDATE conversations SET updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
  ).run(conversationId);

  return result.lastInsertRowid;
}

export function getMessages(conversationId: number): ChatMessage[] {
  const db = getChatDb();
  const msgs = db.prepare(
    `SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC`,
  ).all(conversationId) as any[];

  // Attach reports to agent messages
  return msgs.map(m => {
    const msg = rowToMessage(m);
    if (m.role === 'agent') {
      const rep = db.prepare(
        `SELECT * FROM coverage_reports WHERE message_id = ?`,
      ).get(m.id) as any;
      if (rep) msg.report = rowToReport(rep);
    }
    return msg;
  });
}

// ─── Coverage report operations ───────────────────────────────────────────────

export function saveCoverageReport(
  messageId: number,
  conversationId: number,
  report: MitreCoverageReport,
): number {
  const db = getChatDb();
  const result = db.prepare(`
    INSERT OR REPLACE INTO coverage_reports
      (message_id, conversation_id, vendor, report_json,
       overall_score, ttp_count, gap_count, insufficient)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    messageId,
    conversationId,
    report.vendor,
    JSON.stringify(report),
    report.overallCoverageScore,
    report.ttpsAddressed.length,
    report.coverageGaps.length,
    report.insufficientInfo ? 1 : 0,
  ) as { lastInsertRowid: number };
  return result.lastInsertRowid;
}

export function listReports(limit = 50): StoredCoverageReport[] {
  const rows = getChatDb().prepare(
    `SELECT * FROM coverage_reports ORDER BY created_at DESC LIMIT ?`,
  ).all(limit) as any[];
  return rows.map(rowToReport);
}

// ─── Vendor-level aggregates ──────────────────────────────────────────────────

/** One summary row per unique vendor, newest first. */
export function listVendorStats(): VendorStat[] {
  const db = getChatDb();
  const vendors = db.prepare(
    `SELECT vendor FROM coverage_reports WHERE insufficient = 0
     GROUP BY vendor ORDER BY MAX(created_at) DESC`,
  ).all() as { vendor: string }[];

  return vendors.map(({ vendor }) => {
    const rows = db.prepare(
      `SELECT overall_score, ttp_count, gap_count, created_at
       FROM coverage_reports WHERE vendor = ? AND insufficient = 0
       ORDER BY created_at DESC`,
    ).all(vendor) as { overall_score: number; ttp_count: number; gap_count: number; created_at: string }[];

    return {
      vendor,
      analysisCount:  rows.length,
      lastAnalyzed:   rows[0].created_at,
      latestScore:    rows[0].overall_score,
      latestTtpCount: rows[0].ttp_count,
      latestGapCount: rows[0].gap_count,
      scoreHistory:   rows.map(r => r.overall_score).reverse(), // oldest→newest
    };
  });
}

/** All stored reports for a vendor, newest first. */
export function getVendorReports(vendor: string): StoredCoverageReport[] {
  const rows = getChatDb().prepare(
    `SELECT * FROM coverage_reports WHERE vendor = ? ORDER BY created_at DESC`,
  ).all(vendor) as any[];
  return rows.map(rowToReport);
}

/** Delete every report (and linked messages) for a vendor. Returns deleted count. */
export function deleteVendorReports(vendor: string): number {
  const db = getChatDb();
  const result = db.prepare(
    `DELETE FROM coverage_reports WHERE vendor = ?`,
  ).run(vendor) as { changes: number };
  return result.changes;
}

/**
 * Merge all valid analyses for a vendor into a single accumulated report.
 *
 * Strategy:
 *  - For each unique techniqueId, keep the most recent entry where
 *    coverageLevel !== 'unknown'; fall back to 'unknown' only when all runs
 *    returned that level.
 *  - Overall score = average of all valid (non-insufficient) runs.
 *  - Coverage gaps = union across all runs, minus IDs we now have coverage for.
 *  - sourcesConsulted = de-duplicated union.
 */
export function getMergedVendorReport(vendor: string): MitreCoverageReport | null {
  const all = getVendorReports(vendor);
  const valid = all.filter(r => !r.insufficient && r.report.ttpsAddressed?.length > 0);
  return buildMergedReportFromStored(vendor, valid, {
    modeLabel: 'Análisis acumulado',
    includeLatestSummary: true,
  });
}

/** Builds a merged report from a user-selected subset of stored run IDs. */
export function getMergedVendorReportFromSelection(
  vendor: string,
  reportIds: number[],
): MitreCoverageReport | null {
  const ids = [...new Set(reportIds.filter(id => Number.isInteger(id) && id > 0))];
  if (ids.length < 2) return null;

  const selectedRows = getChatDb().prepare(
    `SELECT * FROM coverage_reports WHERE vendor = ? AND id = ? ORDER BY created_at DESC`,
  );

  const selected = ids
    .map(id => selectedRows.get(vendor, id) as any)
    .filter(Boolean)
    .map(rowToReport)
    .filter(r => !r.insufficient && r.report.ttpsAddressed?.length > 0);

  return buildMergedReportFromStored(vendor, selected, {
    modeLabel: 'Unificacion seleccionada',
    includeLatestSummary: false,
  });
}

/** Persists a user-approved merged report from selected run IDs as a new stored analysis. */
export function saveMergedVendorSelection(
  vendor: string,
  reportIds: number[],
): SavedMergedSelection | null {
  const merged = getMergedVendorReportFromSelection(vendor, reportIds);
  if (!merged) return null;

  const conversationId = createConversation(`${vendor} — merged selection`);
  const messageText =
    merged.summary ||
    `Merged MITRE ATT&CK coverage for ${vendor} from selected historical analyses.`;
  const messageId = addMessage(conversationId, 'agent', messageText, vendor);
  const reportId = saveCoverageReport(messageId, conversationId, merged);

  return {
    conversationId,
    messageId,
    reportId,
    report: merged,
  };
}

function buildMergedReportFromStored(
  vendor: string,
  valid: StoredCoverageReport[],
  opts: { modeLabel: string; includeLatestSummary: boolean },
): MitreCoverageReport | null {
  if (valid.length === 0) return null;

  const ttpMap = new Map<string, TtpCoverage>();
  for (const stored of [...valid].reverse()) {
    for (const ttp of stored.report.ttpsAddressed ?? []) {
      const existing = ttpMap.get(ttp.techniqueId);
      if (!existing || existing.coverageLevel === 'unknown') {
        ttpMap.set(ttp.techniqueId, ttp);
      } else if (ttp.coverageLevel !== 'unknown') {
        ttpMap.set(ttp.techniqueId, ttp);
      }
    }
  }

  const covered = new Set(
    [...ttpMap.values()]
      .filter(t => t.coverageLevel === 'full' || t.coverageLevel === 'partial')
      .map(t => t.techniqueId),
  );

  const allGaps = new Set<string>();
  for (const stored of valid) {
    for (const g of stored.report.coverageGaps ?? []) allGaps.add(g);
  }

  const filteredGaps = [...allGaps].filter(g => {
    const m = g.match(/^(T\d[\d.]*)/i);
    return !m || !covered.has(m[1].toUpperCase());
  });

  const avgScore = valid.reduce((s, r) => s + r.overallScore, 0) / valid.length;
  const sources = [...new Set(valid.flatMap(r => r.report.sourcesConsulted ?? []))];
  const latest = valid[0].report;

  return {
    vendor,
    analysisDate: new Date().toISOString(),
    ttpsAddressed: [...ttpMap.values()],
    coverageGaps: filteredGaps,
    overallCoverageScore: Math.round(avgScore * 10) / 10,
    summary:
      `${opts.modeLabel} de ${valid.length} ejecucion${valid.length > 1 ? 'es' : ''}. ` +
      (opts.includeLatestSummary && latest.summary ? `Ultimo: ${latest.summary}` : ''),
    sourcesConsulted: sources,
    insufficientInfo: false,
  };
}

// ─── Row mappers ──────────────────────────────────────────────────────────────

function rowToConversation(r: any): Conversation {
  return {
    id:           r.id,
    title:        r.title,
    createdAt:    r.created_at,
    updatedAt:    r.updated_at,
    messageCount: r.message_count ?? undefined,
  };
}

function rowToMessage(r: any): ChatMessage {
  return {
    id:             r.id,
    conversationId: r.conversation_id,
    role:           r.role,
    content:        r.content,
    vendor:         r.vendor ?? undefined,
    createdAt:      r.created_at,
  };
}

function rowToReport(r: any): StoredCoverageReport {
  let report: MitreCoverageReport;
  try { report = JSON.parse(r.report_json); } catch { report = {} as any; }
  return {
    id:           r.id,
    vendor:       r.vendor,
    overallScore: r.overall_score,
    ttpCount:     r.ttp_count,
    gapCount:     r.gap_count,
    insufficient: Boolean(r.insufficient),
    report,
    createdAt:    r.created_at,
  };
}
