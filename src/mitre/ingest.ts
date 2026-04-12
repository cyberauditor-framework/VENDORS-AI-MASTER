/**
 * MITRE ATT&CK STIX ingestion
 *
 * Fetches the enterprise-attack STIX 2.1 bundle from the official MITRE CTI
 * repository on GitHub and parses it into MitreEntry records.
 *
 * Supported object types:
 *   attack-pattern    → technique
 *   x-mitre-tactic    → tactic
 *   intrusion-set     → group
 *   tool / malware    → software
 *   course-of-action  → mitigation
 */

import axios from 'axios';
import { MitreEntry, MitreEntryType, MitreReference } from './types';

// ─── Constants ────────────────────────────────────────────────────────────────

const STIX_URL =
  'https://raw.githubusercontent.com/mitre/cti/master/enterprise-attack/enterprise-attack.json';

const REQUEST_TIMEOUT_MS = 90_000; // the bundle is ~15 MB

// ─── STIX internal shapes ────────────────────────────────────────────────────

interface StixBundle {
  type: string;
  objects: StixObject[];
}

interface StixObject {
  type: string;
  id: string;
  name?: string;
  description?: string;
  external_references?: StixExternalRef[];
  kill_chain_phases?: StixKillChain[];
  x_mitre_platforms?: string[];
  x_mitre_data_sources?: string[];
  x_mitre_detection?: string;
  x_mitre_is_subtechnique?: boolean;
  x_mitre_deprecated?: boolean;
  x_mitre_shortname?: string;   // x-mitre-tactic only
  revoked?: boolean;
  modified?: string;
}

interface StixExternalRef {
  source_name: string;
  url?: string;
  external_id?: string;
  description?: string;
}

interface StixKillChain {
  kill_chain_name: string;
  phase_name: string;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Downloads the MITRE ATT&CK STIX bundle and returns parsed MitreEntry[]
 * for all non-revoked, non-deprecated objects.
 *
 * @param onProgress Optional progress callback for CLI output.
 */
export async function fetchMitreStixBundle(
  onProgress?: (msg: string) => void,
): Promise<MitreEntry[]> {
  onProgress?.(`Fetching MITRE ATT&CK STIX bundle from GitHub...`);

  let bundle: StixBundle;
  try {
    const response = await axios.get<StixBundle>(STIX_URL, {
      timeout: REQUEST_TIMEOUT_MS,
      responseType: 'json',
      headers: {
        'User-Agent': 'vendors-ai-master/1.0 (security-research)',
        'Accept': 'application/json',
      },
      // Prevent axios from trying to decompress non-gzip payloads
      decompress: true,
    });
    bundle = response.data;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to fetch MITRE ATT&CK data: ${msg}`);
  }

  if (bundle.type !== 'bundle' || !Array.isArray(bundle.objects)) {
    throw new Error(
      `Unexpected STIX bundle format (type="${bundle.type}"). ` +
      'The upstream URL may have changed.',
    );
  }

  onProgress?.(`Parsing ${bundle.objects.length.toLocaleString()} STIX objects...`);

  const entries: MitreEntry[] = [];

  for (const obj of bundle.objects) {
    // Skip revoked or deprecated objects — they are superseded
    if (obj.revoked || obj.x_mitre_deprecated) continue;

    const entry = parseStixObject(obj);
    if (entry) entries.push(entry);
  }

  onProgress?.(
    `Parsed ${entries.length.toLocaleString()} valid entries ` +
    `(techniques, tactics, groups, software, mitigations).`,
  );

  return entries;
}

// ─── Object parser ────────────────────────────────────────────────────────────

function parseStixObject(obj: StixObject): MitreEntry | null {
  const type = stixTypeToEntryType(obj.type);
  if (!type) return null;

  // Every entry we care about must have a mitre-attack external reference
  const attackRef = obj.external_references?.find(
    r => r.source_name === 'mitre-attack' && r.external_id,
  );
  if (!attackRef?.external_id) return null;

  // All external references as structured records
  const references: MitreReference[] = (obj.external_references ?? [])
    .filter(r => r.url || r.description)
    .map(r => ({
      sourceName: r.source_name,
      url: r.url,
      description: r.description,
    }));

  // Tactic phase names from the MITRE ATT&CK kill chain
  const tactics = (obj.kill_chain_phases ?? [])
    .filter(p => p.kill_chain_name === 'mitre-attack')
    .map(p => p.phase_name);

  const isSubtechnique = obj.x_mitre_is_subtechnique ?? false;
  // Sub-technique IDs follow the pattern T1234.001 — parent is T1234
  const parentId = isSubtechnique
    ? attackRef.external_id.includes('.')
      ? attackRef.external_id.split('.')[0]
      : undefined
    : undefined;

  return {
    id: attackRef.external_id,
    stixId: obj.id,
    type,
    name: obj.name ?? '',
    description: (obj.description ?? '').trim(),
    url:
      attackRef.url ??
      buildFallbackUrl(type, attackRef.external_id),
    tactics,
    platforms: obj.x_mitre_platforms ?? [],
    dataSources: obj.x_mitre_data_sources ?? [],
    detection: (obj.x_mitre_detection ?? '').trim(),
    references,
    isSubtechnique,
    parentId,
    modified: obj.modified ?? new Date().toISOString(),
    deprecated: false,
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function stixTypeToEntryType(stixType: string): MitreEntryType | null {
  switch (stixType) {
    case 'attack-pattern':    return 'technique';
    case 'x-mitre-tactic':   return 'tactic';
    case 'intrusion-set':     return 'group';
    case 'tool':
    case 'malware':           return 'software';
    case 'course-of-action':  return 'mitigation';
    default:                  return null;
  }
}

function buildFallbackUrl(type: MitreEntryType, id: string): string {
  // e.g. T1566.001 → techniques/T1566/001
  switch (type) {
    case 'technique': {
      const parts = id.split('.');
      return parts.length === 2
        ? `https://attack.mitre.org/techniques/${parts[0]}/${parts[1]}/`
        : `https://attack.mitre.org/techniques/${id}/`;
    }
    case 'tactic':
      return `https://attack.mitre.org/tactics/${id}/`;
    case 'group':
      return `https://attack.mitre.org/groups/${id}/`;
    case 'software':
      return `https://attack.mitre.org/software/${id}/`;
    case 'mitigation':
      return `https://attack.mitre.org/mitigations/${id}/`;
    default:
      return `https://attack.mitre.org/`;
  }
}
