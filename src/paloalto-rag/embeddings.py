"""
Custom LangChain-compatible embeddings class backed by LM Studio.

Key difference from the default langchain-openai embeddings:
  • Forces `encoding_format: 'float'` on every request.
    The OpenAI SDK v4 requests base64 by default; LM Studio's decoder returns
    zero vectors for some models.  Requesting 'float' returns a plain JSON array
    of floats which always decodes correctly.
  • Uses raw requests instead of the OpenAI SDK so we can control the payload.
"""

from __future__ import annotations
from typing import List
import math
import requests
from langchain_core.embeddings import Embeddings


class LMStudioEmbeddings(Embeddings):
    """
    Drop-in LangChain Embeddings that call LM Studio's /v1/embeddings endpoint
    with `encoding_format: 'float'` to avoid the base64 zero-vector bug.
    """

    def __init__(self, base_url: str, api_key: str, model: str) -> None:
        self.base_url = base_url.rstrip('/')
        self.api_key  = api_key
        self.model    = model

    # ── Internal ─────────────────────────────────────────────────────────────

    def _embed_batch(self, texts: List[str]) -> List[List[float]]:
        resp = requests.post(
            f'{self.base_url}/embeddings',
            headers={
                'Authorization': f'Bearer {self.api_key}',
                'Content-Type':  'application/json',
            },
            json={
                'model':           self.model,
                'input':           texts,
                'encoding_format': 'float',   # prevents base64 zero-vector issue
            },
            timeout=120,
        )
        resp.raise_for_status()
        data = resp.json()['data']
        # Sort by index in case the API returns them out of order
        data.sort(key=lambda x: x['index'])
        vectors = [d['embedding'] for d in data]
        # Validate — raise early rather than store zero vectors silently
        for i, vec in enumerate(vectors):
            norm = math.sqrt(sum(v * v for v in vec))
            if norm <= 1e-9:
                raise ValueError(
                    f'LM Studio returned a zero vector for text[{i}] '
                    f'(model="{self.model}"). '
                    'Try a different embedding model or check that it is loaded in LM Studio.'
                )
        return vectors

    # ── LangChain Embeddings interface ───────────────────────────────────────

    def embed_documents(self, texts: List[str]) -> List[List[float]]:
        """Embed a list of documents (called during ingestion)."""
        # LM Studio has no hard batch limit but chunking to 32 keeps memory bounded.
        results: List[List[float]] = []
        batch_size = 32
        for start in range(0, len(texts), batch_size):
            results.extend(self._embed_batch(texts[start:start + batch_size]))
        return results

    def embed_query(self, text: str) -> List[float]:
        """Embed a single query string (called during retrieval)."""
        return self._embed_batch([text])[0]

    # ── Utility ───────────────────────────────────────────────────────────────

    def ping(self) -> bool:
        """Return True if the embedding model is responsive and returns non-zero vectors."""
        try:
            self._embed_batch(['connectivity test'])
            return True
        except Exception:
            return False
