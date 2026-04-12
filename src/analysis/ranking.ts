import { RankingCriteria, VendorWithCriteria, ChartDataPoint } from '../types';

type CriteriaKey = keyof Omit<RankingCriteria, 'id' | 'vendorId'>;
type CriteriaDefinition = {
  key: CriteriaKey;
  label: string;
  category: string;
  weight: number;
};

// ─── Weights ──────────────────────────────────────────────────────────────────

export const SIEM_CRITERIA_PROFILE: CriteriaDefinition[] = [
  { key: 'uebaNativeMl', label: 'UEBA nativo con ML de comportamiento', category: 'Deteccion', weight: 0.15 },
  { key: 'llmCorrelationReasoning', label: 'Correlacion y razonamiento con LLM', category: 'Deteccion', weight: 0.13 },
  { key: 'autonomousTriageAlertReduction', label: 'Triage autonomo y reduccion de alertas', category: 'Operaciones', weight: 0.12 },
  { key: 'soarIntegratedPlaybooks', label: 'SOAR integrado con AI-driven playbooks', category: 'Operaciones', weight: 0.11 },
  { key: 'intelligentIngestionNoParsers', label: 'Ingesta inteligente sin parsers manuales', category: 'Datos y modelos', weight: 0.10 },
  { key: 'semanticSearchEmbeddings', label: 'Busqueda semantica con embeddings', category: 'Datos y modelos', weight: 0.10 },
  { key: 'cloudNativeAiScale', label: 'Arquitectura cloud-native y escala del motor AI', category: 'Arquitectura', weight: 0.09 },
  { key: 'realtimeThreatIntelEnrichment', label: 'Enriquecimiento TI en tiempo real con AI', category: 'Arquitectura', weight: 0.08 },
  { key: 'auditableXaiNis2Dora', label: 'Explicabilidad XAI auditable (NIS2/DORA)', category: 'Negocio', weight: 0.07 },
  { key: 'measurableRoiMttaMttr', label: 'ROI medible: MTTR, MTTA y horas-analista', category: 'Negocio', weight: 0.05 },
];

export const EDR_XDR_CRITERIA_PROFILE: CriteriaDefinition[] = [
  { key: 'uebaNativeMl', label: 'Prevencion de amenazas desconocidas pre-ejecucion', category: 'Prevencion', weight: 0.15 },
  { key: 'llmCorrelationReasoning', label: 'Deteccion de comportamiento adversarial con modelos de secuencia', category: 'Deteccion', weight: 0.14 },
  { key: 'autonomousTriageAlertReduction', label: 'Threat Intelligence integrada con correlacion de adversarios activos', category: 'Deteccion', weight: 0.12 },
  { key: 'soarIntegratedPlaybooks', label: 'Respuesta autonoma y contencion AI-driven configurable', category: 'Respuesta', weight: 0.11 },
  { key: 'intelligentIngestionNoParsers', label: 'AI-guided threat hunting con generacion de hipotesis', category: 'Respuesta', weight: 0.10 },
  { key: 'semanticSearchEmbeddings', label: 'Cobertura XDR unificada en un solo grafo de ataque', category: 'Cobertura XDR', weight: 0.10 },
  { key: 'cloudNativeAiScale', label: 'ITDR integrado con deteccion de ataques a identidades', category: 'Cobertura XDR', weight: 0.09 },
  { key: 'realtimeThreatIntelEnrichment', label: 'Proteccion en runtime: fileless y exploits de memoria', category: 'Prevencion', weight: 0.08 },
  { key: 'auditableXaiNis2Dora', label: 'Explicabilidad del attack graph y storytelling AI', category: 'Negocio', weight: 0.06 },
  { key: 'measurableRoiMttaMttr', label: 'Impacto del agente en rendimiento del endpoint', category: 'Negocio', weight: 0.05 },
];

