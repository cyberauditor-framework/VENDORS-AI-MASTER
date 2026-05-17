import express, { Request, Response } from 'express';
import path from 'path';
import fs from 'fs/promises';
import axios from 'axios';
import { runMigrations } from '../database/schema';
import {
  getAllCategories,
  queryVendors,
  getVendorCount,
  getVendorById,
  getVendorsByCategory,
  upsertCategory,
  upsertVendor,
  upsertRankingCriteria,
  insertSearchRecord,
  deleteVendorAnalysis,
  deleteCategoryAnalyses,
  deleteAllAnalyses,
} from '../database/repository';
import { VENDOR_CATEGORIES, getCategoryDef } from '../data/categories';
import { agentConfig } from '../config';
import { ReActAgent } from '../agent/react-agent';
import { LLMClient } from '../agent/llm-client';
import { MitreCoverageAgent } from '../agent/mitre-coverage-agent';
import { MitreRag } from '../mitre/rag';
import { MitreVectorStore } from '../mitre/vector-store';
import { ReActStep, VendorAnalysis } from '../types';
import { MitreCoverageReport } from '../types/mitre-coverage';
import {
  runChatMigrations,
  createConversation,
  renameConversation,
  deleteConversation as dbDeleteConversation,
  listConversations,
  getConversation,
  addMessage,
  getMessages,
  saveCoverageReport,
  listReports,
  listVendorStats as listTopicStats,
  getVendorReports as getTopicReports,
  deleteVendorReports as deleteTopicReports,
  getMergedVendorReport as getMergedTopicReport,
  saveMergedVendorSelection as saveMergedTopicSelection,
} from '../database/chat-db';

// ─── DB Init ──────────────────────────────────────────────────────────────────

runMigrations();
runChatMigrations();

// ─── Job Tracking ─────────────────────────────────────────────────────────────

interface AnalysisJob {
  id: string;
  status: 'pending' | 'running' | 'done' | 'error';
  vendor: string;
  category: string;
  steps: ReActStep[];
  result?: { vendorId: number; score: number; position: string; timeMs: number };
  error?: string;
  startedAt: string;
  completedAt?: string;
  sseClients: Response[];
}

const jobs = new Map<string, AnalysisJob>();

// ─── MITRE Coverage Job Tracking ──────────────────────────────────────────────

interface MitreCoverageJob {
  id: string;
  status: 'pending' | 'running' | 'done' | 'error' | 'insufficient';
  topic: string;
  steps: Array<{ type: string; content: string; timestamp: string }>;
  result?: MitreCoverageReport;
  error?: string;
  startedAt: string;
  completedAt?: string;
  sseClients: Response[];
}

const mitreJobs = new Map<string, MitreCoverageJob>();

function broadcastMitreSSE(job: MitreCoverageJob, event: string, data: unknown): void {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  job.sseClients.forEach(client => {
    try { (client as Response).write(payload); } catch { /* client disconnected */ }
  });
}

function broadcastSSE(job: AnalysisJob, event: string, data: unknown): void {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  job.sseClients.forEach(client => {
    try { (client as Response).write(payload); } catch { /* client disconnected */ }
  });
}

// ─── Express App ──────────────────────────────────────────────────────────────

const app = express();

app.use((req: Request, res: Response, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.sendStatus(204);
    return;
  }

  next();
});

app.use(express.json());

// Serve static SPA from /public (two levels up from dist/server or src/server)
const PUBLIC_DIR = path.resolve(__dirname, '../../public');
const INPUT_DIR = path.resolve(__dirname, '../../input');
app.use(express.static(PUBLIC_DIR));
app.use('/input', express.static(INPUT_DIR));

// ─── API: Status ──────────────────────────────────────────────────────────────

app.get('/api/status', (_req: Request, res: Response) => {
  const categories = getAllCategories();
  res.json({
    vendorCount: getVendorCount(),
    categoryCount: categories.length,
  });
});

// ─── API: LM Studio health ────────────────────────────────────────────────────

