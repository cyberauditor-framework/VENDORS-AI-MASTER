"""
Self-Querying Retriever — metadata filter extraction + semantic search.

Architecture
────────────
The "Self-Querying" layer is implemented as a lightweight, LLM-free keyword
parser that extracts metadata filters directly from the query string.  This is
intentionally simpler than LangChain's SelfQueryRetriever so it works reliably
with any local model without requiring structured JSON output.

Algorithm
─────────
1. Parse the query for MITRE IDs, product names, and action keywords.
2. If filters were extracted → run filtered semantic search first.
3. If filtered results are sparse (< 2 hits) → fall back to unfiltered search.
4. Compute confidence score = average cosine relevance of top-k chunks.
5. Format a structured answer with confidence and source attribution.
"""

from __future__ import annotations
import re
from typing import List, Optional, Dict, Any, Tuple

from langchain_core.documents import Document

from vector_store import similarity_search_with_scores
from models import RetrievedChunk, SourceAttribution, QueryResponse
from config import DEFAULT_TOP_K

# ── Metadata keyword tables ───────────────────────────────────────────────────

_MITRE_ID_RE = re.compile(r'\b(T\d{4}(?:\.\d{3})?)\b', re.IGNORECASE)

_PRODUCT_KWS: Dict[str, List[str]] = {
    'Cortex': [
        'cortex xdr', 'cortex', ' xdr ', 'xdr)', 'xdr,', 'bioc',
        'behavioral indicator of compromise', 'cortex data lake', 'xsoar',
    ],
    'Prisma': [
        'prisma cloud', 'prisma access', 'prisma', 'sase', 'cloud security posture management',
    ],
    'Strata': [
        'strata', 'ngfw', 'panos', 'pa-series', 'vm-series', 'panorama',
        'next-generation firewall', 'firewall',
    ],
    'Unit42': [
        'unit 42', 'unit42', 'threat intelligence', 'apt', 'campaign',
        'threat group', 'ransomware group',
    ],
}

_ACTION_KWS: Dict[str, List[str]] = {
    'Prevention': [
        'prevent', 'block', 'stop', 'deny', 'drop packet', 'policy enforcement',
        'security profile', 'anti-virus', 'wildfire block',
    ],
    'Detection': [
        'detect', 'alert', 'monitor', 'identify', 'bioc', 'ioc', 'indicator of compromise',
        'behavioral indicator', 'signature match', 'telemetry', 'log', 'event',
    ],
    'Investigation': [
        'investig', 'forensic', 'incident response', 'threat hunt', 'query',
        'timeline', 'artifact', 'causality chain',
    ],
    'Intelligence': [
        'threat intel', 'apt ', 'actor', 'campaign', 'malware family',
        'ransomware group', 'ioc feed', 'unit 42', 'unit42',
    ],
}


# ── Filter parser ─────────────────────────────────────────────────────────────

def parse_filters(query: str) -> Dict[str, str]:
    """
    Extract metadata filter hints from a natural-language query.

    Examples
    --------
    "Cortex XDR detection for T1059"    → {product_line: Cortex, mitre_id: T1059,  action_type: Detection}
    "Prisma Access lateral movement"    → {product_line: Prisma}
    "Unit 42 ransomware intelligence"   → {product_line: Unit42, action_type: Intelligence}
    """
    q = query.lower()
    filters: Dict[str, str] = {}

    # MITRE technique ID
    m = _MITRE_ID_RE.search(query)
    if m:
        filters['mitre_id'] = m.group(1).upper()

    # Product line (first match wins)
    for product, kws in _PRODUCT_KWS.items():
        if any(kw in q for kw in kws):
            filters['product_line'] = product
            break

    # Action type (first match wins)
    for action, kws in _ACTION_KWS.items():
        if any(kw in q for kw in kws):
            filters['action_type'] = action
            break

    return filters


def _chroma_filter(filters: Dict[str, str]) -> Optional[Dict]:
    """Convert simple key→value dict to Chroma where-clause format."""
    if not filters:
        return None
    if len(filters) == 1:
        k, v = next(iter(filters.items()))
        return {k: {'$eq': v}}
    return {'$and': [{k: {'$eq': v}} for k, v in filters.items()]}


# ── Core retrieval ────────────────────────────────────────────────────────────

