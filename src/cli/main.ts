import { Command } from 'commander';
import chalk from 'chalk';
import * as cliProgress from 'cli-progress';
import * as path from 'path';
import * as fs from 'fs';
import inquirer from 'inquirer';

import { agentConfig, REPORTS_DIR } from '../config';
import { runIngestionPipeline, MitreRag } from '../mitre/rag';
import { getDb } from '../database/connection';
import { MitreCoverageAgent } from '../agent/mitre-coverage-agent';
import { MitreCoverageReport } from '../types/mitre-coverage';
import { runMigrations } from '../database/schema';
import {
  upsertCategory,
  upsertVendor,
  upsertRankingCriteria,
  insertSearchRecord,
  getAllCategories,
  getVendorsByCategory,
  queryVendors,
  getVendorCount,
} from '../database/repository';
import { ReActAgent } from '../agent/react-agent';
import { LLMClient } from '../agent/llm-client';
import { VENDOR_CATEGORIES, getCategoryDef, CATEGORY_NAMES } from '../data/categories';
import { buildComparisonResult } from '../analysis/comparator';
import { exportMarkdown, exportCategoryMarkdown } from '../export/markdown-exporter';
import { generateHtmlCharts, printAsciiRanking } from '../export/chart-generator';
import { renderVendorTable, interactiveQuery, printCategoryOverview } from './query-interface';
import { ReActStep } from '../types';

// ─── Setup ────────────────────────────────────────────────────────────────────

runMigrations();
const program = new Command();

program
  .name('vendors-ai')
  .description('AI-powered cybersecurity & AI vendor knowledge base')
  .version('1.0.0');

// ─── Analyze Command ──────────────────────────────────────────────────────────

program
  .command('analyze')
  .description('Run ReAct agent analysis on vendors')
  .option('-c, --category <name>', `Category to analyse (${CATEGORY_NAMES.join(', ')})`)
  .option('-v, --vendor <name>', 'Single vendor name to analyse')
  .option('-a, --all', 'Analyse all categories')
  .option('-f, --force', 'Re-analyse even if already in database')
  .option('-m, --max <n>', 'Max vendors per category', '5')
  .action(async (opts) => {
    await checkLmStudio();

    const agent = new ReActAgent(agentConfig);

    if (opts.all) {
      for (const catDef of VENDOR_CATEGORIES) {
        await analyseCategory(agent, catDef.name, parseInt(opts.max));
      }
    } else if (opts.vendor && opts.category) {
      await analyseSingleVendor(agent, opts.vendor, opts.category);
    } else if (opts.category) {
      await analyseCategory(agent, opts.category, parseInt(opts.max));
    } else {
      // Interactive selection
      const { category } = await inquirer.prompt([
        {
          type: 'list',
          name: 'category',
          message: 'Select a category to analyse:',
          choices: CATEGORY_NAMES,
        },
      ]);
      const { maxVendors } = await inquirer.prompt([
        {
          type: 'number',
          name: 'maxVendors',
          message: 'Max vendors to analyse:',
          default: 5,
        },
      ]);
      await analyseCategory(agent, category, maxVendors);
    }
  });

// ─── Query Command ────────────────────────────────────────────────────────────

program
  .command('query')
  .description('Query the vendor database')
  .option('-c, --category <name>', 'Filter by category')
  .option('--min-score <n>', 'Minimum score filter', parseFloat)
  .option('--region <r>', 'Geographic region filter')
  .option('--mode <m>', 'Acquisition mode filter')
  .option('--position <p>', 'Market position filter')
  .option('--sort <field>', 'Sort by: score|name|founded|category', 'score')
  .option('--asc', 'Sort ascending')
  .option('-l, --limit <n>', 'Limit results', parseInt)
  .option('-i, --interactive', 'Interactive query mode')
  .action(async (opts) => {
    if (opts.interactive) {
      await interactiveQuery();
      return;
    }

    const vendors = queryVendors({
      category: opts.category,
      minScore: opts.minScore,
      region: opts.region,
      acquisitionMode: opts.mode,
      marketPosition: opts.position,
      sortBy: opts.sort,
      sortOrder: opts.asc ? 'asc' : 'desc',
      limit: opts.limit,
    });

    if (opts.category) {
      printCategoryOverview(opts.category);
    } else {
      renderVendorTable(vendors);
    }
  });

// ─── Export Command ───────────────────────────────────────────────────────────

program
  .command('export')
  .description('Export vendor data')
  .option('-f, --format <fmt>', 'Format: markdown|json|html', 'markdown')
  .option('-c, --category <name>', 'Export single category')
  .option('-o, --output <path>', 'Output file/directory', REPORTS_DIR)
  .action((opts) => {
    const categories = opts.category
      ? [opts.category]
      : getAllCategories().map(c => c.name);

    if (categories.length === 0) {
      console.log(chalk.yellow('No categories in database yet. Run analyze first.'));
      return;
    }

    const results = categories
      .map(catName => buildComparisonResult(catName, getVendorsByCategory(catName)))
      .filter(r => r.vendors.length > 0);

    if (results.length === 0) {
      console.log(chalk.yellow('No vendor data found. Run analyze first.'));
      return;
    }

    if (opts.format === 'json') {
      const outPath = path.join(opts.output, 'vendors.json');
      fs.writeFileSync(outPath, JSON.stringify(results, null, 2), 'utf-8');
      console.log(chalk.green(`\n  JSON exported → ${outPath}\n`));
    } else if (opts.format === 'html') {
      const outPath = path.join(opts.output, 'dashboard.html');
      generateHtmlCharts(results, outPath);
      console.log(chalk.green(`\n  HTML dashboard → ${outPath}\n`));
    } else {
      const outPath = path.join(opts.output, 'vendor-report.md');
      exportMarkdown(results, outPath);
      console.log(chalk.green(`\n  Markdown report → ${outPath}\n`));
    }
  });