app.get('/api/lm-status', async (_req: Request, res: Response) => {
  try {
    const llm = new LLMClient(agentConfig);
    const alive = await llm.ping();
    res.json({ alive, url: agentConfig.lmStudioUrl, model: agentConfig.model });
  } catch (err) {
    res.json({ alive: false, url: agentConfig.lmStudioUrl, model: agentConfig.model, error: String(err) });
  }
});

// ─── API: Categories ──────────────────────────────────────────────────────────

app.get('/api/categories', (_req: Request, res: Response) => {
  res.json(getAllCategories());
});

// All static category definitions (includes vendor lists)
app.get('/api/category-defs', (_req: Request, res: Response) => {
  res.json(VENDOR_CATEGORIES);
});

app.get('/api/benchmark/files', async (_req: Request, res: Response) => {
  try {
    const entries = await fs.readdir(INPUT_DIR, { withFileTypes: true });
    const files = entries
      .filter(entry => entry.isFile() && entry.name.toLowerCase().endsWith('.html'))
      .map(entry => {
        const title = entry.name
          .replace(/\.html$/i, '')
          .replace(/[_-]+/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();

        return {
          name: entry.name,
          title,
          url: `/input/${encodeURIComponent(entry.name)}`,
        };
      })
      .sort((a, b) => a.title.localeCompare(b.title));

    res.json(files);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: `Unable to read benchmark files: ${message}` });
  }
});

// Vendors in a specific category
app.get('/api/categories/:name/vendors', (req: Request, res: Response) => {
  const vendors = getVendorsByCategory(String(req.params.name));
  res.json(vendors.map(({ rawAnalysis: _ra, ...v }) => v));
});

// ─── API: URL health check ────────────────────────────────────────────────────
// Validates a list of URLs from the server side (avoids browser CORS blocking).
// POST { urls: string[] } → { results: { url, ok, status, redirected, finalUrl }[] }

app.post('/api/check-urls', async (req: Request, res: Response) => {
  const urls: string[] = Array.isArray(req.body?.urls) ? req.body.urls : [];
  if (urls.length === 0) { res.json({ results: [] }); return; }
  if (urls.length > 30)  { res.status(400).json({ error: 'Max 30 URLs per request' }); return; }

  const results = await Promise.all(
    urls.map(async (url) => {
      if (!url?.startsWith('http')) return { url, ok: false, status: 0, error: 'Invalid URL' };
      try {
        const r = await axios.head(url, {
          timeout: 8000,
          maxRedirects: 5,
          validateStatus: () => true,          // never throw on 4xx/5xx
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; VendorsAI/1.0)' },
        });
        return {
          url,
          ok: r.status >= 200 && r.status < 400,
          status: r.status,
          finalUrl: r.request?.res?.responseUrl ?? url,
        };
      } catch (err: unknown) {
        // Some servers reject HEAD — retry with GET (range 0 bytes)
        try {
          const r = await axios.get(url, {
            timeout: 8000,
            maxRedirects: 5,
            validateStatus: () => true,
            headers: { 'User-Agent': 'Mozilla/5.0 (compatible; VendorsAI/1.0)', Range: 'bytes=0-0' },
            responseType: 'stream',
          });
          r.data.destroy();
          return {
            url,
            ok: r.status >= 200 && r.status < 400,
            status: r.status,
            finalUrl: r.request?.res?.responseUrl ?? url,
          };
        } catch {
          const msg = err instanceof Error ? err.message : String(err);
          return { url, ok: false, status: 0, error: msg.slice(0, 120) };
        }
      }
    }),
  );

  res.json({ results });
});

// ─── API: Vendors ─────────────────────────────────────────────────────────────