def retrieve(
    query: str,
    top_k: int = DEFAULT_TOP_K,
    filter_overrides: Optional[Dict[str, str]] = None,
    use_self_query: bool = True,
) -> QueryResponse:
    """
    Retrieve relevant chunks and return a structured QueryResponse.

    Steps
    ─────
    1. Auto-detect metadata filters from query (if use_self_query=True).
    2. Merge with any caller-supplied filter_overrides.
    3. Run filtered search → if < 2 results, fall back to unfiltered.
    4. Score confidence as average cosine relevance.
    5. Build formatted answer with source attribution.
    """
    # Determine effective filters
    auto_filters  = parse_filters(query) if use_self_query else {}
    active        = {**auto_filters, **(filter_overrides or {})}
    chroma_f      = _chroma_filter(active)

    # Attempt filtered search first
    results: List[Tuple[Document, float]] = []
    if chroma_f:
        results = similarity_search_with_scores(query, k=top_k, filter_dict=chroma_f)

    # Fall back to unfiltered if sparse
    if len(results) < 2:
        results = similarity_search_with_scores(query, k=top_k + 2)
        active  = {}   # report: no filter was applied in the final pass

    if not results:
        return QueryResponse(
            answer=(
                'No relevant Palo Alto Networks / MITRE ATT&CK documentation found.\n'
                'Run `npm run paloalto:ingest` to populate the knowledge base.'
            ),
            confidence_score=0.0,
            sources=[],
            chunks=[],
            applied_filter=None,
        )

    # Build chunk list
    chunks_out: List[RetrievedChunk] = []
    seen: Dict[str, str] = {}     # url → title

    for doc, score in results[:top_k]:
        m     = doc.metadata
        url   = m.get('source_url', '')
        title = m.get('doc_title', url) or url
        stype = m.get('source_type', 'manual')
        cidx  = int(m.get('chunk_index', 0))

        attr = SourceAttribution(url=url, title=title, source_type=stype, chunk_index=cidx)
        chunks_out.append(RetrievedChunk(
            content=doc.page_content,
            score=round(float(score), 4),
            metadata={k: v for k, v in m.items()},
            attribution=attr,
        ))
        seen[url] = title

    # Confidence = average relevance score of returned chunks
    confidence = round(sum(c.score for c in chunks_out) / len(chunks_out), 4)

    answer  = _format_answer(query, chunks_out)
    sources = [
        SourceAttribution(url=u, title=t, source_type='', chunk_index=0)
        for u, t in seen.items()
    ]

    return QueryResponse(
        answer=answer,
        confidence_score=confidence,
        sources=sources,
        chunks=chunks_out,
        applied_filter=active or None,
    )


# ── Answer formatter ──────────────────────────────────────────────────────────

def _format_answer(query: str, chunks: List[RetrievedChunk]) -> str:
    if not chunks:
        return 'No relevant information found.'

    lines = [
        f'# 🔍 Cobertura Palo Alto Networks — MITRE ATT&CK',
        '',
        f'**Consulta:** _{query}_',
        f'**Resultados encontrados:** {len(chunks)}',
        '',
        '~ ' * 20,
        '',
    ]

    for i, chunk in enumerate(chunks, 1):
        m      = chunk.metadata
        prod   = m.get('product_line', '')
        action = m.get('action_type', '')
        mitre  = m.get('mitre_id', '') or m.get('mitre_ids_found', '')
        tech_name = m.get('technique_name', '')
        title  = chunk.attribution.title or chunk.attribution.url
        url    = chunk.attribution.url
        score  = chunk.score
        source_type = chunk.attribution.source_type or ''

        # Result header with number and title
        lines.append(f'## Resultado #{i}: {title}')
        lines.append('')

        # Metadata section with clear labels
        lines.append('**📋 Información:**')
        
        if prod and prod != 'General':
            lines.append(f'- **Producto:** `{prod}`')
        if action and action != 'General':
            lines.append(f'- **Tipo de acción:** `{action}`')
        if mitre:
            technique_str = f' — {tech_name}' if tech_name else ''
            lines.append(f'- **Técnica MITRE:** `{mitre}`{technique_str}')
        if source_type:
            lines.append(f'- **Tipo de fuente:** _{source_type.replace("_", " ").title()}_')

        # Confidence score with emoji indicator
        conf_emoji = '🟢' if score >= 0.7 else '🟡' if score >= 0.4 else '🔴'
        lines.append(f'- **Confianza:** {conf_emoji} {score:.0%}')
        lines.append('')

        # Content snippet
        lines.append('**📖 Contenido:**')
        lines.append('')
        snippet = chunk.content[:500]
        if len(chunk.content) > 500:
            snippet += ' …'
        lines.append(snippet)

        # Source link
        if url:
            lines.append('')
            lines.append(f'**🔗 Fuente:** [{url.replace("https://", "").replace("http://", "")}]({url})')

        lines.append('')
        lines.append('---')
        lines.append('')

    return '\n'.join(lines)
