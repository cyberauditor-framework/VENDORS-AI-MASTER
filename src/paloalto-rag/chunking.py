"""
Context-aware chunking with RecursiveCharacterTextSplitter.

Spec: chunk_size=800, chunk_overlap=150.

Every chunk produced here carries the full rich metadata from its parent
Document with `chunk_index` updated to reflect position within that parent.
Chroma rejects None values so we normalise all metadata values to strings/ints/floats/bools.
"""

from __future__ import annotations
from typing import List
from langchain_core.documents import Document
from langchain_text_splitters import RecursiveCharacterTextSplitter
from config import CHUNK_SIZE, CHUNK_OVERLAP

# Shared splitter instance
_splitter = RecursiveCharacterTextSplitter(
    chunk_size=CHUNK_SIZE,
    chunk_overlap=CHUNK_OVERLAP,
    separators=['\n\n', '\n', '. ', ' ', ''],
    length_function=len,
    is_separator_regex=False,
    keep_separator=False,
)

# Required metadata keys with safe defaults
_META_DEFAULTS: dict = {
    'mitre_id':        '',
    'technique_name':  '',
    'product_line':    'General',
    'action_type':     'General',
    'source_url':      '',
    'source_type':     'manual',
    'doc_title':       '',
    'chunk_index':     0,
}


def _normalise_meta(meta: dict) -> dict:
    """
    Ensure every metadata value is a type Chroma accepts:
    str | int | float | bool.  None → ''.  Other types → str().
    """
    out = dict(_META_DEFAULTS)   # start from defaults
    out.update(meta)             # apply actual values
    return {
        k: (
            v if isinstance(v, (str, int, float, bool))
            else ('' if v is None else str(v))
        )
        for k, v in out.items()
    }


def chunk_documents(docs: List[Document]) -> List[Document]:
    """
    Split each Document into chunks and return a flat list.

    Each chunk receives the parent's metadata with `chunk_index` set to its
    position within that parent document (0-based).
    """
    all_chunks: List[Document] = []

    for doc in docs:
        splits = _splitter.split_documents([doc])
        for i, chunk in enumerate(splits):
            chunk.metadata['chunk_index'] = i
            chunk.metadata = _normalise_meta(chunk.metadata)
            all_chunks.append(chunk)

    return all_chunks
