# Vendors AI Master

Plataforma de analisis automatizado de vendors de ciberseguridad e IA con agente ReAct, busqueda web, scraping, persistencia en SQLite y exportacion de resultados en Markdown/JSON/HTML.

Este proyecto permite:
- Analizar vendors por categoria o vendor individual usando un LLM local en LM Studio.
- Guardar resultados estructurados y trazables en base de datos.
- Consultar resultados desde CLI y API REST.
- Generar reportes comparativos y dashboards visuales.

## 1. Caracteristicas principales

- Agente ReAct con herramientas reales de web search y web scraping.
- Integracion con LM Studio via API compatible OpenAI.
- Persistencia local con `node:sqlite` (sin dependencias nativas externas).
- Ranking ponderado por criterios de mercado, producto y seguridad.
- Exportacion a:
  - Markdown (reporte ejecutivo y fichas por vendor)
  - JSON (datos estructurados)
  - HTML (dashboard con Chart.js)
- Servidor Express con endpoints para UI y automatizacion.
- Seguimiento de analisis en tiempo real via SSE.

## 2. Arquitectura del proyecto

Estructura principal:

- `src/agent`: nucleo del agente y cliente LLM.
- `src/agent/tools`: herramientas que el LLM puede invocar (`search_web`, `scrape_url`).
- `src/analysis`: logica de ranking, comparacion y estadisticas.
- `src/cli`: comandos CLI e interfaz interactiva.
- `src/config`: carga de entorno y configuracion central.
- `src/data`: catalogo inicial de categorias y vendors semilla.
- `src/database`: conexion SQLite, migraciones y repositorio.
- `src/export`: generadores de reportes y graficos.
- `src/server`: API REST + SSE + hosting de `public/index.html`.
- `public`: frontend estatico.
- `data`: base de datos SQLite.
- `reports`: salidas exportadas.

## 3. Requisitos

- Node.js 22.5+ (recomendado 22 LTS o superior).
- npm 10+.
- LM Studio ejecutandose en local con un modelo cargado.

Notas importantes:
- El proyecto usa `node --experimental-sqlite` en scripts de npm.
- Si LM Studio no esta disponible, el analisis se aborta con comprobacion previa.

## 4. Instalacion

```bash
npm install
```

## 5. Configuracion (.env)

1. Copia `.env.example` a `.env`.
2. Ajusta los valores segun tu entorno.

Variables:

- `LM_STUDIO_URL`: endpoint OpenAI-compatible de LM Studio. Default: `http://localhost:1234/v1`
- `LM_STUDIO_API_KEY`: clave API (LM Studio acepta `lm-studio` por defecto).
- `LM_STUDIO_MODEL`: modelo cargado en LM Studio.
- `AGENT_TEMPERATURE`: temperatura del modelo.
- `AGENT_MAX_TOKENS`: maximo de tokens por respuesta.
- `AGENT_MAX_REACT_ITERATIONS`: iteraciones maximas del bucle ReAct.
- `AGENT_MAX_SEARCH_RESULTS`: resultados maximos por llamada de busqueda.
- `SEARCH_RATE_LIMIT_MS`: espera entre busquedas para evitar rate-limit.
- `SEARCH_REQUEST_TIMEOUT_MS`: timeout de busqueda web.
- `WEB_SCRAPE_TIMEOUT_MS`: timeout de scraping.
- `DB_PATH`: ruta de la SQLite (default `./data/vendors.db`).
- `EXPORT_DIR`: carpeta de reportes (default `./reports`).

## 6. Ejecucion

### CLI principal

```bash
npm run dev
```

### Comandos CLI directos

- `npm run analyze`
- `npm run query`
- `npm run export`
- `npm run charts`
- `npm run interactive`

### Servidor API + UI

```bash
npm run server
```

Por defecto arranca en `http://localhost:3232`.

### Build para distribucion

```bash
npm run build
npm start
```