app.get('/api/vendors', (req: Request, res: Response) => {
  const q = req.query as Record<string, string>;
  const vendors = queryVendors({
    category:        q.category        || undefined,
    minScore:        q.minScore        ? parseFloat(q.minScore)  : undefined,
    maxScore:        q.maxScore        ? parseFloat(q.maxScore)  : undefined,
    region:          q.region          as any || undefined,
    acquisitionMode: q.acquisitionMode as any || undefined,
    marketPosition:  q.marketPosition  as any || undefined,
    sortBy:          (q.sortBy as any) || 'score',
    sortOrder:       (q.sortOrder as any) || 'desc',
    limit:           q.limit           ? parseInt(q.limit)  : undefined,
    offset:          q.offset          ? parseInt(q.offset) : 0,
  });
  // Strip heavy fields not needed in list view
  res.json(vendors.map(({ rawAnalysis: _ra, ...v }) => v));
});

app.get('/api/vendors/:id', (req: Request, res: Response) => {
  const vendorId = parseInt(String(req.params.id), 10);
  if (!Number.isFinite(vendorId)) {
    res.status(400).json({ error: 'Invalid vendor id' });
    return;
  }

  const vendor = getVendorById(vendorId);
  if (!vendor) {
    res.status(404).json({ error: 'Vendor not found' });
    return;
  }

  res.json(vendor);
});

// ─── API: Data Management ────────────────────────────────────────────────────

app.delete('/api/admin/vendors/:id', (req: Request, res: Response) => {
  const vendorId = parseInt(String(req.params.id), 10);
  if (!Number.isFinite(vendorId)) {
    res.status(400).json({ error: 'Invalid vendor id' });
    return;
  }

  const deleted = deleteVendorAnalysis(vendorId);
  if (!deleted) {
    res.status(404).json({ error: 'Vendor not found' });
    return;
  }

  res.json({ ok: true, vendorId });
});

app.delete('/api/admin/categories/:name/analyses', (req: Request, res: Response) => {
  const categoryName = String(req.params.name || '').trim();
  if (!categoryName) {
    res.status(400).json({ error: 'Category name is required' });
    return;
  }

  const deletedCount = deleteCategoryAnalyses(categoryName);
  res.json({ ok: true, categoryName, deletedCount });
});

app.delete('/api/admin/analyses', (_req: Request, res: Response) => {
  const summary = deleteAllAnalyses();
  res.json({ ok: true, ...summary });
});

// ─── API: Analyze ─────────────────────────────────────────────────────────────

