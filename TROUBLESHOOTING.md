# Troubleshooting

## MITRE ATT&CK RAG — Zero results / low similarity (<10%)

### Síntoma

```
No relevant MITRE ATT&CK entries found above the similarity threshold.
```

Ocurre incluso bajando `MITRE_SIMILARITY_THRESHOLD` a `0.01` y con el índice cargado correctamente (`Index: 1,705 entries loaded`).

También puede aparecer en diagnóstico como:

```
Top-10 similarity scores ... 0.0%
Threshold: 0.01 -> 0 entries would be returned
```

### Causa

Hay dos causas comunes:

1. **Model mismatch**: los embeddings de `mitre_embeddings` se generaron con otro modelo.
2. **Embeddings degenerados (vector cero)**: LM Studio devuelve embeddings de dimensión válida pero con norma `0` (todos los valores a `0`). En este caso, el cosine siempre será `0`.

Ejemplo de mismatch típico:

| Momento        | Modelo activo          |
|----------------|------------------------|
| `mitre:ingest` | `model-A`              |
| `mitre:query`  | `nomic-embed-text-v1.5`|

### Diagnóstico recomendado

1. Ejecuta diagnóstico general:

```bash
npm run mitre:diagnose -- --query "ransomware encryption techniques"
```

2. Ejecuta probe de modelos de embeddings (nuevo):

```bash
npm run mitre:probe
```

O para probar todos los modelos cargados:

```bash
npm run mitre:probe -- --all
```

3. Comprueba qué modelo está configurado:

```bash
node -e "require('dotenv').config(); console.log(process.env.EMBEDDING_MODEL, process.env.LM_STUDIO_MODEL)"
```

Si `mitre:probe` devuelve `ZERO` para un modelo, ese modelo no sirve para RAG en ese runtime de LM Studio.

### Solución

**A. Si hay mismatch de modelo**

1. Asegura el modelo correcto en `.env`:

```env
EMBEDDING_MODEL=<modelo-embedding-valido>
```

2. Regenera embeddings:

```bash
npm run mitre:reset
npm run mitre:ingest
```

**B. Si el modelo devuelve vectores cero (ZERO en probe)**

1. Cambia a otro modelo de embeddings que salga como `OK` en `mitre:probe`.
2. Repite:

```bash
npm run mitre:reset
npm run mitre:ingest
npm run mitre:diagnose -- --query "ransomware encryption techniques"
```

3. Si **todos** los modelos salen `ZERO` o `ERROR`, el problema está en LM Studio/runtime de embeddings. En ese caso:
   - Mantén activo el fallback léxico del RAG (ya implementado).
   - Actualiza/cambia build de LM Studio o proveedor/modelo de embeddings.

### Notas importantes

- `google/gemma-*` normalmente no es modelo de embeddings para `/v1/embeddings`.
- Desde la actualización, el sistema detecta embeddings inválidos y falla con mensaje claro (ya no falla en silencio).
- Cuando embeddings falla, el RAG usa **fallback léxico** para seguir devolviendo contexto MITRE útil.

> Regla clave: el modelo usado en `mitre:ingest` y `mitre:query` debe ser el mismo, y además debe devolver embeddings no nulos.

---

## MITRE ATT&CK RAG — `mitre:ingest` salta embeddings aunque el modelo está cargado

### Síntoma

```
Checking embedding model "text-embedding-nomic-embed-text-v1.5" in LM Studio...
[WARN] Embedding model "..." did not respond from LM Studio.
Embeddings created : 0
```

El modelo SÍ aparece en `/v1/models` y responde a peticiones HTTP directas (norma ≈ 1.0), pero el ingest lo ignora sistemáticamente.

### Causa

El SDK de OpenAI v4 solicita embeddings con `encoding_format: 'base64'` por defecto para reducir el tamaño de la respuesta. LM Studio devuelve el embedding como string base64, pero el decodificador del SDK lo convierte incorrectamente en un array de **ceros** (norma = 0) en lugar de los floats reales.