## 7. Referencia de comandos CLI

### `analyze`

Lanza analisis con el agente ReAct.

Opciones:
- `-c, --category <name>` categoria a analizar.
- `-v, --vendor <name>` vendor concreto.
- `-a, --all` analiza todas las categorias definidas.
- `-f, --force` reservado para re-analisis (flag disponible).
- `-m, --max <n>` maximo de vendors por categoria (default `5`).

Ejemplos:

```bash
npm run analyze -- --category SIEM --max 3
npm run analyze -- --vendor "Splunk" --category SIEM
npm run analyze -- --all --max 2
```

### `query`

Consulta vendors persistidos con filtros.

Opciones:
- `-c, --category <name>`
- `--min-score <n>`
- `--region <r>`
- `--mode <m>`
- `--position <p>`
- `--sort <field>`: `score|name|founded|category`
- `--asc`
- `-l, --limit <n>`
- `-i, --interactive`

Ejemplo:

```bash
npm run query -- --category SIEM --min-score 7 --sort score --limit 10
```

### `export`

Exporta los resultados acumulados.

Opciones:
- `-f, --format <fmt>`: `markdown|json|html`
- `-c, --category <name>`
- `-o, --output <path>`

Ejemplos:

```bash
npm run export -- --format markdown
npm run export -- --format json
npm run export -- --format html --output reports
```

### `charts`

Genera graficos en consola o dashboard HTML.

Opciones:
- `-c, --category <name>` o `all`
- `--html`
- `-o, --output <path>`

Ejemplo:

```bash
npm run charts -- --html
```

### `status`

Muestra estadisticas basicas de base de datos.

## 8. Flujo de analisis ReAct

1. Se crea contexto con prompt de sistema y tarea de usuario.
2. El LLM decide entre responder en texto o invocar herramientas.
3. Si invoca herramienta:
- `search_web(query)` busca fuentes.
- `scrape_url(url)` extrae contenido legible de paginas.
4. Los resultados de herramientas se inyectan de vuelta a la conversacion.
5. El agente itera hasta recibir JSON final estructurado.
6. Se parsea el JSON con defaults defensivos.
7. Se calcula score ponderado y se persiste en SQLite.
8. Se guardan tambien los registros de busqueda/scraping para trazabilidad.

## 9. Donde estan los prompts del LLM

Esta seccion responde directamente a donde debes editar los prompts para cambiar el comportamiento del modelo.

### 9.1 Prompt de sistema principal

Archivo:
- `src/agent/react-agent.ts`

Elemento:
- Constante `SYSTEM_PROMPT`.

Que contiene:
- Rol del analista.
- Reglas estrictas de evidencia y no-alucinacion.
- Rubrica de scoring 0-10.
- Esquema JSON de salida esperado.
- Reglas de fuentes, certificaciones, premios y racionales.

Impacto:
- Es el prompt mas importante. Define calidad, formato y rigor de todo el analisis.

### 9.2 Prompt de usuario inicial del analisis

Archivo:
- `src/agent/react-agent.ts`

Ubicacion logica:
- Dentro de `analyzeVendor(...)`, en el array `messages`, mensaje `role: 'user'` inicial.

Que contiene:
- Instruccion de investigar un vendor y categoria concretos.
- Orden explicita de usar `search_web` y `scrape_url`.
- Solicitud de salida JSON.

Impacto:
- Controla la tarea de cada corrida (vendor/categoria).

### 9.3 Prompts de refuerzo para forzar salida JSON

Archivo:
- `src/agent/react-agent.ts`

Ubicacion logica:
- En el bucle ReAct, cuando el modelo no devuelve JSON aun.

Prompts relevantes:
- "You have gathered enough information... output ONLY the JSON..."
- "Output the JSON now. No tools, no explanation..."

Impacto:
- Mejoran robustez cuando el modelo se desvía o responde en texto libre.

