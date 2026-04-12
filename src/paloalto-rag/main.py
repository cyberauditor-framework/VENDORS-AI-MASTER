"""
Palo Alto Networks MITRE ATT&CK RAG — FastAPI service.

Endpoints
─────────
GET  /health          — liveness + chunk count
GET  /stats           — metadata breakdown (by product, action, source)
POST /query           — semantic search with self-querying filter extraction
POST /ingest          — ingest URLs, local files, or raw text
DELETE /reset         — wipe the entire vector store

Start: python main.py   (or via `npm run paloalto:start`)
"""

from __future__ import annotations
import logging
import sys
import os

# Add the directory containing this file to the Python path so imports work
# whether launched via `python main.py` or `uvicorn main:app`.
sys.path.insert(0, os.path.dirname(__file__))

import uvicorn
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from contextlib import asynccontextmanager

from models import IngestRequest, IngestResponse, QueryRequest, QueryResponse, StatsResponse
from ingestion import scrape_url, load_pdf, load_html_file, load_json_file
from chunking import chunk_documents
from vector_store import add_documents, get_stats, reset_store
from retrieval import retrieve
from config import SERVICE_PORT, DEFAULT_SEED_URLS

# ── Logging ───────────────────────────────────────────────────────────────────

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s %(levelname)-8s %(name)s — %(message)s',
    datefmt='%H:%M:%S',
)
log = logging.getLogger('paloalto-rag')


# ── App ───────────────────────────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    log.info('Palo Alto Networks MITRE RAG service starting on port %d', SERVICE_PORT)
    yield
    log.info('Service shutting down')

app = FastAPI(
    title='Palo Alto Networks MITRE ATT&CK RAG',
    version='1.0.0',
    description=(
        'Semantic search over Palo Alto Networks documentation '
        '(TechDocs, Unit 42, Cortex XDR, MITRE Evaluations). '
        'Provides MITRE ATT&CK coverage analysis with confidence scores and source attribution.'
    ),
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=['*'],
    allow_methods=['*'],
    allow_headers=['*'],
)


# ── Routes ────────────────────────────────────────────────────────────────────

@app.get('/health', tags=['system'])
def health():
    """Liveness check — returns status and chunk count."""
    try:
        stats = get_stats()
        return {'status': 'ok', 'chunks': stats['total_chunks'], 'port': SERVICE_PORT}
    except Exception as exc:
        return {'status': 'degraded', 'error': str(exc), 'chunks': 0}


@app.get('/stats', response_model=StatsResponse, tags=['system'])
def stats():
    """Return metadata breakdown: counts by product line, action type, and source type."""
    return get_stats()


@app.post('/query', response_model=QueryResponse, tags=['retrieval'])
def query(req: QueryRequest):
    """
    Semantic search with optional self-querying metadata filter extraction.

    The self-query layer parses MITRE IDs, product names, and action keywords
    from the natural-language query to build structured filters automatically.
    Override with explicit `filters` dict if needed.
    """
    try:
        return retrieve(req.query, req.top_k, req.filters, req.use_self_query)
    except Exception as exc:
        log.exception('Query failed: %s', exc)
        raise HTTPException(status_code=500, detail=str(exc))


@app.post('/ingest', response_model=IngestResponse, tags=['ingestion'])
def ingest(req: IngestRequest):
    """
    Ingest documents into the vector store.

    Sources:
    • urls         — list of HTTP/HTTPS URLs to scrape
    • files        — local file paths (.pdf / .html / .json)
    • text         — raw text string to embed directly
    • use_defaults — also ingest the built-in seed URLs
    """
    errors:         list[str] = []
    total_ingested: int       = 0
    total_skipped:  int       = 0

    meta_overrides = req.metadata or {}

    # Build URL list
    urls = list(req.urls or [])
    if req.use_defaults:
        urls = list(dict.fromkeys(urls + DEFAULT_SEED_URLS))   # deduplicate, preserve order

    # ── Scrape URLs ──────────────────────────────────────────────────────────
    for url in urls:
        try:
            raw    = scrape_url(url, meta_overrides if meta_overrides else None)
            if not raw:
                errors.append(f'No content scraped from: {url}')
                total_skipped += 1
                continue
            chunks         = chunk_documents(raw)
            added, skipped = add_documents(chunks)
            total_ingested += added
            total_skipped  += skipped
            log.info('URL %s → %d added, %d skipped', url, added, skipped)
        except Exception as exc:
            errors.append(f'URL {url}: {exc}')
            total_skipped += 1

    # ── Load local files ─────────────────────────────────────────────────────
    for file_path in (req.files or []):
        try:
            path = file_path.lower()
            if path.endswith('.pdf'):
                raw = load_pdf(file_path, meta_overrides if meta_overrides else None)
            elif path.endswith('.html') or path.endswith('.htm'):
                raw = load_html_file(file_path, meta_overrides if meta_overrides else None)
            elif path.endswith('.json'):
                raw = load_json_file(file_path, meta_overrides if meta_overrides else None)
            else:
                errors.append(f'Unsupported file type: {file_path}')
                total_skipped += 1
                continue

            if not raw:
                errors.append(f'No content loaded from file: {file_path}')
                total_skipped += 1
                continue

            chunks         = chunk_documents(raw)
            added, skipped = add_documents(chunks)
            total_ingested += added
            total_skipped  += skipped
            log.info('File %s → %d added, %d skipped', file_path, added, skipped)
        except Exception as exc:
            errors.append(f'File {file_path}: {exc}')
            total_skipped += 1

    # ── Ingest raw text ──────────────────────────────────────────────────────
    if req.text:
        try:
            from langchain_core.documents import Document
            meta = {
                'source_url':  'manual',
                'source_type': 'manual',
                'doc_title':   'Manual Input',
                'chunk_index': 0,
            }
            meta.update(meta_overrides)
            raw            = [Document(page_content=req.text, metadata=meta)]
            chunks         = chunk_documents(raw)
            added, skipped = add_documents(chunks)
            total_ingested += added
            total_skipped  += skipped
            log.info('Manual text → %d added, %d skipped', added, skipped)
        except Exception as exc:
            errors.append(f'Manual text: {exc}')

    return IngestResponse(ingested=total_ingested, skipped=total_skipped, errors=errors)


@app.delete('/reset', tags=['system'])
def reset():
    """Wipe the entire vector store. Irreversible."""
    deleted = reset_store()
    log.info('Vector store reset — deleted %d chunks', deleted)
    return {'deleted': deleted}


# ── Entrypoint ────────────────────────────────────────────────────────────────

if __name__ == '__main__':
    uvicorn.run(
        'main:app',
        host='0.0.0.0',
        port=SERVICE_PORT,
        reload=False,
        log_level='info',
    )
