"""
Standalone ingestion CLI — runs directly without the FastAPI service.

Usage
─────
  python src/paloalto-rag/ingest_cli.py                  # default seed URLs
  python src/paloalto-rag/ingest_cli.py --url <url> ...  # custom URLs
  python src/paloalto-rag/ingest_cli.py --reset          # wipe then ingest defaults
"""

from __future__ import annotations
import argparse
import sys
import os

# Ensure imports resolve from this file's directory
sys.path.insert(0, os.path.dirname(__file__))

from config import DEFAULT_SEED_URLS
from ingestion import scrape_url
from chunking import chunk_documents
from vector_store import add_documents, get_stats, reset_store


def main() -> None:
    parser = argparse.ArgumentParser(description='Palo Alto Networks MITRE RAG — ingest documents')
    parser.add_argument('--url', metavar='URL', action='append', dest='urls',
                        help='Extra URL to ingest (repeatable)')
    parser.add_argument('--no-defaults', action='store_true',
                        help='Skip the built-in seed URLs')
    parser.add_argument('--reset', action='store_true',
                        help='Wipe the vector store before ingesting')
    args = parser.parse_args()

    if args.reset:
        deleted = reset_store()
        print(f'[reset] Deleted {deleted} chunks.')

    urls: list[str] = []
    if not args.no_defaults:
        urls.extend(DEFAULT_SEED_URLS)
    if args.urls:
        urls.extend(args.urls)
    # Deduplicate while preserving order
    urls = list(dict.fromkeys(urls))

    if not urls:
        print('[ingest] No URLs to process. Pass --url or remove --no-defaults.')
        return

    total_added   = 0
    total_skipped = 0
    errors: list[str] = []

    for i, url in enumerate(urls, 1):
        print(f'[{i}/{len(urls)}] {url}')
        try:
            raw = scrape_url(url)
            if not raw:
                print(f'  ⚠  No content scraped')
                errors.append(f'No content: {url}')
                total_skipped += 1
                continue
            chunks = chunk_documents(raw)
            added, skipped = add_documents(chunks)
            total_added   += added
            total_skipped += skipped
            print(f'  ✓  {added} chunks added, {skipped} already present')
        except Exception as exc:
            print(f'  ✗  Error: {exc}')
            errors.append(f'{url}: {exc}')
            total_skipped += 1

    print()
    stats = get_stats()
    print(f'Done. Added: {total_added}  |  Skipped/dup: {total_skipped}  |  Errors: {len(errors)}')
    print(f'Total chunks in store: {stats["total_chunks"]}  |  Unique sources: {stats["unique_sources"]}')

    if errors:
        print('\nErrors:')
        for e in errors:
            print(f'  - {e}')


if __name__ == '__main__':
    main()