### 9.4 Definicion textual de herramientas (tool prompts)

Archivos:
- `src/agent/tools/search.ts`
- `src/agent/tools/scrape.ts`

Elementos:
- `SEARCH_TOOL_DEFINITION`
- `SCRAPE_TOOL_DEFINITION`

Que contienen:
- Nombre de funcion.
- Descripcion semantica para el modelo.
- Esquema de parametros JSON.

Impacto:
- Estos textos guian cuando y como el modelo decide llamar cada herramienta.

### 9.5 Cliente LLM y envio final de mensajes

Archivo:
- `src/agent/llm-client.ts`

Elemento clave:
- Metodo `chatWithTools(messages, tools?)`.

Que hace:
- Envia `messages` + `tools` al endpoint OpenAI-compatible.
- Devuelve `toolCalls` y `text`.
- Configura `tool_choice: 'auto'` cuando hay herramientas.

Impacto:
- No define prompts, pero es el punto de ejecucion donde todos los prompts se materializan en una llamada al modelo.

## 10. API REST

Base URL: `http://localhost:3232`

### Salud y metadatos

- `GET /api/status`
  - Devuelve conteo de vendors y categorias.

- `GET /api/lm-status`
  - Verifica conectividad con LM Studio y modelo activo.

### Catalogo y consultas

- `GET /api/categories`
  - Categorias persistidas en DB.

- `GET /api/category-defs`
  - Definiciones estaticas de categorias y vendors semilla.

- `GET /api/categories/:name/vendors`
  - Vendors de una categoria.

- `GET /api/vendors`
  - Consulta con filtros por query params:
  - `category`, `minScore`, `maxScore`, `region`, `acquisitionMode`, `marketPosition`, `sortBy`, `sortOrder`, `limit`, `offset`.

### Analisis

- `POST /api/analyze`
  - Body JSON: `{ "vendor": "...", "category": "..." }`
  - Crea un job asincrono de analisis.

- `GET /api/analyze/:jobId`
  - Estado del job (`pending|running|done|error`).

- `GET /api/analyze/:jobId/progress`
  - Stream SSE con eventos `step`, `done`, `error`.

### Utilidad de enlaces

- `POST /api/check-urls`
  - Body JSON: `{ "urls": ["https://..."] }`
  - Hace validacion server-side de estado/redirects evitando CORS del navegador.

## 11. Persistencia y modelo de datos

Tablas principales:
- `categories`
- `vendors`
- `ranking_criteria`
- `search_records`

Detalles relevantes:
- `vendors` guarda arrays como JSON string (`advantages`, `resource_links`, etc.).
- `ranking_criteria` es 1:1 por `vendor_id`.
- `search_records` permite auditoria de evidencias consultadas.
- Indices para categoria, score y posicion de mercado.

## 12. Formula de scoring

El score compuesto se calcula como suma ponderada de criterios (0-10):

- `marketPresence`: 20%
- `featureCompleteness`: 20%
- `securityCertsScore`: 15%
- `analystRecognition`: 15%
- `deploymentOptions`: 10%
- `integrationEcosystem`: 10%
- `supportQuality`: 5%
- `innovationScore`: 5%
- `priceValue`: 0% (informativo, no impacta score final)

## 13. Categorias disponibles por defecto

- SIEM
- EDR/XDR
- SOAR
- IAM/PAM
- Zero Trust
- Threat Intelligence
- AI Security
- Cloud Security

Las definiciones y listas semilla viven en `src/data/categories.ts`.

## 14. Salidas generadas

- Base de datos: `data/vendors.db`
- Reporte Markdown: `reports/vendor-report.md`
- Dashboard HTML: `reports/dashboard.html`
- Export JSON: `reports/vendors.json`

## 15. Troubleshooting rapido

### Error al arrancar `npm run server`

Revisar:
- Version de Node.js (necesario 22.5+).
- Que `npm install` haya finalizado correctamente.
- Que el puerto 3232 este libre.

