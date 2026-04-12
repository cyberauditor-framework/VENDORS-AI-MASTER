import { getDb } from './connection';
import {
  Category,
  Vendor,
  RankingCriteria,
  SearchRecord,
  VendorWithCriteria,
  QueryFilter,
} from '../types';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function toJson(arr: unknown[]): string {
  return JSON.stringify(arr);
}

function fromJson<T = string>(raw: string | null): T[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// ─── Categories ───────────────────────────────────────────────────────────────

export function upsertCategory(cat: Category): number {
  const db = getDb();
  const existing = db
    .prepare('SELECT id FROM categories WHERE name = ?')
    .get(cat.name) as { id: number } | undefined;

  if (existing) {
    db.prepare(
      'UPDATE categories SET full_name = ?, description = ? WHERE id = ?'
    ).run(cat.fullName, cat.description, existing.id);
    return existing.id;
  }

  const result = db
    .prepare(
      'INSERT INTO categories (name, full_name, description) VALUES (?, ?, ?)'
    )
    .run(cat.name, cat.fullName, cat.description);
  return result.lastInsertRowid as number;
}

export function getAllCategories(): Category[] {
  const db = getDb();
  return (db.prepare('SELECT * FROM categories ORDER BY name').all() as any[]).map(row => ({
    id: row.id,
    name: row.name,
    fullName: row.full_name,
    description: row.description,
    createdAt: row.created_at,
  }));
}

export function getCategoryByName(name: string): Category | undefined {
  const db = getDb();
  const row = db.prepare('SELECT * FROM categories WHERE name = ?').get(name) as any;
  if (!row) return undefined;
  return { id: row.id, name: row.name, fullName: row.full_name, description: row.description };
}

// ─── Vendors ──────────────────────────────────────────────────────────────────

function rowToVendor(row: any): Vendor {
  const rationale = parseRationaleFromRawAnalysis(row.raw_analysis);
  const criterionEvidence = parseCriterionEvidence(row.criterion_evidence, row.raw_analysis);

  return {
    id: row.id,
    name: row.name,
    categoryId: row.category_id,
    categoryName: row.category_name,
    description: row.description,
    advantages: fromJson(row.advantages),
    disadvantages: fromJson(row.disadvantages),
    pricingModel: row.pricing_model,
    foundedYear: row.founded_year,
    securityCertifications: fromJson(row.security_certifications),
    geographicRegion: row.geographic_region,
    resourceLinks: fromJson(row.resource_links),
    awards: fromJson(row.awards),
    acquisitionMode: row.acquisition_mode,
    website: row.website,
    rankingScore: row.ranking_score,
    marketPosition: row.market_position,
    rationale,
    criterionEvidence,
    rawAnalysis: row.raw_analysis,
    searchDate: row.search_date,
  };
}

function parseCriterionEvidence(
  rawEvidence: string | null,
  rawAnalysis: string | null,
): Record<string, string[]> | null {
  if (rawEvidence) {
    try {
      const parsed = JSON.parse(rawEvidence);
      if (parsed && typeof parsed === 'object') {
        return parsed as Record<string, string[]>;
      }
    } catch {
      // Ignore malformed payloads and fallback to raw analysis.
    }
  }

  if (!rawAnalysis) return null;
  try {
    const parsed = JSON.parse(rawAnalysis);
    if (parsed && typeof parsed === 'object' && parsed.criterionEvidence && typeof parsed.criterionEvidence === 'object') {
      return parsed.criterionEvidence as Record<string, string[]>;
    }
  } catch {
    // Ignore malformed raw analysis payloads.
  }
  return null;
}

function parseRationaleFromRawAnalysis(raw: string | null): Record<string, string> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && parsed.rationale && typeof parsed.rationale === 'object') {
      return parsed.rationale as Record<string, string>;
    }
  } catch {
    // Ignore malformed raw analysis payloads.
  }
  return null;
}

