import { getDb } from './connection';
import { MitreVectorStore } from '../mitre/vector-store';

export function runMigrations(): void {
  const db = getDb();

  db.exec(`
    -- Categories table
    CREATE TABLE IF NOT EXISTS categories (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT    NOT NULL UNIQUE,
      full_name   TEXT    NOT NULL,
      description TEXT    NOT NULL DEFAULT '',
      created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Vendors table
    CREATE TABLE IF NOT EXISTS vendors (
      id                      INTEGER PRIMARY KEY AUTOINCREMENT,
      name                    TEXT    NOT NULL,
      category_id             INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
      description             TEXT    NOT NULL DEFAULT '',
      advantages              TEXT    NOT NULL DEFAULT '[]',  -- JSON array
      disadvantages           TEXT    NOT NULL DEFAULT '[]',  -- JSON array
      pricing_model           TEXT    NOT NULL DEFAULT '',
      founded_year            INTEGER,
      security_certifications TEXT    NOT NULL DEFAULT '[]',  -- JSON array
      geographic_region       TEXT    NOT NULL DEFAULT 'unknown',
      resource_links          TEXT    NOT NULL DEFAULT '[]',  -- JSON array
      awards                  TEXT    NOT NULL DEFAULT '[]',  -- JSON array
      acquisition_mode        TEXT    NOT NULL DEFAULT 'unknown',
      website                 TEXT    NOT NULL DEFAULT '',
      ranking_score           REAL    NOT NULL DEFAULT 0,
      market_position         TEXT    NOT NULL DEFAULT 'unknown',
      criterion_evidence      TEXT    NOT NULL DEFAULT '{}', -- JSON object keyed by criterion
      raw_analysis            TEXT,
      search_date             DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(name, category_id)
    );

    -- Ranking criteria (1:1 with vendors)
    CREATE TABLE IF NOT EXISTS ranking_criteria (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      vendor_id             INTEGER NOT NULL UNIQUE REFERENCES vendors(id) ON DELETE CASCADE,
      ueba_native_ml                      REAL    NOT NULL DEFAULT 0,
      llm_correlation_reasoning           REAL    NOT NULL DEFAULT 0,
      autonomous_triage_alert_reduction   REAL    NOT NULL DEFAULT 0,
      soar_integrated_playbooks           REAL    NOT NULL DEFAULT 0,
      intelligent_ingestion_no_parsers    REAL    NOT NULL DEFAULT 0,
      semantic_search_embeddings          REAL    NOT NULL DEFAULT 0,
      cloud_native_ai_scale               REAL    NOT NULL DEFAULT 0,
      realtime_threat_intel_enrichment    REAL    NOT NULL DEFAULT 0,
      auditable_xai_nis2_dora             REAL    NOT NULL DEFAULT 0,
      measurable_roi_mtta_mttr            REAL    NOT NULL DEFAULT 0
    );

    -- Search records
    CREATE TABLE IF NOT EXISTS search_records (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      vendor_id        INTEGER REFERENCES vendors(id) ON DELETE SET NULL,
      query            TEXT    NOT NULL,
      source_url       TEXT    NOT NULL DEFAULT '',
      snippet          TEXT    NOT NULL DEFAULT '',
      scraped_content  TEXT,
      search_date      DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Indexes
    CREATE INDEX IF NOT EXISTS idx_vendors_category    ON vendors(category_id);
    CREATE INDEX IF NOT EXISTS idx_vendors_score       ON vendors(ranking_score DESC);
    CREATE INDEX IF NOT EXISTS idx_vendors_position    ON vendors(market_position);
    CREATE INDEX IF NOT EXISTS idx_search_vendor       ON search_records(vendor_id);
  `);

  ensureColumn('vendors', 'criterion_evidence', "TEXT NOT NULL DEFAULT '{}' ");
  ensureColumn('ranking_criteria', 'ueba_native_ml', 'REAL NOT NULL DEFAULT 0');
  ensureColumn('ranking_criteria', 'llm_correlation_reasoning', 'REAL NOT NULL DEFAULT 0');
  ensureColumn('ranking_criteria', 'autonomous_triage_alert_reduction', 'REAL NOT NULL DEFAULT 0');
  ensureColumn('ranking_criteria', 'soar_integrated_playbooks', 'REAL NOT NULL DEFAULT 0');
  ensureColumn('ranking_criteria', 'intelligent_ingestion_no_parsers', 'REAL NOT NULL DEFAULT 0');
  ensureColumn('ranking_criteria', 'semantic_search_embeddings', 'REAL NOT NULL DEFAULT 0');
  ensureColumn('ranking_criteria', 'cloud_native_ai_scale', 'REAL NOT NULL DEFAULT 0');
  ensureColumn('ranking_criteria', 'realtime_threat_intel_enrichment', 'REAL NOT NULL DEFAULT 0');
  ensureColumn('ranking_criteria', 'auditable_xai_nis2_dora', 'REAL NOT NULL DEFAULT 0');
  ensureColumn('ranking_criteria', 'measurable_roi_mtta_mttr', 'REAL NOT NULL DEFAULT 0');

  function ensureColumn(tableName: string, columnName: string, definition: string): void {
    const cols = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
    if (cols.some(c => c.name === columnName)) return;
    db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
  }

  // ── MITRE ATT&CK tables (self-managed by MitreVectorStore) ─────────────────
  new MitreVectorStore().ensureSchema();
}