export const SOAR_CRITERIA_PROFILE: CriteriaDefinition[] = [
  { key: 'uebaNativeMl', label: 'Generacion autonoma de playbooks con LLM desde lenguaje natural', category: 'Automatizacion', weight: 0.15 },
  { key: 'llmCorrelationReasoning', label: 'Orquestacion adaptativa con decisiones AI en tiempo de ejecucion', category: 'Orquestacion', weight: 0.14 },
  { key: 'autonomousTriageAlertReduction', label: 'Triaje y enriquecimiento automatico de incidentes', category: 'Respuesta', weight: 0.12 },
  { key: 'soarIntegratedPlaybooks', label: 'Construccion no-code/low-code con AI como copiloto', category: 'Automatizacion', weight: 0.11 },
  { key: 'intelligentIngestionNoParsers', label: 'Contencion autonoma con human-in-the-loop configurable', category: 'Respuesta', weight: 0.10 },
  { key: 'semanticSearchEmbeddings', label: 'Ecosistema de conectores con auto-mantenimiento AI', category: 'Integracion', weight: 0.10 },
  { key: 'cloudNativeAiScale', label: 'Gestion de casos con correlacion de campanas de ataque', category: 'Orquestacion', weight: 0.09 },
  { key: 'realtimeThreatIntelEnrichment', label: 'Integracion bidireccional SIEM/EDR/TI con contexto AI', category: 'Integracion', weight: 0.08 },
  { key: 'auditableXaiNis2Dora', label: 'Metricas del SOC y reporting ejecutivo AI-automated', category: 'Negocio', weight: 0.06 },
  { key: 'measurableRoiMttaMttr', label: 'Aprendizaje continuo y mejora autonoma de playbooks', category: 'Negocio', weight: 0.05 },
];

export const IAM_PAM_CRITERIA_PROFILE: CriteriaDefinition[] = [
  { key: 'uebaNativeMl', label: 'UEBA de comportamiento de identidad en tiempo real', category: 'Riesgo', weight: 0.15 },
  { key: 'llmCorrelationReasoning', label: 'Autenticacion continua y adaptativa por riesgo de sesion', category: 'Identidad', weight: 0.14 },
  { key: 'autonomousTriageAlertReduction', label: 'Acceso privilegiado JIT con AI de privilegio minimo', category: 'Privilegio', weight: 0.13 },
  { key: 'soarIntegratedPlaybooks', label: 'Scoring de riesgo de identidad dinamico y accionable', category: 'Riesgo', weight: 0.11 },
  { key: 'intelligentIngestionNoParsers', label: 'Aprovisionamiento y desaprovisionamiento inteligente', category: 'Ciclo de vida', weight: 0.10 },
  { key: 'semanticSearchEmbeddings', label: 'Analisis AI de sesiones privilegiadas en tiempo real', category: 'Privilegio', weight: 0.10 },
  { key: 'cloudNativeAiScale', label: 'Gobierno de identidades no humanas (NHI) con AI', category: 'Identidad', weight: 0.09 },
  { key: 'realtimeThreatIntelEnrichment', label: 'Revisiones de acceso AI-automated (Certification)', category: 'Ciclo de vida', weight: 0.08 },
  { key: 'auditableXaiNis2Dora', label: 'ITDR integrado con respuesta automatica nativa', category: 'Negocio', weight: 0.06 },
  { key: 'measurableRoiMttaMttr', label: 'Cumplimiento regulatorio AI-automated y auditoria', category: 'Negocio', weight: 0.04 },
];