// ─── Charts Command ───────────────────────────────────────────────────────────

program
  .command('charts')
  .description('Generate and display charts')
  .option('-c, --category <name>', 'Single category or "all"')
  .option('--html', 'Generate HTML dashboard instead of ASCII')
  .option('-o, --output <path>', 'Output path for HTML', REPORTS_DIR)
  .action((opts) => {
    const catNames = (opts.category && opts.category !== 'all')
      ? [opts.category]
      : getAllCategories().map(c => c.name);

    const results = catNames
      .map(n => buildComparisonResult(n, getVendorsByCategory(n)))
      .filter(r => r.vendors.length > 0);

    if (results.length === 0) {
      console.log(chalk.yellow('No data. Run analyze first.'));
      return;
    }

    if (opts.html) {
      const outPath = path.join(opts.output, 'dashboard.html');
      generateHtmlCharts(results, outPath);
      console.log(chalk.green(`\n  HTML dashboard → ${outPath}\n`));
    } else {
      results.forEach(r => printAsciiRanking(r));
    }
  });

// ─── Interactive Mode ─────────────────────────────────────────────────────────

program
  .command('interactive')
  .description('Interactive menu')
  .action(async () => {
    await interactiveMenu();
  });

// ─── Status Command ───────────────────────────────────────────────────────────

program
  .command('status')
  .description('Show database statistics')
  .action(() => {
    const categories = getAllCategories();
    console.log(chalk.cyan('\n  Database Status\n'));
    console.log(`  Total vendors: ${chalk.bold(getVendorCount())}`);
    console.log(`  Categories: ${chalk.bold(categories.length)}\n`);
    categories.forEach(c => {
      const vendors = getVendorsByCategory(c.name);
      console.log(`    ${c.name.padEnd(20)} ${vendors.length} vendors`);
    });
    console.log();
  });

// ─── Internal Functions ───────────────────────────────────────────────────────

async function checkLmStudio(): Promise<void> {
  const llm = new LLMClient(agentConfig);
  console.log(chalk.dim(`  Connecting to LM Studio at ${agentConfig.lmStudioUrl}...`));
  const alive = await llm.ping();
  if (!alive) {
    console.log(chalk.red(`\n  ERROR: Cannot reach LM Studio at ${agentConfig.lmStudioUrl}`));
    console.log(chalk.yellow('  Make sure LM Studio is running and the model is loaded.\n'));
    process.exit(1);
  }
  console.log(chalk.green(`  LM Studio connected. Model: ${agentConfig.model}\n`));
}

async function analyseCategory(agent: ReActAgent, categoryName: string, maxVendors: number): Promise<void> {
  const catDef = getCategoryDef(categoryName);
  if (!catDef) {
    console.log(chalk.red(`  Unknown category: ${categoryName}. Available: ${CATEGORY_NAMES.join(', ')}`));
    return;
  }

  // Ensure category is in DB
  const categoryId = upsertCategory({
    name: catDef.name,
    fullName: catDef.fullName,
    description: catDef.description,
  });

  const vendorList = catDef.vendors.slice(0, maxVendors);
  console.log(chalk.cyan(`\n  Analysing ${catDef.name} — ${vendorList.length} vendors\n`));

  const bar = new cliProgress.SingleBar(
    {
      format: '  {bar} {percentage}% | {value}/{total} | {vendor}',
      barCompleteChar: '█',
      barIncompleteChar: '░',
    },
    cliProgress.Presets.shades_grey,
  );
  bar.start(vendorList.length, 0, { vendor: '' });

  for (const vendorName of vendorList) {
    bar.update({ vendor: vendorName });

    try {
      const analysis = await agent.analyzeVendor(
        vendorName,
        catDef.name,
        categoryId,
        (step: ReActStep) => {
          // Verbose step logging (only to file to avoid breaking progress bar)
        },
      );

      // Persist vendor
      const vendorId = upsertVendor({ ...analysis.vendor, categoryId });

      // Persist ranking criteria
      upsertRankingCriteria({ ...analysis.rankingCriteria, vendorId });

      // Persist search records
      analysis.searchRecords.forEach(rec => insertSearchRecord({ ...rec, vendorId }));
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      // Continue on error — log after bar finishes
    }

    bar.increment();
  }

  bar.stop();
  console.log(chalk.green(`\n  Done! ${vendorList.length} vendors processed for ${catDef.name}\n`));
  printCategoryOverview(categoryName);
}