export function upsertVendor(vendor: Vendor): number {
  const db = getDb();
  const existing = db
    .prepare('SELECT id FROM vendors WHERE name = ? AND category_id = ?')
    .get(vendor.name, vendor.categoryId) as { id: number } | undefined;

  if (existing) {
    db.prepare(`
      UPDATE vendors SET
        description             = ?,
        advantages              = ?,
        disadvantages           = ?,
        pricing_model           = ?,
        founded_year            = ?,
        security_certifications = ?,
        geographic_region       = ?,
        resource_links          = ?,
        awards                  = ?,
        acquisition_mode        = ?,
        website                 = ?,
        ranking_score           = ?,
        market_position         = ?,
        criterion_evidence      = ?,
        raw_analysis            = ?,
        search_date             = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(
      vendor.description,
      toJson(vendor.advantages),
      toJson(vendor.disadvantages),
      vendor.pricingModel,
      vendor.foundedYear,
      toJson(vendor.securityCertifications),
      vendor.geographicRegion,
      toJson(vendor.resourceLinks),
      toJson(vendor.awards),
      vendor.acquisitionMode,
      vendor.website,
      vendor.rankingScore,
      vendor.marketPosition,
      JSON.stringify(vendor.criterionEvidence ?? {}),
      vendor.rawAnalysis ?? null,
      existing.id,
    );
    return existing.id;
  }

  const result = db.prepare(`
    INSERT INTO vendors (
      name, category_id, description, advantages, disadvantages,
      pricing_model, founded_year, security_certifications,
      geographic_region, resource_links, awards, acquisition_mode,
      website, ranking_score, market_position, raw_analysis
      , criterion_evidence
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    vendor.name,
    vendor.categoryId,
    vendor.description,
    toJson(vendor.advantages),
    toJson(vendor.disadvantages),
    vendor.pricingModel,
    vendor.foundedYear,
    toJson(vendor.securityCertifications),
    vendor.geographicRegion,
    toJson(vendor.resourceLinks),
    toJson(vendor.awards),
    vendor.acquisitionMode,
    vendor.website,
    vendor.rankingScore,
    vendor.marketPosition,
    vendor.rawAnalysis ?? null,
    JSON.stringify(vendor.criterionEvidence ?? {}),
  );
  return result.lastInsertRowid as number;
}

export function getVendorsByCategory(categoryName: string): VendorWithCriteria[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT v.*, c.name AS category_name,
          rc.ueba_native_ml, rc.llm_correlation_reasoning, rc.autonomous_triage_alert_reduction,
          rc.soar_integrated_playbooks, rc.intelligent_ingestion_no_parsers, rc.semantic_search_embeddings,
          rc.cloud_native_ai_scale, rc.realtime_threat_intel_enrichment, rc.auditable_xai_nis2_dora,
          rc.measurable_roi_mtta_mttr,
           rc.id AS rc_id
    FROM vendors v
    JOIN categories c ON c.id = v.category_id
    LEFT JOIN ranking_criteria rc ON rc.vendor_id = v.id
    WHERE c.name = ?
    ORDER BY v.ranking_score DESC
  `).all(categoryName) as any[];

  return rows.map(row => {
    const vendor = rowToVendor(row) as VendorWithCriteria;
    if (row.rc_id) {
      vendor.criteria = {
        id: row.rc_id,
        vendorId: row.id,
        uebaNativeMl: row.ueba_native_ml,
        llmCorrelationReasoning: row.llm_correlation_reasoning,
        autonomousTriageAlertReduction: row.autonomous_triage_alert_reduction,
        soarIntegratedPlaybooks: row.soar_integrated_playbooks,
        intelligentIngestionNoParsers: row.intelligent_ingestion_no_parsers,
        semanticSearchEmbeddings: row.semantic_search_embeddings,
        cloudNativeAiScale: row.cloud_native_ai_scale,
        realtimeThreatIntelEnrichment: row.realtime_threat_intel_enrichment,
        auditableXaiNis2Dora: row.auditable_xai_nis2_dora,
        measurableRoiMttaMttr: row.measurable_roi_mtta_mttr,
      };
    }
    return vendor;
  });
}

export function getVendorById(vendorId: number): VendorWithCriteria | undefined {
  const db = getDb();
  const row = db.prepare(`
    SELECT v.*, c.name AS category_name,
          rc.ueba_native_ml, rc.llm_correlation_reasoning, rc.autonomous_triage_alert_reduction,
          rc.soar_integrated_playbooks, rc.intelligent_ingestion_no_parsers, rc.semantic_search_embeddings,
          rc.cloud_native_ai_scale, rc.realtime_threat_intel_enrichment, rc.auditable_xai_nis2_dora,
          rc.measurable_roi_mtta_mttr,
           rc.id AS rc_id
    FROM vendors v
    JOIN categories c ON c.id = v.category_id
    LEFT JOIN ranking_criteria rc ON rc.vendor_id = v.id
    WHERE v.id = ?
    LIMIT 1
  `).get(vendorId) as any;

  if (!row) return undefined;

  const vendor = rowToVendor(row) as VendorWithCriteria;
  if (row.rc_id) {
    vendor.criteria = {
      id: row.rc_id,
      vendorId: row.id,
      uebaNativeMl: row.ueba_native_ml,
      llmCorrelationReasoning: row.llm_correlation_reasoning,
      autonomousTriageAlertReduction: row.autonomous_triage_alert_reduction,
      soarIntegratedPlaybooks: row.soar_integrated_playbooks,
      intelligentIngestionNoParsers: row.intelligent_ingestion_no_parsers,
      semanticSearchEmbeddings: row.semantic_search_embeddings,
      cloudNativeAiScale: row.cloud_native_ai_scale,
      realtimeThreatIntelEnrichment: row.realtime_threat_intel_enrichment,
      auditableXaiNis2Dora: row.auditable_xai_nis2_dora,
      measurableRoiMttaMttr: row.measurable_roi_mtta_mttr,
    };
  }

  return vendor;
}

export function queryVendors(filter: QueryFilter): VendorWithCriteria[] {
  const db = getDb();
  const conditions: string[] = [];
  type SqlParam = string | number | bigint | Buffer | null;
  const params: SqlParam[] = [];

  if (filter.category) {
    conditions.push('c.name = ?');
    params.push(filter.category);
  }
  if (filter.minScore !== undefined) {
    conditions.push('v.ranking_score >= ?');
    params.push(filter.minScore);
  }
  if (filter.maxScore !== undefined) {
    conditions.push('v.ranking_score <= ?');
    params.push(filter.maxScore);
  }
  if (filter.region) {
    conditions.push('v.geographic_region = ?');
    params.push(filter.region);
  }
  if (filter.acquisitionMode) {
    conditions.push('v.acquisition_mode = ?');
    params.push(filter.acquisitionMode);
  }
  if (filter.marketPosition) {
    conditions.push('v.market_position = ?');
    params.push(filter.marketPosition);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const sortColumn: Record<string, string> = {
    score: 'v.ranking_score',
    name: 'v.name',
    founded: 'v.founded_year',
    category: 'c.name',
  };
  const orderCol = sortColumn[filter.sortBy ?? 'score'] ?? 'v.ranking_score';
  const orderDir = filter.sortOrder === 'asc' ? 'ASC' : 'DESC';
  const limitClause = filter.limit ? `LIMIT ${filter.limit} OFFSET ${filter.offset ?? 0}` : '';

  const rows = db.prepare(`
    SELECT v.*, c.name AS category_name,
          rc.ueba_native_ml, rc.llm_correlation_reasoning, rc.autonomous_triage_alert_reduction,
          rc.soar_integrated_playbooks, rc.intelligent_ingestion_no_parsers, rc.semantic_search_embeddings,
          rc.cloud_native_ai_scale, rc.realtime_threat_intel_enrichment, rc.auditable_xai_nis2_dora,
          rc.measurable_roi_mtta_mttr,
           rc.id AS rc_id
    FROM vendors v
    JOIN categories c ON c.id = v.category_id
    LEFT JOIN ranking_criteria rc ON rc.vendor_id = v.id
    ${where}
    ORDER BY ${orderCol} ${orderDir}
    ${limitClause}
  `).all(...params) as any[];

  return rows.map(row => {
    const vendor = rowToVendor(row) as VendorWithCriteria;
    if (row.rc_id) {
      vendor.criteria = {
        id: row.rc_id,
        vendorId: row.id,
        uebaNativeMl: row.ueba_native_ml,
        llmCorrelationReasoning: row.llm_correlation_reasoning,
        autonomousTriageAlertReduction: row.autonomous_triage_alert_reduction,
        soarIntegratedPlaybooks: row.soar_integrated_playbooks,
        intelligentIngestionNoParsers: row.intelligent_ingestion_no_parsers,
        semanticSearchEmbeddings: row.semantic_search_embeddings,
        cloudNativeAiScale: row.cloud_native_ai_scale,
        realtimeThreatIntelEnrichment: row.realtime_threat_intel_enrichment,
        auditableXaiNis2Dora: row.auditable_xai_nis2_dora,
        measurableRoiMttaMttr: row.measurable_roi_mtta_mttr,
      };
    }
    return vendor;
  });
}

export function getVendorCount(): number {
  const db = getDb();
  const row = db.prepare('SELECT COUNT(*) AS cnt FROM vendors').get() as { cnt: number };
  return row.cnt;
}

// ─── Ranking Criteria ─────────────────────────────────────────────────────────

export function upsertRankingCriteria(criteria: RankingCriteria): void {
  const db = getDb();
  const existing = db
    .prepare('SELECT id FROM ranking_criteria WHERE vendor_id = ?')
    .get(criteria.vendorId) as { id: number } | undefined;

  if (existing) {
    db.prepare(`
      UPDATE ranking_criteria SET
        ueba_native_ml                    = ?,
        llm_correlation_reasoning         = ?,
        autonomous_triage_alert_reduction = ?,
        soar_integrated_playbooks         = ?,
        intelligent_ingestion_no_parsers  = ?,
        semantic_search_embeddings        = ?,
        cloud_native_ai_scale             = ?,
        realtime_threat_intel_enrichment  = ?,
        auditable_xai_nis2_dora           = ?,
        measurable_roi_mtta_mttr          = ?
      WHERE vendor_id = ?
    `).run(
      criteria.uebaNativeMl,
      criteria.llmCorrelationReasoning,
      criteria.autonomousTriageAlertReduction,
      criteria.soarIntegratedPlaybooks,
      criteria.intelligentIngestionNoParsers,
      criteria.semanticSearchEmbeddings,
      criteria.cloudNativeAiScale,
      criteria.realtimeThreatIntelEnrichment,
      criteria.auditableXaiNis2Dora,
      criteria.measurableRoiMttaMttr,
      criteria.vendorId,
    );
  } else {
    db.prepare(`
      INSERT INTO ranking_criteria (
        vendor_id, ueba_native_ml, llm_correlation_reasoning, autonomous_triage_alert_reduction,
        soar_integrated_playbooks, intelligent_ingestion_no_parsers, semantic_search_embeddings,
        cloud_native_ai_scale, realtime_threat_intel_enrichment, auditable_xai_nis2_dora,
        measurable_roi_mtta_mttr
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      criteria.vendorId,
      criteria.uebaNativeMl,
      criteria.llmCorrelationReasoning,
      criteria.autonomousTriageAlertReduction,
      criteria.soarIntegratedPlaybooks,
      criteria.intelligentIngestionNoParsers,
      criteria.semanticSearchEmbeddings,
      criteria.cloudNativeAiScale,
      criteria.realtimeThreatIntelEnrichment,
      criteria.auditableXaiNis2Dora,
      criteria.measurableRoiMttaMttr,
    );
  }
}

// ─── Search Records ───────────────────────────────────────────────────────────

export function insertSearchRecord(record: SearchRecord): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO search_records (vendor_id, query, source_url, snippet, scraped_content)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    record.vendorId ?? null,
    record.query,
    record.sourceUrl,
    record.snippet,
    record.scrapedContent ?? null,
  );
}