app.post('/api/analyze', (req: Request, res: Response) => {
  const { vendor, category } = req.body as { vendor: string; category: string };

  if (!vendor || !category) {
    res.status(400).json({ error: 'vendor and category are required' });
    return;
  }

  const catDef = getCategoryDef(category);
  if (!catDef) {
    res.status(400).json({ error: `Unknown category: ${category}` });
    return;
  }

  const jobId = `job-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const job: AnalysisJob = {
    id: jobId,
    status: 'pending',
    vendor,
    category,
    steps: [],
    startedAt: new Date().toISOString(),
    sseClients: [],
  };
  jobs.set(jobId, job);

  // Fire-and-forget background analysis
  void (async () => {
    job.status = 'running';
    broadcastSSE(job, 'status', { status: 'running', vendor, category });

    try {
      const categoryId = upsertCategory({
        name: catDef.name,
        fullName: catDef.fullName,
        description: catDef.description,
      });

      const agent = new ReActAgent(agentConfig);
      const analysis: VendorAnalysis = await agent.analyzeVendor(
        vendor,
        catDef.name,
        categoryId,
        (step: ReActStep) => {
          job.steps.push(step);
          broadcastSSE(job, 'step', step);
        },
      );

      const vendorId = upsertVendor({ ...analysis.vendor, categoryId });
      upsertRankingCriteria({ ...analysis.rankingCriteria, vendorId });
      analysis.searchRecords.forEach(rec => insertSearchRecord({ ...rec, vendorId }));

      job.status = 'done';
      job.completedAt = new Date().toISOString();
      job.result = {
        vendorId,
        score: analysis.vendor.rankingScore,
        position: analysis.vendor.marketPosition,
        timeMs: analysis.processingTimeMs,
      };

      broadcastSSE(job, 'done', job.result);
    } catch (err: unknown) {
      job.status = 'error';
      job.error = err instanceof Error ? err.message : String(err);
      job.completedAt = new Date().toISOString();
      broadcastSSE(job, 'error', { error: job.error });
    } finally {
      job.sseClients.forEach(c => { try { (c as Response).end(); } catch { /* ignored */ } });
      job.sseClients = [];
    }
  })();

  res.json({ jobId, vendor, category });
});

// SSE stream for job progress
app.get('/api/analyze/:jobId/progress', (req: Request, res: Response) => {
  const job = jobs.get(String(req.params.jobId));
  if (!job) { res.status(404).json({ error: 'Job not found' }); return; }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  // Replay history for late-connecting clients
  job.steps.forEach(step => {
    res.write(`event: step\ndata: ${JSON.stringify(step)}\n\n`);
  });

  if (job.status === 'done') {
    res.write(`event: done\ndata: ${JSON.stringify(job.result)}\n\n`);
    res.end(); return;
  }
  if (job.status === 'error') {
    res.write(`event: error\ndata: ${JSON.stringify({ error: job.error })}\n\n`);
    res.end(); return;
  }

  job.sseClients.push(res);
  req.on('close', () => { job.sseClients = job.sseClients.filter(c => c !== res); });
});

// Job status (polling alternative to SSE)
app.get('/api/analyze/:jobId', (req: Request, res: Response) => {
  const job = jobs.get(String(req.params.jobId));
  if (!job) { res.status(404).json({ error: 'Job not found' }); return; }
  const { sseClients: _c, ...safe } = job;
  res.json(safe);
});

// ─── API: MITRE RAG Status ────────────────────────────────────────────────────

app.get('/api/mitre/status', (_req: Request, res: Response) => {
  try {
    const store = new MitreVectorStore();
    store.ensureSchema();
    const entries     = store.getEntryCount();
    const embeddings  = store.getEmbeddingCount();
    const storedModel = store.getEmbeddingModel();
    const configuredModel = process.env.EMBEDDING_MODEL ?? null;
    const modelMismatch =
      storedModel !== null && configuredModel !== null && storedModel !== configuredModel;

    res.json({
      entries,
      embeddings,
      storedModel,
      configuredModel,
      modelMismatch,
      ready: embeddings > 0 && !modelMismatch,
      hint: embeddings === 0
        ? 'Run: npm run mitre:ingest'
        : modelMismatch
          ? `Model mismatch — stored: "${storedModel}", configured: "${configuredModel}". ` +
            'Run: npm run mitre:reset && npm run mitre:ingest'
          : 'OK',
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ─── API: MITRE Local RAG Query ──────────────────────────────────────────────

async function mitreLocalQueryHandler(req: Request, res: Response): Promise<void> {
  const { query, topK } = req.body as { query?: string; topK?: number };
  const q = String(query ?? '').trim();
  if (!q) {
    res.status(400).json({ error: 'query is required' });
    return;
  }

  const parsedTopK = Number.isFinite(Number(topK)) ? Number(topK) : 8;
  const safeTopK = Math.max(1, Math.min(10, parsedTopK));

  try {
    const rag = new MitreRag();
    await rag.init();
    const result = await rag.query(q, safeTopK);
    res.json({
      query: q,
      topK: safeTopK,
      totalEntries: result.totalEntries,
      resultCount: result.entries.length,
      formattedContext: result.formattedContext,
      entries: result.entries,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
}

app.post('/api/mitre/query-local', (req: Request, res: Response) => {
  void mitreLocalQueryHandler(req, res);
});

// Backward/alt compatibility alias
app.post('/api/mitre/query', (req: Request, res: Response) => {
  void mitreLocalQueryHandler(req, res);
});

app.post('/api/mitre/query-local/save', (req: Request, res: Response) => {
  const { query, result, conversationId: rawConvId } = req.body as {
    query?: string;
    result?: {
      entries?: Array<{
        score?: number;
        entry?: {
          id?: string;
          name?: string;
          type?: string;
          tactics?: string[];
          description?: string;
          url?: string;
          references?: Array<{ url?: string }>;
        };
      }>;
      totalEntries?: number;
      formattedContext?: string;
    };
    conversationId?: number;
  };

  const q = String(query ?? '').trim();
  const entries = Array.isArray(result?.entries) ? result.entries : [];

  if (!q) {
    res.status(400).json({ error: 'query is required' });
    return;
  }
  if (!entries.length) {
    res.status(400).json({ error: 'result.entries is required' });
    return;
  }

  try {
    const topicLabel = 'MITRE Local RAG';
    const scoreValues = entries
      .map(e => Number(e?.score))
      .filter(v => Number.isFinite(v));
    const avgSimilarity = scoreValues.length
      ? scoreValues.reduce((acc, v) => acc + v, 0) / scoreValues.length
      : 0;
    const overallScore = Math.max(0, Math.min(10, Number((avgSimilarity * 10).toFixed(1))));

    const ttpsAddressed = entries.map(e => {
      const entry = e?.entry ?? {};
      const rawScore = Number(e?.score);
      const similarity = Number.isFinite(rawScore) ? rawScore : 0;
      let coverageLevel: 'full' | 'partial' | 'none' | 'unknown' = 'unknown';
      if (similarity >= 0.85) coverageLevel = 'full';
      else if (similarity >= 0.7) coverageLevel = 'partial';
      else if (similarity >= 0.5) coverageLevel = 'none';

      const refUrls = Array.isArray(entry.references)
        ? entry.references
          .map(r => String(r?.url ?? '').trim())
          .filter(Boolean)
        : [];

      return {
        techniqueId: String(entry.id ?? 'N/A'),
        techniqueName: String(entry.name ?? 'MITRE entry'),
        tactics: Array.isArray(entry.tactics) ? entry.tactics : [],
        coverageLevel,
        products: [
          `Local RAG match (${(similarity * 100).toFixed(1)}% similarity)`,
        ],
        description: String(entry.description ?? '').slice(0, 1200),
        evidenceUrls: [String(entry.url ?? '').trim(), ...refUrls].filter(Boolean),
      };
    });

    const sourcesConsulted = Array.from(new Set(
      entries.flatMap(e => {
        const entry = e?.entry ?? {};
        const refs = Array.isArray(entry.references)
          ? entry.references.map(r => String(r?.url ?? '').trim()).filter(Boolean)
          : [];
        return [String(entry.url ?? '').trim(), ...refs].filter(Boolean);
      }),
    ));

    const report: MitreCoverageReport = {
      vendor: topicLabel,
      analysisDate: new Date().toISOString(),
      ttpsAddressed,
      coverageGaps: [],
      overallCoverageScore: overallScore,
      summary:
        `Resultado guardado para consulta local RAG: "${q}". ` +
        `${entries.length} coincidencias sobre ${Number(result?.totalEntries) || 0} entradas indexadas.`,
      sourcesConsulted,
      insufficientInfo: false,
    };

    let convId: number;
    if (rawConvId) {
      const existing = getConversation(rawConvId);
      convId = existing ? rawConvId : createConversation(topicLabel);
    } else {
      convId = createConversation(topicLabel);
    }

    addMessage(convId, 'user', q, topicLabel);
    const agentText = result?.formattedContext?.trim() || report.summary;
    const msgId = addMessage(convId, 'agent', agentText, topicLabel);
    const reportId = saveCoverageReport(msgId, convId, report);

    renameConversation(convId, `${topicLabel} — ${new Date().toLocaleDateString()}`);

    res.json({
      ok: true,
      conversationId: convId,
      messageId: msgId,
      reportId,
      topic: topicLabel,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

// ─── API: MITRE ATT&CK Query Analysis Chatbot ───────────────────────────────

app.post('/api/mitre/analysis', (req: Request, res: Response) => {
  const { topic, query, conversationId: rawConvId } = req.body as {
    topic?: string;
    query?: string;
    conversationId?: number;
  };
  const analysisQuery = String(query ?? '').trim();
  if (!analysisQuery) {
    res.status(400).json({ error: 'query is required' });
    return;
  }
  const safeTopic = String(topic ?? '').trim() || analysisQuery.slice(0, 80);

  const jobId = `mitre-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const job: MitreCoverageJob = {
    id: jobId,
    status: 'pending',
    topic: safeTopic,
    steps: [],
    startedAt: new Date().toISOString(),
    sseClients: [],
  };
  mitreJobs.set(jobId, job);

  void (async () => {
    job.status = 'running';
    broadcastMitreSSE(job, 'status', { status: 'running', topic: job.topic });

    // Resolve or create conversation
    let convId: number;
    try {
      if (rawConvId) {
        const existing = getConversation(rawConvId);
        convId = existing ? rawConvId : createConversation(job.topic);
      } else {
        convId = createConversation(job.topic);
      }
      // Save user message
      addMessage(convId, 'user', analysisQuery, job.topic);
      broadcastMitreSSE(job, 'conversation', { conversationId: convId });
    } catch {
      // DB errors are non-fatal
      convId = -1;
    }

    try {
      const agent = new MitreCoverageAgent(agentConfig);
      const report = await agent.analyseCoverage(analysisQuery, (type, content) => {
        const step = { type, content, timestamp: new Date().toISOString() };
        job.steps.push(step);
        broadcastMitreSSE(job, 'step', step);
      });

      job.result = report;
      job.completedAt = new Date().toISOString();
      job.status = report.insufficientInfo ? 'insufficient' : 'done';

      // Persist agent reply and coverage report
      if (convId > 0) {
        try {
          const agentText = report.summary || `MITRE analysis for: ${job.topic}`;
          const msgId = addMessage(convId, 'agent', agentText, job.topic);
          saveCoverageReport(msgId, convId, report);
          renameConversation(convId, `${job.topic} — ${new Date().toLocaleDateString()}`);
        } catch { /* non-fatal */ }
      }

      broadcastMitreSSE(job, 'done', { ...report, conversationId: convId > 0 ? convId : undefined });
    } catch (err: unknown) {
      job.status = 'error';
      job.error = err instanceof Error ? err.message : String(err);
      job.completedAt = new Date().toISOString();
      broadcastMitreSSE(job, 'error', { error: job.error });
    } finally {
      job.sseClients.forEach(c => { try { (c as Response).end(); } catch { /* ignored */ } });
      job.sseClients = [];
    }
  })();

  res.json({ jobId, topic: job.topic });
});

