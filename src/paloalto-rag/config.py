"""
Configuration — reads the same .env used by the Node.js backend so both
processes share LM Studio URL, API key, and embedding model settings.
"""

import os
from pathlib import Path
from dotenv import load_dotenv

# Load project-root .env (two directories up from this file)
_ROOT = Path(__file__).resolve().parents[2]
load_dotenv(_ROOT / '.env')

# ── LM Studio (shared with Node.js backend) ──────────────────────────────────
LM_STUDIO_URL     = os.getenv('LM_STUDIO_URL', 'http://localhost:1234/v1')
LM_STUDIO_API_KEY = os.getenv('LM_STUDIO_API_KEY', 'lm-studio')
EMBEDDING_MODEL   = os.getenv('EMBEDDING_MODEL', 'text-embedding-nomic-embed-text-v1.5')
LLM_MODEL         = os.getenv('LM_STUDIO_MODEL', 'local-model')

# ── Vector store ─────────────────────────────────────────────────────────────
CHROMA_DIR        = _ROOT / 'data' / 'paloalto-rag'
CHROMA_COLLECTION = 'paloalto_mitre'

# ── Chunking ──────────────────────────────────────────────────────────────────
CHUNK_SIZE    = 800
CHUNK_OVERLAP = 150

# ── Service ──────────────────────────────────────────────────────────────────
SERVICE_PORT  = int(os.getenv('PALOALTO_RAG_PORT', '8765'))
DEFAULT_TOP_K = 5

# ── Default seed URLs ─────────────────────────────────────────────────────────
# These are ingested when the user runs `npm run paloalto:ingest` or clicks
# "Ingest Default Sources" in the UI.
DEFAULT_SEED_URLS: list[str] = [
    # Cortex XDR — MITRE ATT&CK integration (native coverage page)
    'https://docs.paloaltonetworks.com/cortex/cortex-xdr/cortex-xdr-pro-admin/external-integrations/mitre-attack-integration',
    # MITRE ATT&CK Evaluations — Palo Alto results
    'https://www.paloaltonetworks.com/cortex/mitre-attack-evaluations',
    # Unit 42 — threat intelligence hub
    'https://unit42.paloaltonetworks.com/',
    # Cortex XDR product overview
    'https://docs.paloaltonetworks.com/cortex/cortex-xdr',
    # Prisma Cloud security overview
    'https://docs.paloaltonetworks.com/prisma/prisma-cloud',
    # Strata NGFW overview
    'https://docs.paloaltonetworks.com/pan-os',
    # MITRE ATT&CK framework page for Palo Alto
    'https://www.paloaltonetworks.com/cyberpedia/what-is-mitre-attack',
]