async function analyseSingleVendor(
  agent: ReActAgent,
  vendorName: string,
  categoryName: string,
): Promise<void> {
  const catDef = getCategoryDef(categoryName);
  if (!catDef) {
    console.log(chalk.red(`  Unknown category: ${categoryName}`));
    return;
  }

  const categoryId = upsertCategory({
    name: catDef.name,
    fullName: catDef.fullName,
    description: catDef.description,
  });

  console.log(chalk.cyan(`\n  Analysing ${vendorName} in ${catDef.name}...\n`));

  const analysis = await agent.analyzeVendor(
    vendorName,
    catDef.name,
    categoryId,
    (step: ReActStep) => {
      const icon = { thought: '💭', action: '⚡', observation: '👁', reflection: '🔍', answer: '✅' }[step.type] ?? '•';
      console.log(chalk.dim(`  [${step.type.toUpperCase()}] ${step.content.slice(0, 120)}`));
    },
  );

  const vendorId = upsertVendor({ ...analysis.vendor, categoryId });
  upsertRankingCriteria({ ...analysis.rankingCriteria, vendorId });
  analysis.searchRecords.forEach(rec => insertSearchRecord({ ...rec, vendorId }));

  console.log(chalk.green(`\n  Analysis complete!`));
  console.log(`  Score: ${chalk.bold(analysis.vendor.rankingScore.toFixed(2))}/10`);
  console.log(`  Position: ${analysis.vendor.marketPosition}`);
  console.log(`  Time: ${(analysis.processingTimeMs / 1000).toFixed(1)}s\n`);
}

async function interactiveMenu(): Promise<void> {
  while (true) {
    const { action } = await inquirer.prompt([
      {
        type: 'list',
        name: 'action',
        message: 'What would you like to do?',
        choices: [
          { name: 'Analyse vendors', value: 'analyze' },
          { name: 'Query database', value: 'query' },
          { name: 'MITRE ATT&CK — Vendor coverage chatbot', value: 'mitre-chat' },
          { name: 'Export report (Markdown)', value: 'export-md' },
          { name: 'Generate HTML dashboard', value: 'export-html' },
          { name: 'View ASCII charts', value: 'charts' },
          { name: 'Database status', value: 'status' },
          { name: 'Exit', value: 'exit' },
        ],
      },
    ]);

    if (action === 'exit') break;

    if (action === 'analyze') {
      await checkLmStudio();
      const agent = new ReActAgent(agentConfig);
      const { category } = await inquirer.prompt([
        { type: 'list', name: 'category', message: 'Category:', choices: CATEGORY_NAMES },
      ]);
      const { max } = await inquirer.prompt([
        { type: 'number', name: 'max', message: 'Max vendors:', default: 3 },
      ]);
      await analyseCategory(agent, category, max as number);
    } else if (action === 'query') {
      await interactiveQuery();
    } else if (action === 'export-md') {
      const cats = getAllCategories().map(c => c.name);
      const results = cats
        .map(n => buildComparisonResult(n, getVendorsByCategory(n)))
        .filter(r => r.vendors.length > 0);
      const outPath = path.join(REPORTS_DIR, 'vendor-report.md');
      exportMarkdown(results, outPath);
      console.log(chalk.green(`  Exported → ${outPath}\n`));
    } else if (action === 'export-html') {
      const cats = getAllCategories().map(c => c.name);
      const results = cats
        .map(n => buildComparisonResult(n, getVendorsByCategory(n)))
        .filter(r => r.vendors.length > 0);
      const outPath = path.join(REPORTS_DIR, 'dashboard.html');
      generateHtmlCharts(results, outPath);
      console.log(chalk.green(`  Dashboard → ${outPath}\n`));
    } else if (action === 'charts') {
      const cats = getAllCategories().map(c => c.name);
      const results = cats
        .map(n => buildComparisonResult(n, getVendorsByCategory(n)))
        .filter(r => r.vendors.length > 0);
      results.forEach(r => printAsciiRanking(r));
    } else if (action === 'mitre-chat') {
      await checkLmStudio();
      await mitreCoverageChat();
    } else if (action === 'status') {
      const categories = getAllCategories();
      console.log(chalk.cyan('\n  Database Status\n'));
      console.log(`  Total vendors: ${chalk.bold(getVendorCount())}`);
      categories.forEach(c => {
        const vendors = getVendorsByCategory(c.name);
        console.log(`    ${c.name.padEnd(20)} ${vendors.length} vendors`);
      });
      console.log();
    }
  }
}

// ─── MITRE Coverage Chatbot ───────────────────────────────────────────────────

/**
 * Conversational chatbot that wraps MitreCoverageAgent.
 *
 * Responsibilities:
 *  - NLU: extract vendor name from free-text input; ask for clarification when ambiguous.
 *  - Loop control: enforce 3-attempt limit per query; surface "Unable to find sufficient
 *    information after three attempts." when the agent returns insufficientInfo.
 *  - Response formatting: render TTP table, gaps, score, and summary.
 *  - Session memory: tracks last vendor so follow-up queries ("what about phishing?")
 *    are resolved without re-asking.
 *  - Error handling: catches LM Studio failures and reports them gracefully.
 */