app.get('/api/mitre/analysis/:jobId/progress', (req: Request, res: Response) => {
  const job = mitreJobs.get(String(req.params.jobId));
  if (!job) { res.status(404).json({ error: 'Job not found' }); return; }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  job.steps.forEach(step => res.write(`event: step\ndata: ${JSON.stringify(step)}\n\n`));

  if (job.status === 'done' || job.status === 'insufficient') {
    res.write(`event: done\ndata: ${JSON.stringify(job.result)}\n\n`);
    res.end(); return;
  }
  if (job.status === 'error') {
    res.write(`event: error\ndata: ${JSON.stringify({ error: job.error })}\n\n`);
    res.end(); return;
  }

  job.sseClients.push(res);
  req.on('close', () => { job.sseClients = job.sseClients.filter(c => c !== res); });
});

app.get('/api/mitre/analysis/:jobId', (req: Request, res: Response) => {
  const job = mitreJobs.get(String(req.params.jobId));
  if (!job) { res.status(404).json({ error: 'Job not found' }); return; }
  const { sseClients: _c, ...safe } = job;
  res.json(safe);
});

// ─── API: MITRE Chat History ──────────────────────────────────────────────────

// List all conversations (newest first)
app.get('/api/mitre/conversations', (_req: Request, res: Response) => {
  res.json(listConversations());
});