### LM Studio no responde

Revisar:
- LM Studio abierto y modelo cargado.
- URL/API key/model en `.env`.
- Endpoint correcto con sufijo `/v1`.
- Endpoint `GET /api/lm-status` para validar conexion.

### Analisis con pocos datos

Revisar:
- `AGENT_MAX_REACT_ITERATIONS` y `AGENT_MAX_SEARCH_RESULTS`.
- Calidad del modelo local cargado.
- Prompt de sistema y prompts de refuerzo en `src/agent/react-agent.ts`.

## 16. MITRE ATT&CK RAG

El agente incluye un pipeline RAG completo sobre el framework MITRE ATT&CK Enterprise, integrado como herramienta nativa del agente ReAct.

### 16.1 Arquitectura del pipeline

```
Consulta del usuario
    │
    ▼
EmbeddingClient.embed()        ← LM Studio /v1/embeddings
    │  vector float[]
    ▼
MitreVectorStore.search()      ← similitud coseno sobre índice en memoria
    │  RetrievedEntry[]          (cargado una vez desde BLOB SQLite)
    ▼
formatContext()                ← bloque Markdown estructurado
    │  string
    ▼
Resultado tool_call del agente ← inyectado en el historial de conversación
    │
    ▼
Respuesta del análisis de vendor ← fundamentada en datos verificados ATT&CK
```

### 16.2 Archivos del módulo

| Archivo | Función |
|---------|---------|
| `src/mitre/types.ts` | Tipos: `MitreEntry`, `RetrievedEntry`, `MitreRagResult` |
| `src/mitre/ingest.ts` | Descarga el bundle STIX 2.1 (~15 MB) desde `github.com/mitre/cti` y parsea técnicas, tácticas, grupos, software y mitigaciones |
| `src/mitre/embeddings.ts` | `EmbeddingClient` (OpenAI SDK → `/v1/embeddings` de LM Studio) + `buildEmbedText()` para estructurar cada entrada |
| `src/mitre/vector-store.ts` | Almacén SQLite con vectores BLOB (floats LE 4 bytes), similitud coseno en JS puro, índice en memoria |
| `src/mitre/rag.ts` | Clase `MitreRag` (init lazy, pipeline completo) + `runIngestionPipeline()` |
| `src/agent/tools/mitre.ts` | `MITRE_TOOL_DEFINITION` (schema OpenAI) + `MitreRagTool` runner |

### 16.3 Decisiones técnicas

| Decisión | Justificación |
|----------|--------------|
| **`/v1/embeddings` de LM Studio** | Sin dependencias nuevas — reutiliza el SDK `openai` existente |
| **Vectores BLOB en SQLite** | Encaja con `node:sqlite` ya en uso; ~6 MB para 2 000 entradas × 768 dimensiones |
| **Similitud coseno en JS puro** | Sin extensiones nativas; suficiente para ≤ 5 000 entradas |
| **Init lazy / singleton** | El arranque en frío no se penaliza si no se consulta MITRE |
| **Fallback léxico automático** | Si embeddings falla (vector cero / mismatch), el RAG sigue devolviendo contexto útil por búsqueda de keywords |
| **Columna `ext_references`** | `references` es palabra reservada en SQLite |
| **Umbral configurable (0.25)** | Filtra coincidencias de baja calidad antes de que lleguen al prompt |

### 16.4 Mitigación de alucinaciones

1. Cada entrada recuperada incluye su URL oficial de ATT&CK — el LLM cita la fuente en lugar de parafrasear libremente.
2. El score de similitud se expone por entrada para que el LLM (y el usuario) puedan valorar la relevancia.
3. El umbral configurable `MITRE_SIMILARITY_THRESHOLD` (default `0.25`) descarta coincidencias de baja confianza.
4. `topK` está limitado a 10 para evitar inundar el contexto.

### 16.5 Configuración (.env)