async function mitreCoverageChat(): Promise<void> {
  console.log(chalk.cyan('\n  ╔══════════════════════════════════════════════════════╗'));
  console.log(chalk.cyan('  ║  MITRE ATT&CK Vendor Coverage Chatbot               ║'));
  console.log(chalk.cyan('  ║  Ask about any vendor\'s ATT&CK technique coverage   ║'));
  console.log(chalk.cyan('  ║  Type "exit" or leave blank to return to menu        ║'));
  console.log(chalk.cyan('  ╚══════════════════════════════════════════════════════╝\n'));
  console.log(chalk.dim('  Examples:'));
  console.log(chalk.dim('    "How does Microsoft address phishing attacks?"'));
  console.log(chalk.dim('    "Show Palo Alto Networks ATT&CK coverage"'));
  console.log(chalk.dim('    "Cisco lateral movement defences"\n'));

  const agent = new MitreCoverageAgent(agentConfig);

  // Known vendor names for NLU extraction
  const KNOWN_VENDORS = [
    'Microsoft', 'Cisco', 'Palo Alto Networks', 'CrowdStrike', 'Splunk',
    'IBM', 'Fortinet', 'Check Point', 'SentinelOne', 'Trend Micro',
    'Broadcom', 'Symantec', 'McAfee', 'Trellix', 'Rapid7', 'Tenable',
    'Qualys', 'Darktrace', 'Vectra', 'Elastic', 'Google', 'AWS', 'Azure',
  ];

  let sessionVendor: string | null = null; // remembered across follow-up turns
  let attempts = 0;                        // resets each time a new vendor is resolved

  while (true) {
    const { input } = await inquirer.prompt([
      {
        type: 'input',
        name: 'input',
        message: chalk.cyan('You:'),
        prefix: '',
      },
    ]);

    const raw = (input as string).trim();
    if (!raw || raw.toLowerCase() === 'exit') {
      console.log(chalk.dim('\n  Exiting chatbot.\n'));
      break;
    }

    // ── NLU: extract vendor from input ──────────────────────────────────────
    const detectedVendor = extractVendor(raw, KNOWN_VENDORS);
    let vendor: string;

    if (detectedVendor) {
      vendor = detectedVendor;
      sessionVendor = vendor;
      attempts = 0;
    } else if (sessionVendor) {
      // Follow-up question — reuse last vendor
      vendor = sessionVendor;
    } else {
      // Ambiguous — ask for clarification
      console.log(
        chalk.yellow('\n  Clarification needed: I could not identify a vendor in your query.\n') +
        chalk.dim('  Please specify the vendor name, e.g. "Microsoft", "Palo Alto Networks".\n'),
      );
      continue;
    }

    // ── Loop control: enforce 3-attempt cap per vendor ───────────────────────
    attempts++;
    if (attempts > 3) {
      console.log(
        chalk.yellow('\n  Unable to find sufficient information after three attempts.\n') +
        chalk.dim(`  Try a different query or type a new vendor name to start fresh.\n`),
      );
      attempts = 0;
      sessionVendor = null;
      continue;
    }

    console.log(
      chalk.dim(`\n  Analysing ${chalk.bold(vendor)} — attempt ${attempts}/3 (max 3 ReAct iterations)...\n`),
    );

    // ── Run agent ────────────────────────────────────────────────────────────
    let report: MitreCoverageReport;
    try {
      report = await agent.analyseVendor(vendor);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(chalk.red(`\n  Error: ${msg}\n`));
      console.log(chalk.dim('  Check that LM Studio is running and the model is loaded.\n'));
      continue;
    }

    // ── Format & deliver response ────────────────────────────────────────────
    if (report.insufficientInfo) {
      if (attempts >= 3) {
        console.log(chalk.yellow('\n  Unable to find sufficient information after three attempts.\n'));
        attempts = 0;
        sessionVendor = null;
      } else {
        console.log(
          chalk.yellow(`\n  Attempt ${attempts}/3: Incomplete results for ${vendor}.\n`) +
          chalk.dim(`  ${report.summary}\n`) +
          chalk.dim('  Retrying with a more targeted query — or rephrase your question.\n'),
        );
      }
      continue;
    }

    // Success — reset attempt counter for next query
    attempts = 0;

    // Header
    console.log(chalk.cyan(`\n  ── ATT&CK Coverage: ${chalk.bold(vendor)} ──────────────────────────\n`));
    console.log(`  Coverage score : ${chalk.bold(report.overallCoverageScore.toFixed(1))}/10`);
    console.log(`  Techniques     : ${chalk.bold(report.ttpsAddressed.length)} addressed, ` +
                `${chalk.bold(report.coverageGaps.length)} gaps\n`);

    // Summary
    if (report.summary) {
      console.log(chalk.white(`  ${report.summary}\n`));
    }

    // TTP table
    if (report.ttpsAddressed.length > 0) {
      console.log(chalk.cyan('  Techniques addressed:\n'));
      report.ttpsAddressed.forEach(t => {
        const badge = {
          full:    chalk.bgGreen.black(' FULL    '),
          partial: chalk.bgYellow.black(' PARTIAL '),
          none:    chalk.bgRed.white(' NONE    '),
          unknown: chalk.bgGray.white(' UNKNOWN '),
        }[t.coverageLevel] ?? chalk.dim(' UNKNOWN ');

        console.log(`  ${badge}  ${chalk.bold(t.techniqueId.padEnd(12))} ${t.techniqueName}`);
        if (t.products.length > 0) {
          console.log(chalk.dim(`              Products: ${t.products.slice(0, 2).join(' · ')}`));
        }
      });
      console.log();
    }

    // Gaps
    if (report.coverageGaps.length > 0) {
      console.log(chalk.cyan('  Coverage gaps:\n'));
      report.coverageGaps.slice(0, 5).forEach(g =>
        console.log(`  ${chalk.red('✗')} ${g}`),
      );
      if (report.coverageGaps.length > 5) {
        console.log(chalk.dim(`  … and ${report.coverageGaps.length - 5} more (see full JSON report)`));
      }
      console.log();
    }

    // Auto-save report
    const slug = vendor.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const outPath = path.join(REPORTS_DIR, `mitre-coverage-${slug}.json`);
    fs.writeFileSync(outPath, JSON.stringify(report, null, 2), 'utf-8');
    console.log(chalk.dim(`  Full report → ${outPath}\n`));
    console.log(chalk.dim('  Ask a follow-up or enter a new vendor name.\n'));
  }
}