// Create a new conversation
app.post('/api/mitre/conversations', (req: Request, res: Response) => {
  const { title } = req.body as { title?: string };
  const id = createConversation(title);
  res.json({ id });
});

// Get a single conversation with its messages
app.get('/api/mitre/conversations/:id', (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  if (!Number.isFinite(id)) { res.status(400).json({ error: 'Invalid id' }); return; }
  const conv = getConversation(id);
  if (!conv) { res.status(404).json({ error: 'Conversation not found' }); return; }
  const messages = getMessages(id);
  res.json({ ...conv, messages });
});

// Rename a conversation
app.patch('/api/mitre/conversations/:id', (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  if (!Number.isFinite(id)) { res.status(400).json({ error: 'Invalid id' }); return; }
  const { title } = req.body as { title?: string };
  if (!title?.trim()) { res.status(400).json({ error: 'title is required' }); return; }
  renameConversation(id, title.trim());
  res.json({ ok: true });
});

// Delete a conversation (cascades to messages + reports)
app.delete('/api/mitre/conversations/:id', (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  if (!Number.isFinite(id)) { res.status(400).json({ error: 'Invalid id' }); return; }
  dbDeleteConversation(id);
  res.json({ ok: true });
});

// List recent coverage reports (cross-conversation)
app.get('/api/mitre/reports', (req: Request, res: Response) => {
  const limit = req.query.limit ? parseInt(String(req.query.limit), 10) : 50;
  res.json(listReports(Number.isFinite(limit) ? limit : 50));
});