```env
# Modelo de embeddings cargado en LM Studio
# Recomendados: nomic-embed-text-v1.5 | all-minilm-l6-v2 | mxbai-embed-large-v1
EMBEDDING_MODEL=nomic-embed-text-v1.5

# Número de entradas a recuperar por consulta (máx. 10)
MITRE_TOP_K=5

# Similitud coseno mínima para incluir una entrada (0.0–1.0)
MITRE_SIMILARITY_THRESHOLD=0.25

# Máximo de caracteres de contexto MITRE a inyectar por llamada al agente
MITRE_MAX_CONTEXT_CHARS=4000
```

### 16.6 Tablas SQLite añadidas

- **`mitre_entries`** — metadatos completos de cada entrada ATT&CK.
- **`mitre_embeddings`** — vectores BLOB vinculados a `mitre_entries` por clave foránea.

Ambas tablas se crean automáticamente al arrancar la aplicación.

### 16.7 Comandos

```bash
# Descarga el bundle STIX y genera embeddings (idempotente, re-ejecutable)
npm run mitre:ingest

# REPL interactivo para probar la base de conocimiento
npm run mitre:query

# Consulta única no interactiva
npm run mitre:query -- --query "ransomware encryption techniques" --top-k 5

# Diagnóstico de index, modelos y top scores
npm run mitre:diagnose -- --query "ransomware encryption techniques"

# Probe de modelos cargados en LM Studio (detecta embeddings válidos/no válidos)
npm run mitre:probe
npm run mitre:probe -- --all
```

Una vez ingestado, los análisis de vendor (`npm run analyze`) incluyen automáticamente `query_mitre_attack` como herramienta del agente, que el LLM invoca cuando necesita contrastar técnicas ATT&CK detectadas o mitigadas por el vendor evaluado.

### 16.8 Flujo de ingesta

1. Descarga el bundle STIX Enterprise (~15 MB) de `github.com/mitre/cti`.
2. Parsea todos los objetos no revocados ni deprecados.
3. Persiste las entradas en `mitre_entries` (upsert).
4. Verifica que el modelo de embeddings responde en LM Studio.
5. Genera embeddings para las entradas que aún no los tienen (en lotes de 50).
6. Almacena los vectores como BLOB en `mitre_embeddings`.
7. Carga el índice completo en memoria para búsqueda instantánea.

### 16.9 Problemas conocidos y recuperación rápida

- **Síntoma**: scores MITRE muy bajos o `0.0%` para todas las consultas.
- **Causa común**: embeddings degenerados (vector cero) o mismatch entre modelo de ingesta y de consulta.
- **Verificación**: `npm run mitre:probe`.
- **Recuperación**:

```bash
npm run mitre:reset
npm run mitre:ingest
npm run mitre:diagnose -- --query "ransomware encryption techniques"
```

Si todos los modelos del probe salen `ZERO` o `ERROR`, el problema está en el runtime de embeddings de LM Studio y no en el índice MITRE. En ese escenario, el sistema usa fallback léxico para no quedarse sin contexto.

## 17. Sugerencias de mejora

- Versionar prompts en archivos dedicados para facilitar A/B testing.
- Añadir tests de regresion para parsing JSON de respuestas LLM.
- Añadir sistema de cache por URL para reducir scraping repetido.
- Incluir trazabilidad de rationale por criterio en DB separada.
- Incorporar normalizacion de dominios oficiales para reducir ruido.
- Evaluar modelos de embeddings dedicados (nomic-embed-text-v1.5 vs mxbai-embed-large-v1) con métricas de recall sobre consultas MITRE representativas.
- Implementar actualización periódica automatizada del bundle STIX (cron o script CI).

## 19. Licencia

No se detecta licencia explicita en este repositorio.
Si vas a distribuirlo, añade un archivo `LICENSE` con los terminos deseados.
#   V E N D O R S - A I - M A S T E R  
 