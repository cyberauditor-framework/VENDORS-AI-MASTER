"""
ChromaDB-backed vector store using LM Studio embeddings.

Singleton pattern: the Chroma instance is created once on first access and
reused.  Call `reset_store()` to wipe the collection and force re-init.

De-duplication: before adding documents we check whether (source_url, chunk_index)
already exists so re-running ingestion is idempotent.
"""

from __future__ import annotations
from typing import List, Optional, Tuple, Dict
from langchain_core.documents import Document
from langchain_chroma import Chroma

from embeddings import LMStudioEmbeddings
from config import (
    CHROMA_DIR, CHROMA_COLLECTION,
    LM_STUDIO_URL, LM_STUDIO_API_KEY, EMBEDDING_MODEL,
)

# Module-level singletons
_embed_fn: Optional[LMStudioEmbeddings] = None
_store:    Optional[Chroma]             = None


def get_embeddings() -> LMStudioEmbeddings:
    global _embed_fn
    if _embed_fn is None:
        _embed_fn = LMStudioEmbeddings(LM_STUDIO_URL, LM_STUDIO_API_KEY, EMBEDDING_MODEL)
    return _embed_fn


def get_store() -> Chroma:
    global _store
    if _store is None:
        CHROMA_DIR.mkdir(parents=True, exist_ok=True)
        _store = Chroma(
            collection_name=CHROMA_COLLECTION,
            embedding_function=get_embeddings(),
            persist_directory=str(CHROMA_DIR),
        )
    return _store


# ── Write operations ──────────────────────────────────────────────────────────

def add_documents(docs: List[Document]) -> Tuple[int, int]:
    """
    Add documents to the vector store, skipping duplicates.

    Returns (added, skipped) counts.
    """
    if not docs:
        return 0, 0

    store = get_store()

    # Fetch existing (source_url, chunk_index) pairs for de-duplication
    existing_data = store.get(include=['metadatas'])
    existing_keys: set[str] = set()
    for m in (existing_data.get('metadatas') or []):
        if m:
            key = f"{m.get('source_url', '')}::{m.get('chunk_index', '')}"
            existing_keys.add(key)

    new_docs = []
    skipped  = 0
    for doc in docs:
        key = f"{doc.metadata.get('source_url', '')}::{doc.metadata.get('chunk_index', '')}"
        if key in existing_keys:
            skipped += 1
        else:
            new_docs.append(doc)

    if new_docs:
        store.add_documents(new_docs)

    return len(new_docs), skipped


# ── Read operations ───────────────────────────────────────────────────────────

def similarity_search_with_scores(
    query: str,
    k: int = 5,
    filter_dict: Optional[Dict] = None,
) -> List[Tuple[Document, float]]:
    """
    Return up to k (Document, relevance_score) pairs.
    Relevance score is in [0, 1] where 1.0 = most similar.
    """
    store = get_store()
    kwargs: dict = {'k': k}
    if filter_dict:
        kwargs['filter'] = filter_dict
    return store.similarity_search_with_relevance_scores(query, **kwargs)


def get_stats() -> Dict:
    """Aggregate metadata statistics across the whole collection."""
    store   = get_store()
    result  = store.get(include=['metadatas'])
    metas   = result.get('metadatas') or []
    total   = len(metas)

    by_product: Dict[str, int] = {}
    by_action:  Dict[str, int] = {}
    by_source:  Dict[str, int] = {}
    urls:       set[str]       = set()

    for m in metas:
        if not m:
            continue
        p = m.get('product_line', 'General')
        a = m.get('action_type',  'General')
        s = m.get('source_type',  'manual')
        u = m.get('source_url',   '')
        by_product[p] = by_product.get(p, 0) + 1
        by_action[a]  = by_action.get(a,  0) + 1
        by_source[s]  = by_source.get(s,  0) + 1
        if u:
            urls.add(u)

    return {
        'total_chunks':   total,
        'by_product':     by_product,
        'by_action':      by_action,
        'by_source':      by_source,
        'unique_sources': len(urls),
    }


# ── Reset ─────────────────────────────────────────────────────────────────────

def reset_store() -> int:
    """Delete all documents from the collection. Returns deleted count."""
    global _store
    store   = get_store()
    result  = store.get()
    ids     = result.get('ids') or []
    count   = len(ids)
    if ids:
        store.delete(ids=ids)
    _store = None   # force fresh init on next access
    return count