// ─── API: MITRE Coverage — topic aggregates ─────────────────────────────────

// Summary stats for every topic label with at least one valid analysis
app.get('/api/mitre/topic-stats', (_req: Request, res: Response) => {
  const rows = listTopicStats();
  res.json(rows.map(r => ({ ...r, topic: r.vendor })));
});

// All stored reports for one topic (newest first)
app.get('/api/mitre/topic-stats/:topic/reports', (req: Request, res: Response) => {
  const topic = decodeURIComponent(String(req.params.topic));
  res.json(getTopicReports(topic));
});

// Merged/accumulated report for one topic
app.get('/api/mitre/topic-stats/:topic/merged', (req: Request, res: Response) => {
  const topic = decodeURIComponent(String(req.params.topic));
  const merged = getMergedTopicReport(topic);
  if (!merged) { res.status(404).json({ error: 'No valid analyses found for this topic' }); return; }
  res.json(merged);
});

// Persist a merged report from a user-selected subset of runs
app.post('/api/mitre/topic-stats/:topic/merge-selection', (req: Request, res: Response) => {
  const topic = decodeURIComponent(String(req.params.topic));
  const reportIds = Array.isArray(req.body?.reportIds)
    ? req.body.reportIds
      .map((x: unknown) => Number(x))
      .filter((n: number) => Number.isInteger(n) && n > 0)
    : [];

  if (reportIds.length < 2) {
    res.status(400).json({ error: 'At least 2 valid reportIds are required' });
    return;
  }

  const saved = saveMergedTopicSelection(topic, reportIds);
  if (!saved) {
    res.status(404).json({ error: 'Unable to merge selected reports for this topic' });
    return;
  }

  res.json({
    ok: true,
    conversationId: saved.conversationId,
    messageId: saved.messageId,
    reportId: saved.reportId,
    report: saved.report,
  });
});

// Delete all analyses for one topic
app.delete('/api/mitre/topic-stats/:topic', (req: Request, res: Response) => {
  const topic = decodeURIComponent(String(req.params.topic));
  const deleted = deleteTopicReports(topic);
  res.json({ ok: true, deleted });
});

// ─── SPA Fallback ─────────────────────────────────────────────────────────────

app.get('/{*splat}', (_req: Request, res: Response) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

// ─── Start ────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT ? parseInt(process.env.PORT) : 3232;
app.listen(PORT, () => {
  console.log(`\n  ╔═══════════════════════════════════════════╗`);
  console.log(`  ║   Vendors AI Master  —  UI Server         ║`);
  console.log(`  ║   http://localhost:${PORT}                    ║`);
  console.log(`  ╚═══════════════════════════════════════════╝\n`);
});
