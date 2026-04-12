import chalk from 'chalk';
import Table from 'cli-table3';
import inquirer from 'inquirer';
import { VendorWithCriteria, QueryFilter, AcquisitionMode, MarketPosition, GeographicRegion } from '../types';
import {
  queryVendors,
  getAllCategories,
  getVendorsByCategory,
} from '../database/repository';
import { buildComparisonResult } from '../analysis/comparator';
import { printAsciiRanking } from '../export/chart-generator';
import { CATEGORY_NAMES } from '../data/categories';

// ─── Interactive Query ─────────────────────────────────────────────────────────

export async function interactiveQuery(): Promise<void> {
  console.log(chalk.cyan('\n  Query the vendor database\n'));

  const { category } = await inquirer.prompt([
    {
      type: 'list',
      name: 'category',
      message: 'Select a category (or All):',
      choices: ['-- All Categories --', ...CATEGORY_NAMES],
    },
  ]);

  const { minScore } = await inquirer.prompt([
    {
      type: 'number',
      name: 'minScore',
      message: 'Minimum score (0–10, 0 = no filter):',
      default: 0,
    },
  ]);

  const { sortBy } = await inquirer.prompt([
    {
      type: 'list',
      name: 'sortBy',
      message: 'Sort by:',
      choices: ['score', 'name', 'founded', 'category'],
      default: 'score',
    },
  ]);

  const filter: QueryFilter = {
    category: category.startsWith('--') ? undefined : category,
    minScore: minScore > 0 ? minScore : undefined,
    sortBy: sortBy as QueryFilter['sortBy'],
    sortOrder: 'desc',
  };

  const vendors = queryVendors(filter);
  renderVendorTable(vendors);
}

// ─── Table Renderer ───────────────────────────────────────────────────────────

export function renderVendorTable(vendors: VendorWithCriteria[]): void {
  if (vendors.length === 0) {
    console.log(chalk.yellow('\n  No vendors found matching the criteria.\n'));
    return;
  }

  const table = new Table({
    head: [
      chalk.bold('Rank'),
      chalk.bold('Vendor'),
      chalk.bold('Category'),
      chalk.bold('Score'),
      chalk.bold('Position'),
      chalk.bold('Region'),
      chalk.bold('Mode'),
    ],
    style: { head: [], border: [] },
    colWidths: [6, 30, 18, 8, 14, 18, 14],
  });

  vendors.forEach((v, i) => {
    const scoreColour = v.rankingScore >= 8 ? chalk.green : v.rankingScore >= 6 ? chalk.yellow : chalk.red;
    table.push([
      String(i + 1),
      v.name,
      v.categoryName ?? '',
      scoreColour(v.rankingScore.toFixed(2)),
      v.marketPosition,
      v.geographicRegion,
      v.acquisitionMode,
    ]);
  });

  console.log('\n' + table.toString() + '\n');
  console.log(chalk.dim(`  ${vendors.length} vendor(s) found.\n`));
}

// ─── Category Overview ─────────────────────────────────────────────────────────

export function printCategoryOverview(categoryName: string): void {
  const vendors = getVendorsByCategory(categoryName);
  if (vendors.length === 0) {
    console.log(chalk.yellow(`\n  No data for category "${categoryName}" yet. Run: analyze --category ${categoryName}\n`));
    return;
  }
  const result = buildComparisonResult(categoryName, vendors);
  printAsciiRanking(result);
  renderVendorTable(vendors);
}