// ─── Management / Cleanup ────────────────────────────────────────────────────

export function deleteVendorAnalysis(vendorId: number): boolean {
  const db = getDb();
  const existing = db.prepare('SELECT id, category_id FROM vendors WHERE id = ?').get(vendorId) as
    | { id: number; category_id: number }
    | undefined;
  if (!existing) return false;

  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM search_records WHERE vendor_id = ?').run(existing.id);
    db.prepare('DELETE FROM ranking_criteria WHERE vendor_id = ?').run(existing.id);
    db.prepare('DELETE FROM vendors WHERE id = ?').run(existing.id);

    const remaining = db.prepare('SELECT COUNT(*) AS cnt FROM vendors WHERE category_id = ?').get(existing.category_id) as { cnt: number };
    if (remaining.cnt === 0) {
      db.prepare('DELETE FROM categories WHERE id = ?').run(existing.category_id);
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return true;
}

export function deleteCategoryAnalyses(categoryName: string): number {
  const db = getDb();
  const cat = db.prepare('SELECT id FROM categories WHERE name = ?').get(categoryName) as { id: number } | undefined;
  if (!cat) return 0;

  const vendorRows = db.prepare('SELECT id FROM vendors WHERE category_id = ?').all(cat.id) as Array<{ id: number }>;
  const vendorIds = vendorRows.map(v => v.id);
  if (vendorIds.length === 0) {
    db.prepare('DELETE FROM categories WHERE id = ?').run(cat.id);
    return 0;
  }

  db.exec('BEGIN');
  try {
    const placeholders = vendorIds.map(() => '?').join(',');
    db.prepare(`DELETE FROM search_records WHERE vendor_id IN (${placeholders})`).run(...vendorIds);
    db.prepare(`DELETE FROM ranking_criteria WHERE vendor_id IN (${placeholders})`).run(...vendorIds);
    db.prepare('DELETE FROM vendors WHERE category_id = ?').run(cat.id);
    db.prepare('DELETE FROM categories WHERE id = ?').run(cat.id);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return vendorIds.length;
}

export function deleteAllAnalyses(): { vendorsDeleted: number; categoriesDeleted: number; searchesDeleted: number } {
  const db = getDb();

  const counts = {
    vendorsDeleted: (db.prepare('SELECT COUNT(*) AS cnt FROM vendors').get() as { cnt: number }).cnt,
    categoriesDeleted: (db.prepare('SELECT COUNT(*) AS cnt FROM categories').get() as { cnt: number }).cnt,
    searchesDeleted: (db.prepare('SELECT COUNT(*) AS cnt FROM search_records').get() as { cnt: number }).cnt,
  };

  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM search_records').run();
    db.prepare('DELETE FROM ranking_criteria').run();
    db.prepare('DELETE FROM vendors').run();
    db.prepare('DELETE FROM categories').run();
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }

  return counts;
}
