// ─── MITRE ATT&CK Entry Types ─────────────────────────────────────────────────

export type MitreEntryType =
  | 'technique'   // attack-pattern  (T1566, T1566.001)
  | 'tactic'      // x-mitre-tactic  (TA0001)
  | 'group'       // intrusion-set   (G0032 — APT29)
  | 'software'    // tool / malware  (S0154 — Cobalt Strike)
  | 'mitigation'; // course-of-action (M1035)

export interface MitreReference {
  sourceName: string;
  url?: string;
  description?: string;
}

export interface MitreEntry {
  /** ATT&CK short ID: T1566, TA0001, G0032, S0154, M1035 */
  id: string;
  /** Full STIX UUID */
  stixId: string;
  type: MitreEntryType;
  name: string;
  description: string;
  /** Canonical ATT&CK URL */
  url: string;
  /** Kill-chain phase names this technique belongs to (for techniques only) */
  tactics: string[];
  /** Target platforms: Windows, Linux, macOS, Cloud, etc. */
  platforms: string[];
  /** Data sources that can surface this technique */
  dataSources: string[];
  /** Free-text detection guidance */
  detection: string;
  /** External references (CVEs, papers, blog posts) */
  references: MitreReference[];
  /** True if this is a sub-technique (e.g. T1566.001) */
  isSubtechnique: boolean;
  /** Parent technique ID when isSubtechnique is true */
  parentId?: string;
  /** ISO 8601 last-modified timestamp from STIX */
  modified: string;
  deprecated: boolean;
}

// ─── Embedding / Retrieval ────────────────────────────────────────────────────

export interface EmbeddingResult {
  entryId: string;
  vector: number[];
  model: string;
  dimensions: number;
}

export interface RetrievedEntry {
  entry: MitreEntry;
  /** Cosine similarity score in [0, 1] */
  score: number;
}

export interface MitreRagResult {
  query: string;
  entries: RetrievedEntry[];
  /** Pre-formatted context block ready to inject into an LLM prompt */
  formattedContext: string;
  /** Total entries currently in the vector index */
  totalEntries: number;
}