export const ZERO_TRUST_CRITERIA_PROFILE: CriteriaDefinition[] = [
  { key: 'uebaNativeMl', label: 'Motor de politica AI-driven con decision contextual en tiempo real', category: 'Acceso & Politica', weight: 0.15 },
  { key: 'llmCorrelationReasoning', label: 'Minimo privilegio dinamico con AI de ajuste continuo', category: 'Acceso & Politica', weight: 0.14 },
  { key: 'autonomousTriageAlertReduction', label: 'Microsegmentacion AI-driven con politicas auto-generadas', category: 'Red & Microsegmentacion', weight: 0.12 },
  { key: 'soarIntegratedPlaybooks', label: 'Postura de dispositivo continua con acceso condicionado en tiempo real', category: 'Dispositivo & Endpoint', weight: 0.11 },
  { key: 'intelligentIngestionNoParsers', label: 'Inspeccion de trafico cifrado con AI sin descifrado universal', category: 'Red & Microsegmentacion', weight: 0.10 },
  { key: 'semanticSearchEmbeddings', label: 'Proteccion de datos contextual con DLP dinamico AI', category: 'Datos & Aplicacion', weight: 0.09 },
  { key: 'cloudNativeAiScale', label: 'Zero Trust para workloads cloud y contenedores con AI', category: 'Dispositivo & Endpoint', weight: 0.08 },
  { key: 'realtimeThreatIntelEnrichment', label: 'Deteccion de movimiento lateral con AI de grafo de confianza', category: 'Operaciones & Negocio', weight: 0.08 },
  { key: 'auditableXaiNis2Dora', label: 'Visibilidad unificada cross-pilar con correlacion AI', category: 'Operaciones & Negocio', weight: 0.07 },
  { key: 'measurableRoiMttaMttr', label: 'Score de madurez ZT continuo alineado con CISA y roadmap AI', category: 'Datos & Aplicacion', weight: 0.06 },
];

export const THREAT_INTELLIGENCE_CRITERIA_PROFILE: CriteriaDefinition[] = [
  { key: 'uebaNativeMl', label: 'Recoleccion AI-autonoma en dark web, deep web y OSINT', category: 'Recoleccion & Fuentes', weight: 0.15 },
  { key: 'llmCorrelationReasoning', label: 'Produccion automatica de inteligencia con LLM especializado', category: 'Analisis & Produccion', weight: 0.14 },
  { key: 'autonomousTriageAlertReduction', label: 'Perfilado y seguimiento AI de actores con atribucion dinamica', category: 'Actores & Atribucion', weight: 0.13 },
  { key: 'soarIntegratedPlaybooks', label: 'Deteccion y enriquecimiento AI de IOCs con scoring y caducidad', category: 'Recoleccion & Fuentes', weight: 0.11 },
  { key: 'intelligentIngestionNoParsers', label: 'Analisis automatico de malware y TTPs con AI', category: 'Analisis & Produccion', weight: 0.10 },
  { key: 'semanticSearchEmbeddings', label: 'Inteligencia predictiva de campanas con AI anticipatoria', category: 'Actores & Atribucion', weight: 0.09 },
  { key: 'cloudNativeAiScale', label: 'Activacion automatica de inteligencia en controles de seguridad', category: 'Activacion & Respuesta', weight: 0.08 },
  { key: 'realtimeThreatIntelEnrichment', label: 'Monitorizacion de exposicion digital y datos filtrados con AI', category: 'Activacion & Respuesta', weight: 0.07 },
  { key: 'auditableXaiNis2Dora', label: 'Inteligencia de riesgo de terceros y cadena de suministro', category: 'Negocio & Riesgo', weight: 0.07 },
  { key: 'measurableRoiMttaMttr', label: 'Contextualizacion geopolitica y traduccion a riesgo de negocio', category: 'Negocio & Riesgo', weight: 0.06 },
];

export function getCriteriaProfileForCategory(categoryName?: string): CriteriaDefinition[] {
  const normalized = (categoryName || '').trim().toLowerCase();
  if (normalized === 'edr/xdr') return EDR_XDR_CRITERIA_PROFILE;
  if (normalized === 'soar') return SOAR_CRITERIA_PROFILE;
  if (normalized === 'iam/pam') return IAM_PAM_CRITERIA_PROFILE;
  if (normalized === 'zero trust') return ZERO_TRUST_CRITERIA_PROFILE;
  if (normalized === 'threat intelligence') return THREAT_INTELLIGENCE_CRITERIA_PROFILE;
  return SIEM_CRITERIA_PROFILE;
}

