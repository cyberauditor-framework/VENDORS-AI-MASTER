import chalk from 'chalk';
import { program } from './cli/main';

console.log(
  chalk.cyan('\n  ╔═══════════════════════════════════════╗') +
  '\n' +
  chalk.cyan('  ║ ') + chalk.bold('Vendors AI Master') + chalk.cyan('                  ║') +
  '\n' +
  chalk.cyan('  ║ ') + chalk.dim('AI & Cybersecurity Vendor Analysis') + chalk.cyan(' ║') +
  '\n' +
  chalk.cyan('  ╚═══════════════════════════════════════╝\n'),
);

program.parseAsync(process.argv).catch(err => {
  console.error(chalk.red('\n  Fatal error:'), err instanceof Error ? err.message : err);
  process.exit(1);
});
