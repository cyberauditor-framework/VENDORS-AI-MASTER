// ─── MITRE ATT&CK Vendor Coverage Report ─────────────────────────────────────

export type CoverageLevel = 'full' | 'partial' | 'none' | 'unknown';

export interface TtpCoverage {
  /** ATT&CK technique ID, e.g. T1566 or T1566.001 */
  techniqueId: string;
  techniqueName: string;
  /** Tactic phase names this technique belongs to */
  tactics: string[];
  /** How completely the vendor addresses this technique */
  coverageLevel: CoverageLevel;
  /** Specific products or features that provide coverage */
  products: string[];
  /** Free-text explanation of how the vendor mitigates the technique */
  description: string;
  /** Source URLs that support this assessment */
  evidenceUrls: string[];
}

export interface MitreCoverageReport {
  vendor: string;
  analysisDate: string;
  /** All techniques the vendor has some degree of coverage for */
  ttpsAddressed: TtpCoverage[];
  /** Technique IDs / names with no or minimal coverage identified */
  coverageGaps: string[];
  /** Weighted score 0–10 reflecting breadth and depth of ATT&CK coverage */
  overallCoverageScore: number;
  /** 2–3 sentence executive summary */
  summary: string;
  /** Every URL consulted during the analysis */
  sourcesConsulted: string[];
  /** True when the agent exhausted iterations without a conclusive answer */
  insufficientInfo: boolean;
}
