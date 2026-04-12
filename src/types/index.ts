// ─── Core Domain Types ───────────────────────────────────────────────────────

export interface Category {
  id?: number;
  name: string;
  fullName: string;
  description: string;
  createdAt?: string;
}

export type AcquisitionMode =
  | 'commercial'
  | 'open-source'
  | 'freemium'
  | 'subscription'
  | 'license'
  | 'cloud-only'
  | 'hybrid'
  | 'unknown';

export type MarketPosition =
  | 'leader'
  | 'challenger'
  | 'visionary'
  | 'niche'
  | 'unknown';

export type GeographicRegion =
  | 'global'
  | 'north-america'
  | 'europe'
  | 'asia-pacific'
  | 'latin-america'
  | 'middle-east-africa'
  | 'unknown';

export interface Vendor {
  id?: number;
  name: string;
  categoryId: number;
  categoryName?: string;
  description: string;
  advantages: string[];
  disadvantages: string[];
  pricingModel: string;
  foundedYear: number | null;
  securityCertifications: string[];
  geographicRegion: GeographicRegion;
  resourceLinks: string[];
  awards: string[];
  acquisitionMode: AcquisitionMode;
  website: string;
  rankingScore: number;
  marketPosition: MarketPosition;
  rationale?: Record<string, string> | null;
  criterionEvidence?: Record<string, string[]> | null;
  rawAnalysis?: string;
  searchDate?: string;
}

export interface RankingCriteria {
  id?: number;
  vendorId: number;
  uebaNativeMl: number;                 // 0–10
  llmCorrelationReasoning: number;      // 0–10
  autonomousTriageAlertReduction: number; // 0–10
  soarIntegratedPlaybooks: number;      // 0–10
  intelligentIngestionNoParsers: number; // 0–10
  semanticSearchEmbeddings: number;     // 0–10
  cloudNativeAiScale: number;           // 0–10
  realtimeThreatIntelEnrichment: number; // 0–10
  auditableXaiNis2Dora: number;         // 0–10
  measurableRoiMttaMttr: number;        // 0–10
}

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
  source?: string;
}

export interface SearchRecord {
  id?: number;
  vendorId?: number;
  query: string;
  sourceUrl: string;
  snippet: string;
  scrapedContent?: string;
  searchDate?: string;
}

// ─── ReAct Agent Types ────────────────────────────────────────────────────────

export type ReActStepType =
  | 'thought'
  | 'action'
  | 'observation'
  | 'reflection'
  | 'answer';

export interface ReActStep {
  type: ReActStepType;
  content: string;
  timestamp: string;
}

export interface ParsedReActResponse {
  thought: string;
  action: string;
  actionInput: string;
  isFinal: boolean;
  finalAnswer?: string;
}

export interface VendorAnalysis {
  vendor: Vendor;
  rankingCriteria: RankingCriteria;
  searchRecords: SearchRecord[];
  reactSteps: ReActStep[];
  processingTimeMs: number;
}

// ─── LLM / Agent Config ────────────────────────────────────────────────────────

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface AgentConfig {
  lmStudioUrl: string;
  apiKey: string;
  model: string;
  temperature: number;
  maxTokens: number;
  maxSearchResults: number;
  maxReActIterations: number;
}

// ─── Query / Filter Types ─────────────────────────────────────────────────────

export interface QueryFilter {
  category?: string;
  minScore?: number;
  maxScore?: number;
  region?: GeographicRegion;
  acquisitionMode?: AcquisitionMode;
  marketPosition?: MarketPosition;
  certifications?: string[];
  sortBy?: 'score' | 'name' | 'founded' | 'category';
  sortOrder?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
}

export interface VendorWithCriteria extends Vendor {
  criteria?: RankingCriteria;
}

// ─── Export Types ─────────────────────────────────────────────────────────────

export type ExportFormat = 'markdown' | 'json' | 'html';

export interface ExportOptions {
  format: ExportFormat;
  outputPath: string;
  categories?: string[];
  includeCharts?: boolean;
  includeRawAnalysis?: boolean;
}

// ─── Chart Types ──────────────────────────────────────────────────────────────

export interface ChartDataPoint {
  label: string;
  value: number;
  color?: string;
}

export type ChartType = 'bar' | 'radar' | 'scatter' | 'pie';

export interface ChartConfig {
  type: ChartType;
  title: string;
  data: ChartDataPoint[];
  outputPath: string;
}

// ─── CLI Context ──────────────────────────────────────────────────────────────

export interface AnalyzeOptions {
  category?: string;
  vendor?: string;
  all?: boolean;
  force?: boolean;
  maxVendors?: number;
}

export interface ComparisonResult {
  categoryName: string;
  vendors: VendorWithCriteria[];
  topVendor: string;
  averageScore: number;
  scoreDistribution: ChartDataPoint[];
}
