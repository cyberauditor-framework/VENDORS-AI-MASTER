import * as fs from 'fs';
import * as path from 'path';
import { VendorWithCriteria, ComparisonResult } from '../types';
import {
  rankVendors,
  scoreToLabel,
  getRankingWeightsForCategory,
  getRankingCriteriaMetadataForCategory,
} from '../analysis/ranking';
import { categoryStats } from '../analysis/comparator';

const REPORT_HEADER = `# Cybersecurity & AI Vendor Knowledge Base

> Generated: ${new Date().toISOString().split('T')[0]}  
> Tool: Vendors AI Master  

---

`;

/**
 * Exports all comparison results to a single Markdown file.
 */
export function exportMarkdown(
  results: ComparisonResult[],
  outputPath: string,
  includeRawAnalysis = false,
): void {
  const dir = path.dirname(outputPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  let md = REPORT_HEADER;

  // Table of contents
  md += '## Table of Contents\n\n';
  results.forEach(r => {
    const anchor = r.categoryName.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    md += `- [${r.categoryName}](#${anchor})\n`;
  });
  md += '\n---\n\n';

  // Per-category sections
  results.forEach(result => {
    md += buildCategorySection(result, includeRawAnalysis);
    md += '\n---\n\n';
  });

  fs.writeFileSync(outputPath, md, 'utf-8');
}

/**
 * Exports a single category to a Markdown file.
 */
export function exportCategoryMarkdown(
  result: ComparisonResult,
  outputPath: string,
): void {
  const dir = path.dirname(outputPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(outputPath, REPORT_HEADER + buildCategorySection(result, false), 'utf-8');
}

// ─── Internal Builders ────────────────────────────────────────────────────────

function buildCategorySection(result: ComparisonResult, includeRaw: boolean): string {
  const stats = categoryStats(result.vendors);
  const ranked = rankVendors(result.vendors);
  let md = '';

  md += `## ${result.categoryName}\n\n`;
  md += `| Stat | Value |\n|---|---|\n`;
  md += `| Vendors analysed | ${stats.count} |\n`;
  md += `| Top vendor | **${result.topVendor}** |\n`;
  md += `| Average score | ${stats.averageScore}/10 (${stats.label}) |\n`;
  md += `| Top score | ${stats.topScore}/10 |\n`;
  md += `| Lowest score | ${stats.lowestScore}/10 |\n\n`;

  // Rankings table
  md += `### Rankings\n\n`;
  md += `| Rank | Vendor | Score | Position | Region | Acquisition |\n`;
  md += `|------|--------|-------|----------|--------|-------------|\n`;
  ranked.forEach((v, i) => {
    md += `| ${i + 1} | ${v.name} | ${v.rankingScore.toFixed(2)} | ${v.marketPosition} | ${v.geographicRegion} | ${v.acquisitionMode} |\n`;
  });
  md += '\n';

  // Detailed vendor cards
  md += `### Vendor Profiles\n\n`;
  ranked.forEach(v => {
    md += buildVendorCard(v, includeRaw);
  });

  return md;
}

function buildVendorCard(v: VendorWithCriteria, includeRaw: boolean): string {
  let md = `#### ${v.name}\n\n`;

  if (v.website) md += `**Website:** [${v.website}](${v.website})  \n`;
  if (v.foundedYear) md += `**Founded:** ${v.foundedYear}  \n`;
  md += `**Score:** ${v.rankingScore.toFixed(2)}/10 — ${scoreToLabel(v.rankingScore)}  \n`;
  md += `**Market Position:** ${v.marketPosition}  \n`;
  md += `**Region:** ${v.geographicRegion}  \n`;
  md += `**Acquisition Mode:** ${v.acquisitionMode}  \n`;
  md += `**Pricing:** ${v.pricingModel || 'N/A'}  \n\n`;

  if (v.description) md += `${v.description}\n\n`;

  if (v.advantages.length > 0) {
    md += `**Advantages:**\n`;
    v.advantages.forEach(a => (md += `- ${a}\n`));
    md += '\n';
  }

  if (v.disadvantages.length > 0) {
    md += `**Disadvantages:**\n`;
    v.disadvantages.forEach(d => (md += `- ${d}\n`));
    md += '\n';
  }

  if (v.securityCertifications.length > 0) {
    md += `**Security Certifications:** ${v.securityCertifications.join(', ')}  \n\n`;
  }

  if (v.awards.length > 0) {
    md += `**Awards & Recognition:**\n`;
    v.awards.forEach(a => (md += `- ${a}\n`));
    md += '\n';
  }

  if (v.criteria) {
    const metadata = getRankingCriteriaMetadataForCategory(v.categoryName);
    const weights = getRankingWeightsForCategory(v.categoryName);

    md += `**Criteria Scores:**\n\n`;
    md += `| Criterion | Category | Score | Weight | Justification |\n|-----------|----------|-------|--------|---------------|\n`;
    metadata.forEach(({ key, label, category }) => {
      const score = (v.criteria as any)[key] ?? 0;
      const weight = ((weights as any)[key] * 100).toFixed(0);
      const rationale = ((v.rationale as any)?.[key] ?? 'No justification provided').replace(/\|/g, '/');
      md += `| ${label} | ${category} | ${score}/10 | ${weight}% | ${rationale} |\n`;
    });
    md += '\n';

    const evidence = v.criterionEvidence ?? {};
    md += `**Validated Evidence by Criterion:**\n`;
    metadata.forEach(({ key, label }) => {
      const links = Array.isArray((evidence as any)[key]) ? (evidence as any)[key] as string[] : [];
      md += `- ${label}:\n`;
      if (links.length === 0) {
        md += `  - No validated source links captured for this criterion.\n`;
      } else {
        links.forEach(link => {
          md += `  - ${link}\n`;
        });
      }
    });
    md += '\n';
  }

  if (v.resourceLinks.length > 0) {
    md += `**Resources:**\n`;
    v.resourceLinks.slice(0, 5).forEach(link => (md += `- ${link}\n`));
    md += '\n';
  }

  md += `---\n\n`;
  return md;
}