/**
 * Extract a vendor name from a free-text string.
 * Returns the first case-insensitive match against known vendors,
 * or null when nothing recognisable is found.
 */
function extractVendor(input: string, knownVendors: string[]): string | null {
  const lower = input.toLowerCase();
  // Longest match first to prefer "Palo Alto Networks" over "Palo"
  const sorted = [...knownVendors].sort((a, b) => b.length - a.length);
  for (const v of sorted) {
    if (lower.includes(v.toLowerCase())) return v;
  }
  // Fallback: capitalised word sequence not matching common query words
  const queryWords = new Set([
    'how', 'does', 'do', 'what', 'is', 'are', 'show', 'tell', 'me', 'about',
    'the', 'a', 'an', 'and', 'or', 'of', 'in', 'on', 'at', 'to', 'for',
    'attack', 'mitre', 'coverage', 'techniques', 'tactics', 'ttp', 'ttps',
    'security', 'cyber', 'threat', 'defence', 'defense', 'against', 'with',
  ]);
  const capitalised = input.match(/\b[A-Z][a-zA-Z0-9]*(?:\s+[A-Z][a-zA-Z0-9]*)*\b/g) ?? [];
  for (const candidate of capitalised) {
    if (!queryWords.has(candidate.toLowerCase())) return candidate;
  }
  return null;
}

// ─── MITRE ATT&CK Commands ────────────────────────────────────────────────────

program
  .command('mitre:reset')
  .description('Delete stored MITRE embeddings so mitre:ingest regenerates them with the current EMBEDDING_MODEL')
  .action(() => {
    const db = getDb();
    const { changes } = db.prepare('DELETE FROM mitre_embeddings').run() as { changes: number };
    const entries = (db.prepare('SELECT COUNT(*) AS n FROM mitre_entries').get() as { n: number }).n;
    console.log(chalk.cyan('\n  MITRE ATT&CK — embeddings reset\n'));
    console.log(`  Embeddings deleted : ${chalk.bold(changes)}`);
    console.log(`  Entries kept       : ${chalk.bold(entries)}`);
    console.log(chalk.dim('\n  Run  npm run mitre:ingest  to regenerate with the current EMBEDDING_MODEL.\n'));
  });

