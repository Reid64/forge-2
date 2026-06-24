// FORGE 2.0 CLI — Learning Engine Commands
import { Command } from 'commander';
import chalk from 'chalk';
import { existsSync, statSync } from 'node:fs';
import { initializeForgeMemory, getConnection, getForgeDbPath, getMachineId } from '../../learning/database.js';
import { getGovernanceRules, getPendingEvolutions } from '../../learning/queries.js';
import { syncForgeMemory, loadSyncConfig, getLastSyncTimestamp } from '../../learning/sync.js';
import { VALID_TABLES } from '../../learning/types.js';

export function registerLearningCommands(program: Command): void {
  const learning = program
    .command('learning')
    .description('Manage the FORGE learning engine (SQLite knowledge base)');

  // ── forge learning init ──────────────────────────────────────────────────────
  learning
    .command('init')
    .description('Initialize the learning database at ~/.forge/forge_memory.db')
    .action(() => {
      try {
        const dbPath = getForgeDbPath();
        initializeForgeMemory(dbPath);
        const db = getConnection(dbPath);
        const tables = db.prepare(
          "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
        ).all() as any[];
        const sizeBytes = existsSync(dbPath) ? statSync(dbPath).size : 0;
        const sizeKb = (sizeBytes / 1024).toFixed(1);

        console.log(chalk.green('✔ Learning database initialized'));
        console.log(`  Path:   ${chalk.cyan(dbPath)}`);
        console.log(`  Size:   ${sizeKb} KB`);
        console.log(`  Tables: ${tables.length}`);
        tables.forEach((t: any) => console.log(`    - ${t.name}`));

        const machineId = getMachineId(dbPath);
        console.log(`  Machine ID: ${chalk.yellow(machineId)}`);
      } catch (err) {
        console.error(chalk.red('✖ Failed to initialize learning database:'), err);
        process.exit(1);
      }
    });

  // ── forge learning status ────────────────────────────────────────────────────
  learning
    .command('status')
    .description('Show learning database status and row counts')
    .action(() => {
      try {
        const dbPath = getForgeDbPath();
        if (!existsSync(dbPath)) {
          console.log(chalk.yellow('Learning database not found. Run: forge learning init'));
          return;
        }
        const db = getConnection(dbPath);
        const sizeBytes = statSync(dbPath).size;
        const sizeKb = (sizeBytes / 1024).toFixed(1);
        const machineId = getMachineId(dbPath);
        const lastSync = getLastSyncTimestamp(dbPath);

        console.log(chalk.bold('\n🧠 FORGE Learning Engine Status\n'));
        console.log(`  Database: ${chalk.cyan(dbPath)}`);
        console.log(`  Size:     ${sizeKb} KB`);
        console.log(`  Machine:  ${chalk.yellow(machineId)}`);
        console.log(`  Last Sync: ${lastSync === '1970-01-01T00:00:00.000Z' ? chalk.gray('never') : lastSync}`);
        console.log(chalk.bold('\n  Table Row Counts:'));

        for (const table of VALID_TABLES) {
          try {
            const row = db.prepare(`SELECT COUNT(*) as count FROM ${table}`).get() as any;
            const count = row?.count ?? 0;
            const color = count > 0 ? chalk.green : chalk.gray;
            console.log(`    ${table.padEnd(25)} ${color(count)}`);
          } catch {
            console.log(`    ${table.padEnd(25)} ${chalk.red('error')}`);
          }
        }
        console.log('');
      } catch (err) {
        console.error(chalk.red('✖ Failed to read learning database:'), err);
      }
    });

  // ── forge learning sync ──────────────────────────────────────────────────────
  const sync = learning
    .command('sync')
    .description('Sync learning data with master drive');

  sync
    .command('pull')
    .description('Pull learning data from master drive')
    .action(() => {
      try {
        const config = loadSyncConfig();
        if (!config.master_path) {
          console.log(chalk.yellow('No master_path configured. Set it in ~/.forge/sync_config.json'));
          return;
        }
        const dbPath = getForgeDbPath();
        const machineId = getMachineId(dbPath);
        console.log(`Pulling from ${chalk.cyan(config.master_path)}...`);
        const result = syncForgeMemory('pull', dbPath, config.master_path, machineId);
        if (result.synced > 0) {
          console.log(chalk.green(`✔ Pulled ${result.synced} records from tables: ${result.tables.join(', ')}`));
        } else {
          console.log(chalk.gray('No new records to pull.'));
        }
      } catch (err) {
        console.error(chalk.red('✖ Sync pull failed:'), err);
      }
    });

  sync
    .command('push')
    .description('Push learning data to master drive')
    .action(() => {
      try {
        const config = loadSyncConfig();
        if (!config.master_path) {
          console.log(chalk.yellow('No master_path configured. Set it in ~/.forge/sync_config.json'));
          return;
        }
        const dbPath = getForgeDbPath();
        const machineId = getMachineId(dbPath);
        console.log(`Pushing to ${chalk.cyan(config.master_path)}...`);
        const result = syncForgeMemory('push', dbPath, config.master_path, machineId);
        if (result.synced > 0) {
          console.log(chalk.green(`✔ Pushed ${result.synced} records to tables: ${result.tables.join(', ')}`));
        } else {
          console.log(chalk.gray('No new records to push.'));
        }
      } catch (err) {
        console.error(chalk.red('✖ Sync push failed:'), err);
      }
    });

  // ── forge learning evolutions ────────────────────────────────────────────────
  learning
    .command('evolutions')
    .description('List pending self-modification proposals')
    .action(() => {
      try {
        const dbPath = getForgeDbPath();
        if (!existsSync(dbPath)) {
          console.log(chalk.yellow('Learning database not found. Run: forge learning init'));
          return;
        }
        const evolutions = getPendingEvolutions(dbPath);
        if (evolutions.length === 0) {
          console.log(chalk.gray('No pending evolutions.'));
          return;
        }
        console.log(chalk.bold(`\n🔄 ${evolutions.length} Pending Evolution Proposals\n`));
        for (const evo of evolutions) {
          const confidenceColor = evo.confidence >= 0.7 ? chalk.green : evo.confidence >= 0.4 ? chalk.yellow : chalk.red;
          console.log(`  [${chalk.cyan(evo.evolution_type.padEnd(10))}] ${evo.proposed_change}`);
          console.log(`    Confidence: ${confidenceColor((evo.confidence * 100).toFixed(0) + '%')}  |  Impact: ${evo.estimated_impact}`);
          console.log(`    Created: ${evo.created_at}\n`);
        }
      } catch (err) {
        console.error(chalk.red('✖ Failed to load evolutions:'), err);
      }
    });

  // ── forge learning rules ─────────────────────────────────────────────────────
  learning
    .command('rules')
    .description('List active governance rules from the learning engine')
    .action(() => {
      try {
        const dbPath = getForgeDbPath();
        if (!existsSync(dbPath)) {
          console.log(chalk.yellow('Learning database not found. Run: forge learning init'));
          return;
        }
        const rules = getGovernanceRules([], undefined, dbPath);
        if (rules.length === 0) {
          console.log(chalk.gray('No active governance rules.'));
          return;
        }
        console.log(chalk.bold(`\n📋 ${rules.length} Active Governance Rules\n`));
        for (const rule of rules) {
          const sourceColor = rule.source === 'AUTO_ELEVATED' ? chalk.yellow : rule.source === 'MANUAL' ? chalk.cyan : chalk.gray;
          console.log(`  ${chalk.bold(rule.rule_short_name)} [${sourceColor(rule.source)}] (enforced ${rule.enforcement_count}x)`);
          console.log(`    ${rule.rule_text}`);
          console.log(`    Scope: ${rule.scope}${rule.project_name ? ' (' + rule.project_name + ')' : ''}\n`);
        }
      } catch (err) {
        console.error(chalk.red('✖ Failed to load rules:'), err);
      }
    });

}