export function getRankingWeightsForCategory(categoryName?: string): Record<CriteriaKey, number> {
  return getCriteriaProfileForCategory(categoryName).reduce((acc, item) => {
    acc[item.key] = item.weight;
    return acc;
  }, {} as Record<CriteriaKey, number>);
}

export function getRankingCriteriaMetadataForCategory(categoryName?: string): Array<{ key: CriteriaKey; label: string; category: string }> {
  return getCriteriaProfileForCategory(categoryName).map(({ key, label, category }) => ({ key, label, category }));
}

// Backward-compatible exports (default profile)
export const RANKING_WEIGHTS: Record<CriteriaKey, number> = getRankingWeightsForCategory('SIEM');
export const RANKING_CRITERIA_METADATA = getRankingCriteriaMetadataForCategory('SIEM');

// ─── Score Calculation ────────────────────────────────────────────────────────

export function calculateWeightedScore(
  criteria: Omit<RankingCriteria, 'id' | 'vendorId'>,
  categoryName?: string,
): number {
  const weights = getRankingWeightsForCategory(categoryName);
  const total = Object.entries(weights).reduce((sum, [key, weight]) => {
    const val = clamp((criteria as any)[key] ?? 5, 0, 10);
    return sum + val * weight;
  }, 0);
  return parseFloat(total.toFixed(2));
}

export function scoreToLabel(score: number): string {
  if (score >= 8.5) return 'Excellent';
  if (score >= 7.0) return 'Good';
  if (score >= 5.5) return 'Average';
  if (score >= 3.5) return 'Below Average';
  return 'Poor';
}

// ─── Ranking ──────────────────────────────────────────────────────────────────

/**
 * Ranks vendors within a category, injecting a rank field into each object.
 */
export function rankVendors(vendors: VendorWithCriteria[]): Array<VendorWithCriteria & { rank: number }> {
  return [...vendors]
    .sort((a, b) => b.rankingScore - a.rankingScore)
    .map((v, i) => ({ ...v, rank: i + 1 }));
}

/**
 * Returns chart data points for a bar chart of vendor scores in a category.
 */
export function vendorScoreChartData(vendors: VendorWithCriteria[]): ChartDataPoint[] {
  return rankVendors(vendors).map(v => ({
    label: v.name,
    value: parseFloat(v.rankingScore.toFixed(2)),
    color: scoreToColor(v.rankingScore),
  }));
}

/**
 * Returns radar chart data for a single vendor's criteria breakdown.
 */
export function criteriaRadarData(vendor: VendorWithCriteria): ChartDataPoint[] {
  if (!vendor.criteria) return [];

  const metadata = getRankingCriteriaMetadataForCategory(vendor.categoryName);
  return metadata.map(item => ({
    label: item.label,
    value: clamp((vendor.criteria as any)[item.key] ?? 0, 0, 10),
  }));
}

/**
 * Distribution of market positions in a category.
 */
export function marketPositionDistribution(vendors: VendorWithCriteria[]): ChartDataPoint[] {
  const counts: Record<string, number> = {};
  vendors.forEach(v => {
    const pos = v.marketPosition ?? 'unknown';
    counts[pos] = (counts[pos] ?? 0) + 1;
  });
  return Object.entries(counts).map(([label, value]) => ({ label, value }));
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function clamp(val: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, val));
}

function scoreToColor(score: number): string {
  if (score >= 8.5) return '#22c55e'; // green
  if (score >= 7.0) return '#3b82f6'; // blue
  if (score >= 5.5) return '#f59e0b'; // amber
  if (score >= 3.5) return '#f97316'; // orange
  return '#ef4444'; // red
}
