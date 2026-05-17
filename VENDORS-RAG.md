# Vendors AI Master - Sistema RAG Actual

Este repositorio usa un unico RAG activo: MITRE ATT&CK local en Node.js/TypeScript.

## 1. Estado actual

- RAG activo: MITRE ATT&CK local.
- Fuente de datos: bundle STIX Enterprise oficial de MITRE.
- Almacenamiento: SQLite (`mitre_entries` y `mitre_embeddings`).
- Integracion en agentes: herramienta `query_mitre_attack`.

## 2. Arquitectura

```text
npm run mitre:ingest
  -> descarga STIX
  -> parsea entradas validas
  -> genera embeddings en LM Studio
  -> guarda en SQLite

Consulta runtime
  -> query_mitre_attack(...)
  -> busqueda semantica en indice local
  -> contexto formateado para el LLM
```

## 3. Archivos clave

- src/mitre/ingest.ts: descarga y parseo STIX.
- src/mitre/embeddings.ts: cliente de embeddings para LM Studio.
- src/mitre/vector-store.ts: persistencia SQLite y busqueda semantica.
- src/mitre/rag.ts: inicializacion y consultas del RAG.
- src/agent/tools/mitre.ts: definicion y ejecucion de `query_mitre_attack`.

## 4. Variables de entorno

```env
LM_STUDIO_URL=http://localhost:1234/v1
LM_STUDIO_API_KEY=lm-studio
EMBEDDING_MODEL=text-embedding-nomic-embed-text-v1.5
MITRE_TOP_K=5
MITRE_SIMILARITY_THRESHOLD=0.25
MITRE_MAX_CONTEXT_CHARS=4000
```

## 5. Comandos

```bash
npm run mitre:reset
npm run mitre:ingest
npm run mitre:query
npm run mitre:diagnose
npm run mitre:probe
```

## 6. Troubleshooting rapido

- Si los resultados son pobres o vacios:
  - `npm run mitre:probe`
  - `npm run mitre:reset`
  - `npm run mitre:ingest`
- Si hay mismatch de modelo entre embeddings guardados y `.env`:
  - `npm run mitre:reset && npm run mitre:ingest`

## 7. Nota de limpieza

La funcionalidad de conectores RAG por fabricante y sus ajustes de UI/API fue retirada del proyecto. Este documento refleja el estado actual para evitar configuraciones obsoletas.
