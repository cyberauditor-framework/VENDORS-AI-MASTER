"""
Document loaders for PDF, JSON, HTML, and live web scraping.

Each loader returns a list of LangChain Documents with a pre-populated
metadata dict conforming to the rich schema required by the RAG:

    mitre_id       — primary MITRE ATT&CK ID found in the document
    technique_name — human-readable name for that technique (if detectable)
    product_line   — Strata | Prisma | Cortex | Unit42 | General
    action_type    — Prevention | Detection | Investigation | Intelligence | General
    source_url     — origin URL or file path
    source_type    — techdocs | unit42 | cortex_xdr | mitre_evaluations | manual
    doc_title      — page / document title
    chunk_index    — will be set by the chunker; default 0 here
"""

from __future__ import annotations
import re
import json
import logging
from pathlib import Path
from typing import List, Dict, Any, Optional

import requests
from bs4 import BeautifulSoup
from langchain_core.documents import Document

log = logging.getLogger('paloalto-rag.ingestion')

# ── Regex helpers ─────────────────────────────────────────────────────────────

_MITRE_ID_RE = re.compile(r'\b(T\d{4}(?:\.\d{3})?)\b', re.IGNORECASE)

_PRODUCT_KEYWORDS: Dict[str, List[str]] = {
    'Cortex':  ['cortex xdr', 'cortex', ' xdr', 'bioc', 'behavioral indicator', 'xsoar', 'cortex data lake'],
    'Prisma':  ['prisma', 'prisma cloud', 'prisma access', 'sase', 'cloud security posture'],
    'Strata':  ['strata', 'ngfw', 'panos', 'pa-series', 'vm-series', 'panorama', 'firewall'],
    'Unit42':  ['unit 42', 'unit42', 'threat intel', 'apt', 'campaign', 'threat group'],
}

_ACTION_KEYWORDS: Dict[str, List[str]] = {
    'Prevention':    ['prevent', 'block', 'stop', 'deny', 'drop packet', 'policy enforcement', 'signature block'],
    'Detection':     ['detect', 'alert', 'monitor', 'identify', 'bioc', 'ioc', 'behavioral indicator', 'signature match', 'telemetry'],
    'Investigation': ['investig', 'forensic', 'incident response', 'hunt', 'query', 'timeline', 'artifact'],
    'Intelligence':  ['threat intel', 'apt', 'actor', 'campaign', 'malware family', 'ransomware group', 'ioc feed'],
}

_SOURCE_PATTERNS: Dict[str, List[str]] = {
    'unit42':            ['unit42.paloaltonetworks.com'],
    'mitre_evaluations': ['mitre-attack-evaluations', 'mitre-attack-eval', 'attackevaluations'],
    'cortex_xdr':        ['cortex-xdr', 'cortexlake', 'cortex/cortex-xdr'],
    'techdocs':          ['docs.paloaltonetworks.com'],
}


# ── Classification helpers ────────────────────────────────────────────────────

def _classify_url(url: str) -> Dict[str, str]:
    """Derive product_line, action_type, source_type from a URL."""
    u = url.lower()

    source_type = 'manual'
    for stype, patterns in _SOURCE_PATTERNS.items():
        if any(p in u for p in patterns):
            source_type = stype
            break

    product_line = 'General'
    for prod, kws in _PRODUCT_KEYWORDS.items():
        if any(k in u for k in kws):
            product_line = prod
            break

    action_type = 'General'
    for action, kws in _ACTION_KEYWORDS.items():
        if any(k in u for k in kws):
            action_type = action
            break

    return {'source_type': source_type, 'product_line': product_line, 'action_type': action_type}


def _classify_text(text: str) -> Dict[str, str]:
    """Derive product_line / action_type from document text (fallback for files)."""
    t = text.lower()

    product_line = 'General'
    for prod, kws in _PRODUCT_KEYWORDS.items():
        if any(k in t for k in kws):
            product_line = prod
            break

    action_type = 'General'
    for action, kws in _ACTION_KEYWORDS.items():
        if any(k in t for k in kws):
            action_type = action
            break

    return {'product_line': product_line, 'action_type': action_type}


def _extract_mitre_ids(text: str) -> List[str]:
    """Return deduplicated list of MITRE ATT&CK IDs found in text."""
    return list(dict.fromkeys(m.upper() for m in _MITRE_ID_RE.findall(text)))


def _base_meta(
    source_url: str,
    doc_title: str,
    extra: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """Build a complete metadata dict with all required keys set to safe defaults."""
    meta: Dict[str, Any] = {
        'mitre_id':       '',
        'technique_name': '',
        'product_line':   'General',
        'action_type':    'General',
        'source_url':     source_url,
        'source_type':    'manual',
        'doc_title':      doc_title,
        'chunk_index':    0,
    }
    if extra:
        meta.update(extra)
    # Normalise: Chroma rejects None values in metadata
    return {k: ('' if v is None else v) for k, v in meta.items()}


# ── Web scraper ───────────────────────────────────────────────────────────────

_SCRAPE_HEADERS = {
    'User-Agent': (
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) '
        'AppleWebKit/537.36 (KHTML, like Gecko) '
        'Chrome/124.0 Safari/537.36'
    )
}


