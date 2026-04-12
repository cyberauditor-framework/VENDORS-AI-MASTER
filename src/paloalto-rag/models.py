"""
Pydantic models for request / response payloads.
"""

from __future__ import annotations
from typing import Optional, List, Dict, Any
from pydantic import BaseModel


# ── Rich metadata schema ──────────────────────────────────────────────────────
# Every vector in Chroma stores these fields.  The values below are the
# canonical allowed strings — ingestion code normalises to these.

PRODUCT_LINES  = ('Strata', 'Prisma', 'Cortex', 'Unit42', 'General')
ACTION_TYPES   = ('Prevention', 'Detection', 'Investigation', 'Intelligence', 'General')
SOURCE_TYPES   = ('techdocs', 'unit42', 'cortex_xdr', 'mitre_evaluations', 'manual')


# ── API request / response models ────────────────────────────────────────────

class IngestRequest(BaseModel):
    """Ingest one or more sources into the vector store."""
    urls:         Optional[List[str]]       = None   # HTTP URLs to scrape
    files:        Optional[List[str]]       = None   # Local file paths (PDF/HTML/JSON)
    text:         Optional[str]             = None   # Raw text to embed directly
    metadata:     Optional[Dict[str, Any]]  = None   # Metadata overrides for all docs
    use_defaults: bool                      = False  # Ingest DEFAULT_SEED_URLS


class QueryRequest(BaseModel):
    """Query the RAG for relevant Palo Alto / MITRE ATT&CK content."""
    query:          str
    top_k:          int                          = 5
    filters:        Optional[Dict[str, str]]     = None   # metadata filter overrides
    use_self_query: bool                         = True   # parse filters from query text


class SourceAttribution(BaseModel):
    url:         str
    title:       str
    source_type: str
    chunk_index: int


class RetrievedChunk(BaseModel):
    content:     str
    score:       float           # cosine relevance 0–1  (1 = most similar)
    metadata:    Dict[str, Any]
    attribution: SourceAttribution


class QueryResponse(BaseModel):
    answer:           str
    confidence_score: float                      # average score of top-k chunks
    sources:          List[SourceAttribution]
    chunks:           List[RetrievedChunk]
    applied_filter:   Optional[Dict[str, Any]]   = None


class IngestResponse(BaseModel):
    ingested: int
    skipped:  int
    errors:   List[str]


class StatsResponse(BaseModel):
    total_chunks:   int
    by_product:     Dict[str, int]
    by_action:      Dict[str, int]
    by_source:      Dict[str, int]
    unique_sources: int