La validación interna detecta el vector cero y lanza una excepción que `ping()` captura en silencio → devuelve `false` → el ingest asume que el modelo no está disponible → salta todos los embeddings.

La petición HTTP directa funciona porque devuelve un array JSON de floats, sin pasar por la decodificación base64 del SDK.

### Diagnóstico rápido

```bash
# Comprueba si el SDK devuelve ceros
node -e "
require('dotenv').config();
const OpenAI = require('openai').default;
const c = new OpenAI({ baseURL: process.env.LM_STUDIO_URL, apiKey: process.env.LM_STUDIO_API_KEY });
c.embeddings.create({ model: process.env.EMBEDDING_MODEL, input: 'test' })
  .then(r => {
    const e = r.data[0].embedding;
    const norm = Math.sqrt(e.reduce((s,v) => s+v*v, 0));
    console.log('dims:', e.length, 'norm:', norm.toFixed(4));
  });
"
```

Si `norm: 0.0000` → el SDK está decodificando mal el base64. Si `norm: ~1.0000` → el modelo está bien.

### Solución

Forzar `encoding_format: 'float'` en la llamada al SDK para que LM Studio devuelva floats JSON directamente, sin base64.

Corregido en `src/mitre/embeddings.ts`:

```typescript
await this.openai.embeddings.create({
  model: this.model,
  input: text,
  encoding_format: 'float',  // ← evita el base64 roto de LM Studio
});
```

Después de este fix, ejecuta:

```bash
npm run mitre:reset
npm run mitre:ingest
npm run mitre:diagnose
```

El diagnóstico debe mostrar scores en el rango 60–70% y `✓ RAG index looks healthy`.

### Notas

- Afecta a todos los modelos de embeddings en LM Studio, no solo a nomic.
- El ID correcto del modelo debe incluir el prefijo completo tal como aparece en `GET /v1/models`, p.ej. `text-embedding-nomic-embed-text-v1.5` (no `nomic-embed-text-v1.5`).
- Para ver todos los modelos disponibles y su ID exacto: `curl http://localhost:1234/v1/models`

---

## MITRE ATT&CK RAG — `buf.readFloatLE is not a function`

### Síntoma

```
Ingestion failed: buf.readFloatLE is not a function
```

### Causa

`node:sqlite` devuelve columnas BLOB como `Uint8Array`, no como `Buffer` de Node.js. El método `.readFloatLE()` es exclusivo de `Buffer`.

### Solución

Corregido en `src/mitre/vector-store.ts` — `bufferToVector` ahora usa `DataView` sobre el `ArrayBuffer` subyacente, compatible con cualquier variante de typed array que devuelva SQLite.

Si vuelve a aparecer, verifica que estás usando la versión actualizada del fichero.

---

## LM Studio no responde

### Síntoma

```
ERROR: Cannot reach LM Studio at http://localhost:1234/v1
```

### Solución

1. Abre LM Studio y carga un modelo.
2. Confirma que el servidor local está activo (pestaña **Local Server** en LM Studio).
3. Verifica los valores en `.env`:
   ```env
   LM_STUDIO_URL=http://localhost:1234/v1
   LM_STUDIO_MODEL=<nombre-exacto-del-modelo-cargado>
   ```
4. Comprueba conectividad:
   ```bash
   curl http://localhost:1234/v1/models
   ```

---

## Análisis con JSON vacío o campos por defecto

### Síntoma

El vendor se guarda con score `5.0` en todos los criterios y campos vacíos.

### Causa probable

El modelo local no devolvió JSON válido dentro del límite de iteraciones ReAct.

### Solución

- Aumenta `AGENT_MAX_REACT_ITERATIONS` (default `6`) en `.env`.
- Aumenta `AGENT_MAX_TOKENS` (default `4096`).
- Usa un modelo local más capaz o con mayor ventana de contexto.
- Revisa los prompts de refuerzo en `src/agent/react-agent.ts`.