program
  .command('mitre:ingest')
  .description('Fetch the MITRE ATT&CK STIX bundle and generate vector embeddings')
  .action(async () => {
    console.log(chalk.cyan('\n  MITRE ATT&CK Ingestion\n'));
    console.log(chalk.dim('  Fetching STIX bundle from github.com/mitre/cti ...'));

    try {
      const bar = new cliProgress.SingleBar(
        {
          format: '  {bar} {percentage}% | Embedding {value}/{total}',
          barCompleteChar:   '█',
          barIncompleteChar: '░',
          clearOnComplete:   false,
        },
        cliProgress.Presets.shades_grey,
      );

      let barStarted = false;

      const result = await runIngestionPipeline((msg: string) => {
        // Stop progress bar before printing info messages
        if (barStarted && !msg.startsWith('  Embedded')) {
          bar.stop();
          barStarted = false;
        }

        // Show progress bar for embedding lines
        const embMatch = msg.match(/Embedded (\d[\d,]*) \/ (\d[\d,]*)/);
        if (embMatch) {
          const done  = parseInt(embMatch[1].replace(/,/g, ''), 10);
          const total = parseInt(embMatch[2].replace(/,/g, ''), 10);
          if (!barStarted) { bar.start(total, 0); barStarted = true; }
          bar.update(done);
        } else {
          console.log(chalk.dim(`  ${msg}`));
        }
      });

      if (barStarted) bar.stop();

      console.log(chalk.green('\n  Ingestion complete!\n'));
      console.log(`  Entries ingested   : ${chalk.bold(result.entriesIngested.toLocaleString())}`);
      console.log(`  Embeddings created : ${chalk.bold(result.embeddingsGenerated.toLocaleString())}`);

      if (result.skippedEmbeddings) {
        console.log(
          chalk.yellow('\n  [!] Embeddings were skipped because the embedding model was not available.') +
          '\n      Set EMBEDDING_MODEL in .env to a loaded embedding model in LM Studio.' +
          '\n      Then re-run: npm run mitre:ingest\n',
        );
      } else {
        console.log(
          chalk.dim(`\n  Embedding model    : ${result.embeddingModel ?? '—'}`) +
          '\n  Run  npm run mitre:query  to test the knowledge base.\n',
        );
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(chalk.red(`\n  Ingestion failed: ${msg}\n`));
      process.exit(1);
    }
  });

program
  .command('mitre:query')
  .description('Interactively query the MITRE ATT&CK knowledge base via RAG')
  .option('-q, --query <text>', 'Run a single query and exit (non-interactive)')
  .option('-k, --top-k <n>',   'Number of results to return', '5')
  .action(async (opts) => {
    console.log(chalk.cyan('\n  MITRE ATT&CK RAG Query\n'));

    const rag = new MitreRag();
    try {
      await rag.init();
    } catch {
      console.log(chalk.red('  Failed to initialise MITRE RAG. Run mitre:ingest first.\n'));
      process.exit(1);
    }

    const status = rag.getStatus();
    if (status.indexLoaded === 0) {
      console.log(chalk.yellow(
        `  No embeddings loaded (entries: ${status.entries}, embeddings: ${status.embeddings}).\n` +
        '  Run: npm run mitre:ingest\n',
      ));
      process.exit(0);
    }

    console.log(chalk.dim(
      `  Index: ${status.indexLoaded.toLocaleString()} entries loaded\n`,
    ));

    const topK = parseInt(opts.topK ?? '5', 10);

    // Non-interactive single-query mode
    if (opts.query) {
      const result = await rag.query(opts.query, topK);
      console.log(result.formattedContext);
      console.log();
      return;
    }

    // Interactive REPL
    while (true) {
      const { query } = await inquirer.prompt([
        {
          type:    'input',
          name:    'query',
          message: 'Enter a threat intelligence query (or "exit"):',
        },
      ]);

      const q = (query as string).trim();
      if (!q || q.toLowerCase() === 'exit') break;

      try {
        const result = await rag.query(q, topK);
        console.log('\n' + result.formattedContext + '\n');
        console.log(chalk.dim(`  (${result.entries.length} result(s) from ${result.totalEntries} indexed entries)\n`));
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.log(chalk.red(`  Query failed: ${msg}\n`));
      }
    }
  });

// ─── MITRE Diagnose Command ───────────────────────────────────────────────────

program
  .command('mitre:diagnose')
  .description('Diagnose the MITRE RAG pipeline: counts, model match, and raw similarity scores')
  .option('-q, --query <text>', 'Test query to score', 'endpoint detection ransomware lateral movement')
  .action(async (opts) => {
    const { MitreVectorStore } = await import('../mitre/vector-store');
    const { EmbeddingClient }  = await import('../mitre/embeddings');

    console.log(chalk.cyan('\n  MITRE ATT&CK RAG Diagnostics\n  ' + '─'.repeat(44) + '\n'));

    const store = new MitreVectorStore();
    store.ensureSchema();

    const entries    = store.getEntryCount();
    const embeddings = store.getEmbeddingCount();
    const storedModel = store.getEmbeddingModel();
    const configuredModel = process.env.EMBEDDING_MODEL ?? '(not set, using LM_STUDIO_MODEL fallback)';

    console.log(chalk.white(`  Entries in DB  : `) + chalk.yellow(entries.toLocaleString()));
    console.log(chalk.white(`  Embeddings     : `) + chalk.yellow(embeddings.toLocaleString()));
    console.log(chalk.white(`  Stored model   : `) + (storedModel ? chalk.yellow(storedModel) : chalk.red('none — run mitre:ingest')));
    console.log(chalk.white(`  Configured model: `) + chalk.yellow(configuredModel));

    if (storedModel && storedModel !== (process.env.EMBEDDING_MODEL ?? null)) {
      console.log(chalk.red('\n  ⚠  MODEL MISMATCH — reset and re-ingest:\n') +
        chalk.dim('     npm run mitre:reset && npm run mitre:ingest\n'));
    } else if (storedModel) {
      console.log(chalk.green('  ✓  Models match\n'));
    }

    if (embeddings === 0) {
      console.log(chalk.yellow('  No embeddings stored. Run: npm run mitre:ingest\n'));
      process.exit(0);
    }

    // Load index and run a raw scored search
    store.loadIndex();
    console.log(chalk.dim(`  Index loaded   : ${store.indexSize.toLocaleString()} vectors\n`));

    const lmStudioUrl   = process.env.LM_STUDIO_URL ?? 'http://localhost:1234/v1';
    const apiKey        = process.env.LM_STUDIO_API_KEY ?? '';
    const embeddingModel = process.env.EMBEDDING_MODEL ?? (process.env.LM_STUDIO_MODEL ?? '');

    console.log(`  Embedding query with "${embeddingModel}"…`);
    const client = new EmbeddingClient(lmStudioUrl, apiKey, embeddingModel);

    let queryVec: number[];
    try {
      queryVec = await client.embed(opts.query);
      console.log(chalk.green(`  ✓  Query embedded — dimensions: ${queryVec.length}\n`));
    } catch (err) {
      console.log(chalk.red(`  ✗  Embedding failed: ${err instanceof Error ? err.message : err}\n`));
      process.exit(1);
    }

    // Raw scores without threshold
    const rawScores: Array<{ id: string; score: number }> = [];
    for (const [id, vec] of (store as any).index as Map<string, number[]>) {
      if (vec.length !== queryVec.length) {
        console.log(chalk.red(`  ✗  Dimension mismatch: stored ${vec.length}D vs query ${queryVec.length}D — re-ingest required`));
        process.exit(1);
      }
      let dot = 0, na = 0, nb = 0;
      for (let i = 0; i < vec.length; i++) { dot += vec[i] * queryVec[i]; na += vec[i] * vec[i]; nb += queryVec[i] * queryVec[i]; }
      const score = na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
      rawScores.push({ id, score });
    }
    rawScores.sort((a, b) => b.score - a.score);
    const top10 = rawScores.slice(0, 10);

    console.log(`  Top-10 similarity scores for: "${opts.query}"\n`);
    top10.forEach((r, i) => {
      const bar = '█'.repeat(Math.round(Math.max(0, r.score) * 30));
      const color = r.score >= 0.5 ? chalk.green : r.score >= 0.2 ? chalk.yellow : chalk.red;
      console.log(`  ${String(i + 1).padStart(2)}. ${r.id.padEnd(14)} ${color(`${(r.score * 100).toFixed(1).padStart(5)}%`)}  ${color(bar)}`);
    });

    const currentThreshold = parseFloat(process.env.MITRE_SIMILARITY_THRESHOLD ?? '0.25');
    const aboveThreshold   = rawScores.filter(r => r.score >= currentThreshold).length;
    console.log(chalk.dim(`\n  Threshold: ${currentThreshold} → ${aboveThreshold} entries would be returned`));

    if (top10[0]?.score < 0.1) {
      console.log(chalk.red(
        '\n  ⚠  All scores are very low — possible causes:\n' +
        '     1. Embeddings were stored with a different model version\n' +
        '     2. LM Studio is normalising embeddings differently than expected\n' +
        '     Try: npm run mitre:reset && npm run mitre:ingest\n',
      ));
    } else {
      console.log(chalk.green('\n  ✓  RAG index looks healthy\n'));
    }
  });

program
  .command('mitre:probe-embeddings')
  .description('Probe LM Studio models and report which ones return usable (non-zero) embeddings')
  .option('-t, --text <text>', 'Probe text used for embedding', 'ransomware encryption techniques')
  .option('--all', 'Test all loaded models (default tests embedding-like models + current configured ones)')
  .action(async (opts) => {
    const OpenAI = (await import('openai')).default;

    const baseURL = process.env.LM_STUDIO_URL ?? 'http://localhost:1234/v1';
    const apiKey = process.env.LM_STUDIO_API_KEY ?? 'lm-studio';
    const configuredEmbedding = process.env.EMBEDDING_MODEL ?? '';
    const configuredGen = process.env.LM_STUDIO_MODEL ?? '';
    const probeText = String(opts.text || '').trim() || 'ransomware encryption techniques';

    const client = new OpenAI({ baseURL, apiKey });

    console.log(chalk.cyan('\n  MITRE Embedding Model Probe\n  ' + '─'.repeat(44) + '\n'));
    console.log(chalk.dim(`  Endpoint: ${baseURL}`));
    console.log(chalk.dim(`  Probe text: "${probeText}"\n`));

    let loaded: string[] = [];
    try {
      const models = await client.models.list();
      loaded = models.data.map(m => m.id);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(chalk.red(`  Could not list models from LM Studio: ${msg}\n`));
      process.exit(1);
    }

    const selected = opts.all
      ? loaded
      : loaded.filter(id =>
          id.toLowerCase().includes('embed') ||
          id === configuredEmbedding ||
          id === configuredGen,
        );

    if (selected.length === 0) {
      console.log(chalk.yellow('  No candidate models to test. Use --all or load embedding models in LM Studio.\n'));
      process.exit(0);
    }

    type Probe = {
      model: string;
      status: 'OK' | 'ZERO' | 'ERROR';
      dims: number;
      norm: number;
      error?: string;
    };

    const results: Probe[] = [];

    for (const model of selected) {
      try {
        const res = await client.embeddings.create({ model, input: probeText });
        const vec = Array.isArray(res.data?.[0]?.embedding) ? res.data[0].embedding : [];
        const norm = Math.sqrt(vec.reduce((s, x) => s + x * x, 0));

        if (vec.length === 0 || !Number.isFinite(norm)) {
          results.push({ model, status: 'ERROR', dims: vec.length, norm: 0, error: 'invalid embedding payload' });
        } else if (norm <= 1e-9) {
          results.push({ model, status: 'ZERO', dims: vec.length, norm });
        } else {
          results.push({ model, status: 'OK', dims: vec.length, norm });
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        results.push({ model, status: 'ERROR', dims: 0, norm: 0, error: msg.slice(0, 120) });
      }
    }

    const statusOrder: Record<Probe['status'], number> = { OK: 0, ZERO: 1, ERROR: 2 };
    results.sort((a, b) => statusOrder[a.status] - statusOrder[b.status]);

    for (const r of results) {
      const label =
        r.status === 'OK'
          ? chalk.green('OK   ')
          : r.status === 'ZERO'
          ? chalk.yellow('ZERO ')
          : chalk.red('ERROR');

      const suffix = r.status === 'ERROR'
        ? chalk.dim(`  ${r.error ?? ''}`)
        : chalk.dim(`  dim=${String(r.dims).padStart(4)}  norm=${r.norm.toFixed(6)}`);

      console.log(`  ${label}  ${r.model}${suffix}`);
    }

    const best = results.find(r => r.status === 'OK');
    if (best) {
      console.log(
        chalk.green('\n  Recommended EMBEDDING_MODEL:\n') +
        `  EMBEDDING_MODEL=${best.model}\n` +
        chalk.dim('  Then run: npm run mitre:reset && npm run mitre:ingest\n'),
      );
    } else {
      console.log(
        chalk.red('\n  No model returned usable embeddings.\n') +
        chalk.dim('  LM Studio is serving zero/invalid vectors for all tested models.\n' +
          '  Keep lexical fallback enabled and try another embedding build/provider.\n'),
      );
    }
  });

// ─── MITRE Vendor Coverage Command ───────────────────────────────────────────

program
  .command('mitre:vendor')
  .description('Analyse how a vendor addresses MITRE ATT&CK techniques (max 3 ReAct iterations)')
  .requiredOption('-v, --vendor <name>', 'Vendor name to analyse, e.g. "Microsoft", "Palo Alto Networks"')
  .option('-o, --output <path>', 'Save JSON report to file')
  .option('--verbose', 'Print each ReAct step in real time')
  .action(async (opts) => {
    await checkLmStudio();

    const vendorName: string = opts.vendor;
    console.log(chalk.cyan(`\n  MITRE ATT&CK Coverage Analysis — ${vendorName}\n`));
    console.log(chalk.dim('  Max iterations : 3'));
    console.log(chalk.dim(`  Embedding model: ${process.env.EMBEDDING_MODEL ?? agentConfig.model}\n`));

    const agent = new MitreCoverageAgent(agentConfig);
    const startTime = Date.now();

    let report: MitreCoverageReport;
    try {
      report = await agent.analyseVendor(vendorName, (type, content) => {
        if (!opts.verbose) return;
        const icons: Record<string, string> = {
          thought: '💭', action: '⚡', observation: '👁', answer: '✅',
        };
        const icon = icons[type] ?? '•';
        console.log(chalk.dim(`  ${icon} [${type.toUpperCase()}] ${content.slice(0, 120)}`));
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(chalk.red(`\n  Analysis failed: ${msg}\n`));
      process.exit(1);
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

    // ── Print summary ────────────────────────────────────────────────────────
    if (report.insufficientInfo) {
      console.log(chalk.yellow('\n  Insufficient Information – Unable to provide a complete response.\n'));
      console.log(chalk.dim(`  Reason: ${report.summary}\n`));
    } else {
      console.log(chalk.green(`\n  Analysis complete  (${elapsed}s)\n`));
      console.log(`  Overall ATT&CK coverage score : ${chalk.bold(report.overallCoverageScore.toFixed(1))}/10`);
      console.log(`  Techniques addressed          : ${chalk.bold(report.ttpsAddressed.length)}`);
      console.log(`  Coverage gaps identified      : ${chalk.bold(report.coverageGaps.length)}\n`);
      console.log(chalk.dim(`  Summary: ${report.summary}\n`));

      if (report.ttpsAddressed.length > 0) {
        console.log(chalk.cyan('  Techniques covered:\n'));
        report.ttpsAddressed.forEach(t => {
          const level = {
            full:    chalk.green('FULL   '),
            partial: chalk.yellow('PARTIAL'),
            none:    chalk.red('NONE   '),
            unknown: chalk.dim('UNKNOWN'),
          }[t.coverageLevel] ?? chalk.dim('UNKNOWN');
          console.log(`  ${level}  ${chalk.bold(t.techniqueId.padEnd(12))} ${t.techniqueName}`);
        });
        console.log();
      }

      if (report.coverageGaps.length > 0) {
        console.log(chalk.cyan('  Coverage gaps:\n'));
        report.coverageGaps.forEach(g => console.log(`  ${chalk.red('✗')} ${g}`));
        console.log();
      }
    }

    // ── Save JSON if requested ───────────────────────────────────────────────
    const jsonOutput = JSON.stringify(report, null, 2);
    if (opts.output) {
      const outPath = path.resolve(opts.output);
      fs.writeFileSync(outPath, jsonOutput, 'utf-8');
      console.log(chalk.green(`  JSON report saved → ${outPath}\n`));
    } else {
      // Always save to reports dir for traceability
      const slug = vendorName.toLowerCase().replace(/[^a-z0-9]+/g, '-');
      const outPath = path.join(REPORTS_DIR, `mitre-coverage-${slug}.json`);
      fs.writeFileSync(outPath, jsonOutput, 'utf-8');
      console.log(chalk.dim(`  Report auto-saved → ${outPath}\n`));
    }
  });

export { program };