def scrape_url(url: str, meta_overrides: Optional[Dict[str, Any]] = None) -> List[Document]:
    """
    Fetch a URL, strip boilerplate, return a single Document with rich metadata.
    Returns an empty list on any error (caller decides whether to log/skip).
    """
    try:
        resp = requests.get(url, headers=_SCRAPE_HEADERS, timeout=30, allow_redirects=True)
        resp.raise_for_status()
    except Exception as exc:
        log.warning('GET %s failed: %s', url, exc)
        return []

    soup = BeautifulSoup(resp.text, 'html.parser')

    # Remove noisy boilerplate elements
    for tag in soup(['script', 'style', 'nav', 'footer', 'header',
                     'aside', 'form', 'noscript', 'iframe']):
        tag.decompose()

    title_tag = soup.find('title')
    title = title_tag.get_text(strip=True) if title_tag else url

    # Try to isolate the main content region
    main = (
        soup.find('main')
        or soup.find('article')
        or soup.find(id=re.compile(r'content|main|body', re.I))
        or soup.find('div', class_=re.compile(r'content|main|body|article', re.I))
        or soup.body
        or soup
    )
    text = re.sub(r'\n{3,}', '\n\n', main.get_text(separator='\n', strip=True)).strip()

    if len(text) < 100:
        log.debug('Skipping %s — too little text (%d chars)', url, len(text))
        return []

    # Build metadata
    url_meta  = _classify_url(url)
    text_meta = _classify_text(text)
    # URL classification wins; text classification fills gaps
    product_line = url_meta.get('product_line') if url_meta.get('product_line') != 'General' else text_meta.get('product_line', 'General')
    action_type  = url_meta.get('action_type')  if url_meta.get('action_type')  != 'General' else text_meta.get('action_type', 'General')

    ids = _extract_mitre_ids(text)
    meta = _base_meta(url, title, {
        **url_meta,
        'product_line':    product_line,
        'action_type':     action_type,
        'mitre_id':        ids[0] if ids else '',
        'mitre_ids_found': ','.join(ids[:15]) if ids else '',
    })
    if meta_overrides:
        meta.update(meta_overrides)

    return [Document(page_content=text, metadata=meta)]


# ── PDF loader ────────────────────────────────────────────────────────────────

def load_pdf(file_path: str, meta_overrides: Optional[Dict[str, Any]] = None) -> List[Document]:
    """Load a PDF file. Each page becomes a Document."""
    try:
        from pypdf import PdfReader
    except ImportError:
        log.error('pypdf not installed — run: pip install pypdf')
        return []

    try:
        reader = PdfReader(file_path)
        docs: List[Document] = []
        for page_num, page in enumerate(reader.pages):
            text = page.extract_text() or ''
            text = re.sub(r'\n{3,}', '\n\n', text).strip()
            if not text:
                continue
            ids = _extract_mitre_ids(text)
            meta = _base_meta(file_path, Path(file_path).stem, {
                **_classify_text(text),
                'source_type':     'manual',
                'chunk_index':     page_num,
                'mitre_id':        ids[0] if ids else '',
                'mitre_ids_found': ','.join(ids[:15]) if ids else '',
            })
            if meta_overrides:
                meta.update(meta_overrides)
            docs.append(Document(page_content=text, metadata=meta))
        return docs
    except Exception as exc:
        log.error('Failed to load PDF %s: %s', file_path, exc)
        return []


# ── HTML file loader ──────────────────────────────────────────────────────────

def load_html_file(file_path: str, meta_overrides: Optional[Dict[str, Any]] = None) -> List[Document]:
    """Load a local HTML file."""
    try:
        with open(file_path, encoding='utf-8', errors='replace') as fh:
            content = fh.read()
    except Exception as exc:
        log.error('Failed to open HTML %s: %s', file_path, exc)
        return []

    soup = BeautifulSoup(content, 'html.parser')
    for tag in soup(['script', 'style', 'nav', 'footer', 'header', 'aside']): tag.decompose()

    title_tag = soup.find('title')
    title = title_tag.get_text(strip=True) if title_tag else Path(file_path).name
    text  = re.sub(r'\n{3,}', '\n\n', (soup.body or soup).get_text(separator='\n', strip=True)).strip()

    if not text:
        return []

    ids  = _extract_mitre_ids(text)
    meta = _base_meta(file_path, title, {
        **_classify_text(text),
        'source_type':     'manual',
        'mitre_id':        ids[0] if ids else '',
        'mitre_ids_found': ','.join(ids[:15]) if ids else '',
    })
    if meta_overrides:
        meta.update(meta_overrides)

    return [Document(page_content=text, metadata=meta)]


# ── JSON file loader ──────────────────────────────────────────────────────────

def load_json_file(file_path: str, meta_overrides: Optional[Dict[str, Any]] = None) -> List[Document]:
    """
    Load a JSON file.
    Handles arrays of objects (each becomes a Document) or a single object
    (converted to a formatted string Document).
    """
    try:
        with open(file_path, encoding='utf-8') as fh:
            data = json.load(fh)
    except Exception as exc:
        log.error('Failed to load JSON %s: %s', file_path, exc)
        return []

    items = data if isinstance(data, list) else [data]
    docs: List[Document] = []

    for idx, item in enumerate(items):
        if isinstance(item, dict):
            text = json.dumps(item, ensure_ascii=False, indent=2)
        else:
            text = str(item)
        if not text.strip():
            continue
        ids = _extract_mitre_ids(text)
        # Detect MITRE ATT&CK JSON fields explicitly
        mitre_id = (
            item.get('external_id') or item.get('id') or (ids[0] if ids else '')
        ) if isinstance(item, dict) else (ids[0] if ids else '')
        name = (
            item.get('name') or item.get('technique_name') or ''
        ) if isinstance(item, dict) else ''

        meta = _base_meta(file_path, Path(file_path).stem, {
            'source_type':     'manual',
            'chunk_index':     idx,
            'mitre_id':        str(mitre_id)[:20],
            'technique_name':  str(name)[:100],
            'mitre_ids_found': ','.join(ids[:15]) if ids else '',
        })
        if meta_overrides:
            meta.update(meta_overrides)
        docs.append(Document(page_content=text, metadata=meta))

    return docs
