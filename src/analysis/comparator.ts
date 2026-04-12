import { VendorWithCriteria, ComparisonResult, ChartDataPoint } from '../types';
import { rankVendors, vendorScoreChartData, scoreToLabel, getRankingCriteriaMetadataForCategory } from './ranking';

/**
 * Builds a full comparison result for a category.
 */
export function buildComparisonResult(
  categoryName: string,
  vendors: VendorWithCriteria[],
): ComparisonResult {
  const ranked = rankVendors(vendors);
  const scores = ranked.map(v => v.rankingScore);
  const avg = scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;

  return {
    categoryName,
    vendors: ranked,
    topVendor: ranked[0]?.name ?? 'N/A',
    averageScore: parseFloat(avg.toFixed(2)),
    scoreDistribution: vendorScoreChartData(vendors),
  };
}

/**
 * Compare two specific vendors side-by-side across all criteria.
 */
export function compareTwoVendors(
  a: VendorWithCriteria,
  b: VendorWithCriteria,
): Array<{ criterion: string; scoreA: number; scoreB: number; winner: string }> {
  const metadata = getRankingCriteriaMetadataForCategory(a.categoryName || b.categoryName);
  return metadata.map(({ key, label }) => {
    const scoreA = (a.criteria as any)?.[key] ?? 0;
    const scoreB = (b.criteria as any)?.[key] ?? 0;
    const winner = scoreA > scoreB ? a.name : scoreB > scoreA ? b.name : 'Tie';
    return { criterion: label, scoreA, scoreB, winner };
  });
}

/**
 * Generates ASCII bar chart string for terminal rendering.
 */
export function asciiBarChart(data: ChartDataPoint[], width = 50): string {
  if (data.length === 0) return '(no data)';

  const maxVal = Math.max(...data.map(d => d.value), 10);
  const maxLabelLen = Math.max(...data.map(d => d.label.length));

  const lines: string[] = [];
  data.forEach(({ label, value }) => {
    const barLen = Math.round((value / maxVal) * width);
    const bar = '█'.repeat(barLen) + '░'.repeat(width - barLen);
    const paddedLabel = label.padEnd(maxLabelLen);
    lines.push(`${paddedLabel} │ ${bar} ${value.toFixed(1)}`);
  });

  return lines.join('\n');
}

/**
 * Summary statistics for a list of vendors.
 */
export function categoryStats(vendors: VendorWithCriteria[]): {
  count: number;
  topScore: number;
  lowestScore: number;
  averageScore: number;
  label: string;
} {
  if (vendors.length === 0) {
    return { count: 0, topScore: 0, lowestScore: 0, averageScore: 0, label: 'No data' };
  }
  const scores = vendors.map(v => v.rankingScore);
  const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
  return {
    count: vendors.length,
    topScore: Math.max(...scores),
    lowestScore: Math.min(...scores),
    averageScore: parseFloat(avg.toFixed(2)),
    label: scoreToLabel(avg),
  };
}
