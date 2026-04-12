# Vendors AI Master — Sistemas RAG

Documentación técnica de los dos pipelines RAG del proyecto y cómo se integran con el agente MITRE.

---

## Índice

1. [Visión general](#1-visión-general)
2. [RAG 1 — MITRE ATT&CK (Node.js)](#2-rag-1--mitre-attck-nodejs)
3. [RAG 2 — Palo Alto Networks (Python)](#3-rag-2--palo-alto-networks-python)
4. [Integración con el agente MITRE](#4-integración-con-el-agente-mitre)
5. [Variables de entorno](#5-variables-de-entorno)
6. [Comandos de referencia](#6-comandos-de-referencia)
7. [Troubleshooting](#7-troubleshooting)

---

## 1. Visión general

El proyecto dispone de dos RAGs independientes que el agente `MitreCoverageAgent` puede consultar durante el análisis de un vendor:

| | RAG 1 — MITRE ATT&CK | RAG 2 — Palo Alto Networks |
|---|---|---|
| **Runtime** | Node.js / TypeScript | Python / FastAPI |
| **Herramienta del agente** | `query_mitre_attack` | `query_paloalto_rag` |
| **Almacén vectorial** | SQLite BLOB (`data/mitre-chat.db`) | ChromaDB (`data/paloalto-rag/`) |
| **Embeddings** | LM Studio `/v1/embeddings` via SDK OpenAI | LM Studio `/v1/embeddings` via HTTP directo |
| **Contenido** | Framework MITRE ATT&CK Enterprise completo (1 700+ entradas) | Documentación oficial Palo Alto: TechDocs, Unit 42, Cortex XDR, MITRE Evaluations |
| **Puerto** | — (en proceso del servidor Node.js) | `8765` (proceso Python separado) |
| **Activación automática** | Siempre disponible | Siempre disponible; pre-inyección extra cuando el vendor es Palo Alto Networks |

Ambos RAGs comparten el mismo modelo de embeddings configurado en `.env` (`EMBEDDING_MODEL`).

---

## 2. RAG 1 — MITRE ATT&CK (Node.js)

### 2.1 Propósito

Proporciona al agente contexto verificado sobre tácticas, técnicas, procedimientos, grupos de amenaza, software malicioso y mitigaciones del framework MITRE ATT&CK Enterprise, directo desde el bundle STIX oficial.

### 2.2 Arquitectura

```
npm run mitre:ingest
    │
    ├─ Descarga bundle STIX 2.1 (~15 MB) desde github.com/mitre/cti
    ├─ Parsea entradas no revocadas ni deprecadas
    ├─ Persiste en SQLite: mitre_entries + mitre_embeddings (vectores BLOB)
    └─ Carga índice en memoria para búsqueda instantánea

En runtime (agente):
    query_mitre_attack("consulta")
        │
        ├─ EmbeddingClient.embed() → LM Studio /v1/embeddings
        ├─ MitreVectorStore.search() → similitud coseno en JS puro
        └─ formatContext() → bloque Markdown con IDs, tácticas, URLs ATT&CK
```

### 2.3 Archivos clave

| Archivo | Función |
|---------|---------|
| `src/mitre/ingest.ts` | Descarga y parseo del bundle STIX |
| `src/mitre/embeddings.ts` | `EmbeddingClient` — llama a `/v1/embeddings` con `encoding_format: 'float'` |
| `src/mitre/vector-store.ts` | Almacén SQLite BLOB + similitud coseno en memoria |
| `src/mitre/rag.ts` | Clase `MitreRag` — init lazy, pipeline completo |
| `src/agent/tools/mitre.ts` | `MITRE_TOOL_DEFINITION` + `MitreRagTool` runner |

### 2.4 Esquema SQLite

```
mitre_entries       — metadatos de cada entrada ATT&CK
mitre_embeddings    — vectores BLOB (float32 LE) vinculados por foreign key
```

### 2.5 Puesta en marcha

```bash
# Primera vez (o tras cambiar el modelo de embeddings)
npm run mitre:reset
npm run mitre:ingest

# Verificar salud del índice
npm run mitre:diagnose -- --query "ransomware encryption techniques"

# Detectar qué modelos de LM Studio producen embeddings válidos
npm run mitre:probe
```

---

## 3. RAG 2 — Palo Alto Networks (Python)

### 3.1 Propósito

Base de conocimiento especializada en la cobertura MITRE ATT&CK de los productos de Palo Alto Networks. Responde preguntas sobre:

- **Cortex XDR** — detecciones BIOC, alertas comportamentales, respuesta a incidentes.
- **Prisma Cloud / Prisma Access** — prevención en cloud y SASE.
- **Strata (NGFW / Panorama)** — bloqueo y perfiles de seguridad.
- **Unit 42** — inteligencia de amenazas: actores, campañas, TTPs documentados.
- **MITRE ATT&CK Evaluations** — resultados oficiales de Palo Alto en evaluaciones independientes.

A diferencia del RAG 1 (framework genérico), este RAG responde con evidencia de producto específica, incluyendo **Confidence Score** y **Source Attribution** por fragmento recuperado.

### 3.2 Arquitectura

```
npm run paloalto:ingest
    │
    ├─ Scraping de URLs semilla (TechDocs, Unit 42, Cortex XDR, Evaluations)
    ├─ Clasificación automática: product_line, action_type, source_type
    ├─ Extracción de IDs MITRE (T1059, T1566.001, etc.) del texto
    ├─ Chunking: RecursiveCharacterTextSplitter (800 chars / 150 overlap)
    └─ Embeddings → ChromaDB (data/paloalto-rag/)

En runtime (agente vía HTTP):
    query_paloalto_rag("consulta")
        │
        ├─ Self-Querying: extrae filtros de la consulta sin LLM
        │     mitre_id, product_line, action_type
        ├─ Chroma similarity_search (filtrado → fallback sin filtro)
        ├─ Confidence Score = media de similitud coseno top-k
        └─ Respuesta estructurada: answer + confidence + source attribution
```

### 3.3 Self-Querying Retriever

El módulo `retrieval.py` implementa un "Self-Querying" ligero basado en keywords, sin necesidad de que el LLM genere JSON estructurado. Esto lo hace fiable con cualquier modelo local pequeño.

Ejemplos de extracción automática de filtros:

| Consulta | Filtros extraídos |
|----------|------------------|
| `"Cortex XDR detection for T1059"` | `product_line=Cortex, action_type=Detection, mitre_id=T1059` |
| `"Prisma Access lateral movement prevention"` | `product_line=Prisma, action_type=Prevention` |
| `"Unit 42 ransomware T1486"` | `product_line=Unit42, action_type=Intelligence, mitre_id=T1486` |
| `"NGFW firewall block T1190"` | `product_line=Strata, action_type=Prevention, mitre_id=T1190` |

Si la búsqueda filtrada devuelve menos de 2 resultados, el sistema hace fallback automático a búsqueda semántica sin filtros.

### 3.4 Metadata schema

Cada fragmento almacenado en ChromaDB lleva estos campos:

| Campo | Valores posibles | Descripción |
|-------|-----------------|-------------|
| `mitre_id` | `T1059`, `T1566.001`, … | Técnica ATT&CK primaria detectada en el texto |
| `technique_name` | Nombre libre | Nombre de la técnica |
| `product_line` | `Strata` \| `Prisma` \| `Cortex` \| `Unit42` \| `General` | Línea de producto |
| `action_type` | `Prevention` \| `Detection` \| `Investigation` \| `Intelligence` \| `General` | Tipo de cobertura |
| `source_url` | URL o ruta | Origen del documento |
| `source_type` | `techdocs` \| `unit42` \| `cortex_xdr` \| `mitre_evaluations` \| `manual` | Clasificación de la fuente |
| `doc_title` | Texto libre | Título de la página |
| `chunk_index` | Entero | Posición del fragmento dentro del documento |

### 3.5 Archivos del servicio Python

```
src/paloalto-rag/
├── config.py         Configuración: lee .env del proyecto, rutas Chroma, parámetros de chunking
├── models.py         Modelos Pydantic: IngestRequest, QueryRequest, QueryResponse, StatsResponse
├── embeddings.py     LMStudioEmbeddings — HTTP directo con encoding_format='float'
├── ingestion.py      Loaders: scrape_url, load_pdf, load_html_file, load_json_file
├── chunking.py       RecursiveCharacterTextSplitter 800/150 + normalización de metadata
├── vector_store.py   ChromaDB singleton con deduplicación (source_url, chunk_index)
├── retrieval.py      Self-Querying + similarity search + formato de respuesta
├── main.py           FastAPI en puerto 8765: /health /stats /query /ingest /reset
├── ingest_cli.py     CLI standalone de ingesta (no requiere servicio arrancado)
└── requirements.txt  Dependencias Python
```

### 3.6 API del servicio

El servicio expone los siguientes endpoints en `http://localhost:8765`:

| Método | Ruta | Descripción |
|--------|------|-------------|
| `GET` | `/health` | Liveness + conteo de chunks |
| `GET` | `/stats` | Breakdown por product_line, action_type, source_type |
| `POST` | `/query` | Búsqueda semántica con self-querying |
| `POST` | `/ingest` | Ingesta de URLs, ficheros locales o texto |
| `DELETE` | `/reset` | Vacía completamente el almacén vectorial |

El servidor Node.js hace de proxy en `/api/paloalto-rag/*` para que el frontend pueda llamar a todos los endpoints sin CORS.

### 3.7 Fuentes semilla por defecto

Configuradas en `config.py → DEFAULT_SEED_URLS`:

- `https://docs.paloaltonetworks.com/cortex/cortex-xdr/cortex-xdr-pro-admin/external-integrations/mitre-attack-integration`
- `https://www.paloaltonetworks.com/cortex/mitre-attack-evaluations`
- `https://unit42.paloaltonetworks.com/`
- `https://docs.paloaltonetworks.com/cortex/cortex-xdr`
- `https://docs.paloaltonetworks.com/prisma/prisma-cloud`
- `https://docs.paloaltonetworks.com/pan-os`
- `https://www.paloaltonetworks.com/cyberpedia/what-is-mitre-attack`

Se pueden añadir URLs adicionales desde la UI (página **Palo Alto RAG**) o pasando `--url <url>` al CLI.

### 3.8 Puesta en marcha

```bash
# 1. Instalar dependencias Python (una sola vez)
npm run paloalto:install
# Equivale a: python -m pip install -r src/paloalto-rag/requirements.txt

# 2. Arrancar el servicio FastAPI (terminal dedicada)
npm run paloalto:start
# Equivale a: python src/paloalto-rag/main.py
# Servicio disponible en http://localhost:8765

# 3. Ingestar fuentes por defecto (no requiere servicio arrancado)
npm run paloalto:ingest
# Equivale a: python src/paloalto-rag/ingest_cli.py

# Opciones adicionales del CLI de ingesta:
python src/paloalto-rag/ingest_cli.py --url https://unit42.paloaltonetworks.com/cobalt-strike/
python src/paloalto-rag/ingest_cli.py --reset        # vacía antes de ingestar
python src/paloalto-rag/ingest_cli.py --no-defaults  # solo URLs personalizadas

# 4. Vaciar el almacén vectorial
npm run paloalto:reset
```

### 3.9 Gestión desde la UI

La página **Palo Alto RAG** (barra lateral del servidor) permite:

- Ver estado del servicio y conteo de chunks.
- Ingestar fuentes por defecto con un clic.
- Añadir/eliminar URLs personalizadas antes de ingestar.
- Ver estadísticas desglosadas por producto, tipo de acción y fuente.
- Ejecutar consultas de prueba con filtros opcionales de producto y acción.
- Vaciar el almacén vectorial.

---

## 4. Integración con el agente MITRE

El agente `MitreCoverageAgent` (`src/agent/mitre-coverage-agent.ts`) tiene acceso a cuatro herramientas:

| Prioridad | Herramienta | Cuándo la usa el agente |
|-----------|-------------|------------------------|
| 1 | `query_mitre_attack` | Siempre — primer tool call forzado en iteración 1 |
| 2 | `query_paloalto_rag` | Cuando necesita evidencia de producto específica de Palo Alto |
| 3 | `search_web` | Para buscar documentación actualizada en la web |
| 4 | `scrape_url` | Para leer en profundidad una página concreta |

### 4.1 Pre-inyección de contexto

Antes de entrar en el bucle ReAct, el agente pre-inyecta contexto de ambos RAGs en el primer mensaje de usuario:

```
Step 0a — MITRE ATT&CK RAG
    query: "<vendor> security techniques detection endpoint network identity"
    top_k: 8
    → ragPreamble += "## Pre-loaded MITRE ATT&CK Context\n..."

Step 0b — Palo Alto RAG (solo si isPaloAlto(vendor) === true)
    query: "Palo Alto Networks Cortex XDR Prisma Strata MITRE ATT&CK detection prevention coverage"
    top_k: 6
    → ragPreamble += "## Pre-loaded Palo Alto Networks Documentation\n..."
```

Esto garantiza que el modelo tenga contexto relevante incluso si nunca llama explícitamente a las herramientas (habitual en modelos pequeños).

### 4.2 Detección de Palo Alto Networks

La función `isPaloAlto(vendorName)` detecta automáticamente variantes del nombre:

```typescript
// Activa la pre-inyección PA y prioriza query_paloalto_rag
isPaloAlto("Palo Alto Networks") // true
isPaloAlto("paloalto")           // true
isPaloAlto("PANW")               // true
isPaloAlto("PAN")                // true
```

### 4.3 Respuesta de `query_paloalto_rag`

La herramienta devuelve al LLM un bloque estructurado:

```
## Palo Alto Networks — MITRE ATT&CK Coverage
**Query:** Cortex XDR detection T1059

**[1]** Cortex XDR — MITRE ATT&CK Integration | `Cortex` | `Detection` | `T1059` | *(confidence: 78%)*
Cortex XDR maps its BIOC rules directly to MITRE ATT&CK technique IDs...
*Source: https://docs.paloaltonetworks.com/cortex/cortex-xdr/...*

---
**Confidence Score:** 74.3%
**Applied Filter:** product_line=Cortex, action_type=Detection, mitre_id=T1059

**Source Attribution:**
- Cortex XDR MITRE ATT&CK Integration  <https://docs.paloaltonetworks.com/...>
- Unit 42 Threat Intelligence           <https://unit42.paloaltonetworks.com/...>
```

---

## 5. Variables de entorno

Todas las variables se configuran en el fichero `.env` de la raíz del proyecto.

### Variables compartidas por ambos RAGs

```env
# Modelo de embeddings cargado en LM Studio
# Debe ser el mismo modelo usado durante la ingesta y la consulta
# ID completo tal como aparece en GET /v1/models de LM Studio
EMBEDDING_MODEL=text-embedding-nomic-embed-text-v1.5

# Endpoint de LM Studio
LM_STUDIO_URL=http://localhost:1234/v1
LM_STUDIO_API_KEY=lm-studio
```

> **Importante:** si cambias `EMBEDDING_MODEL` después de haber ingestado, debes regenerar los embeddings en ambos RAGs:
> ```bash
> npm run mitre:reset && npm run mitre:ingest
> npm run paloalto:reset && npm run paloalto:ingest
> ```

### Variables exclusivas del RAG MITRE (RAG 1)

```env
# Número de entradas a recuperar por consulta (máx. 10)
MITRE_TOP_K=5

# Similitud coseno mínima para incluir una entrada (0.0–1.0)
MITRE_SIMILARITY_THRESHOLD=0.25

# Máximo de caracteres de contexto MITRE por llamada al agente
MITRE_MAX_CONTEXT_CHARS=4000
```

### Variables exclusivas del RAG Palo Alto (RAG 2)

```env
# Puerto del servicio FastAPI (default 8765)
PALOALTO_RAG_PORT=8765

# URL del servicio — usada por el servidor Node.js para proxy y por el agente
PALOALTO_RAG_URL=http://localhost:8765
```

---

## 6. Comandos de referencia

### RAG 1 — MITRE ATT&CK

```bash
npm run mitre:ingest                                    # Ingestar bundle STIX completo
npm run mitre:reset                                     # Borrar índice y embeddings
npm run mitre:query                                     # REPL interactivo
npm run mitre:query -- --query "lateral movement" --top-k 5
npm run mitre:diagnose -- --query "ransomware encryption"
npm run mitre:probe                                     # Detectar modelos de embeddings válidos
npm run mitre:probe -- --all
```

### RAG 2 — Palo Alto Networks

```bash
npm run paloalto:install                                # Instalar dependencias Python
npm run paloalto:start                                  # Arrancar servicio FastAPI (puerto 8765)
npm run paloalto:ingest                                 # Ingestar fuentes semilla por defecto
npm run paloalto:reset                                  # Vaciar almacén vectorial

# CLI de ingesta con opciones
python src/paloalto-rag/ingest_cli.py
python src/paloalto-rag/ingest_cli.py --url https://unit42.paloaltonetworks.com/apt29/
python src/paloalto-rag/ingest_cli.py --reset --no-defaults
```

### Secuencia de primer arranque completa

```bash
# 1. Dependencias Node.js
npm install

# 2. Dependencias Python
npm run paloalto:install

# 3. Iniciar LM Studio con un modelo de texto y un modelo de embeddings cargados

# 4. Ingestar MITRE ATT&CK
npm run mitre:ingest

# 5. Ingestar documentación Palo Alto (terminal 1)
npm run paloalto:ingest

# 6. Arrancar servicio Python (terminal 2, dejar corriendo)
npm run paloalto:start

# 7. Arrancar servidor Node.js (terminal 3)
npm run server
```

---

## 7. Troubleshooting

### RAG 1 — MITRE ATT&CK

#### Scores siempre 0% o muy bajos

```bash
npm run mitre:probe   # comprueba qué modelos devuelven vectores válidos
```

Causas comunes:
- **Mismatch de modelo:** el modelo usado en `mitre:ingest` ya no está cargado en LM Studio. Solución: regenerar con el modelo correcto.
- **Vector cero:** LM Studio devuelve embeddings nulos. Solución: cargar un modelo de embeddings dedicado (nomic-embed-text-v1.5 recomendado).

```bash
npm run mitre:reset
npm run mitre:ingest
npm run mitre:diagnose -- --query "ransomware encryption techniques"
```

#### `buf.readFloatLE is not a function`

`node:sqlite` devuelve columnas BLOB como `Uint8Array`. Corregido en `src/mitre/vector-store.ts` con `DataView`.

---

### RAG 2 — Palo Alto Networks

#### `npm run paloalto:start` falla con ModuleNotFoundError

```bash
npm run paloalto:install
# Asegura que python apunta a Python 3.9+
python --version
```

#### El servicio arranca pero `/health` devuelve `status: degraded`

Causa: LM Studio no responde al generar embeddings en la primera consulta.

1. Verifica que LM Studio está corriendo y el modelo de embeddings está cargado.
2. Comprueba que `EMBEDDING_MODEL` en `.env` coincide exactamente con el ID del modelo en `GET http://localhost:1234/v1/models`.

#### Confidence Score siempre 0%

El almacén vectorial está vacío o el modelo de embeddings cambió tras la ingesta.

```bash
npm run paloalto:reset
npm run paloalto:ingest
```

#### Scraping devuelve 0 chunks de una URL

- La URL puede requerir autenticación o JavaScript para renderizarse.
- Revisa los logs del CLI: `python src/paloalto-rag/ingest_cli.py --url <url>`
- Alternativa: descarga el HTML manualmente y úsalo como fichero local:

```bash
python src/paloalto-rag/ingest_cli.py  # añade --url con la ruta local del .html
```

#### El servidor Node.js devuelve 503 en `/api/paloalto-rag/*`

El servicio Python no está corriendo. Inicia en una terminal separada:

```bash
npm run paloalto:start
```

#### Cambio de modelo de embeddings

Si cambias `EMBEDDING_MODEL`, los vectores almacenados son incompatibles con las nuevas consultas. Regenera ambos RAGs:

```bash
npm run mitre:reset && npm run mitre:ingest
npm run paloalto:reset && npm run paloalto:ingest
```
