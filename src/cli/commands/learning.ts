// FORGE 2.0 CLI — Learning Engine Commands
import { Command } from 'commander';
import chalk from 'chalk';
import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { initializeForgeMemory, getConnection, getForgeDbPath, getMachineId } from '../../learning/database.js';
import { getGovernanceRules, getPendingEvolutions, countPendingEvolutions, getForgeMemory } from '../../learning/queries.js';
import { syncForgeMemory, loadSyncConfig, getLastSyncTimestamp } from '../../learning/sync.js';
import { VALID_TABLES, type FixPattern } from '../../learning/types.js';
import { transferKnowledge } from '../../learning/cross-project-transfer.js';
import { emitProposals } from '../../learning/build-brain-evolver.js';
import { promoteEligible } from '../../learning/evolution-promoter.js';
import { detectStack } from '../../tools/stack-detector.js';

export function registerLearningCommands(program: Command): void {
  const learn = program
    .command('learn')
    .description('Manage the FORGE learning engine (SQLite knowledge base)');

  // ── forge learn init ──────────────────────────────────────────────────────
  learn
    .command('init')
    .description('Initialize the learning database at ~/.forge/forge_memory.db')
    .action(() => {
      try {
        const dbPath = getForgeDbPath();
        initializeForgeMemory(dbPath);
        const db = getConnection(dbPath);
        const tables = db.prepare(
          "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
        ).all() as { name: string }[];
        const sizeBytes = existsSync(dbPath) ? statSync(dbPath).size : 0;
        const sizeKb = (sizeBytes / 1024).toFixed(1);

        console.log(chalk.green('✔ Learning database initialized'));
        console.log(`  Path:   ${chalk.cyan(dbPath)}`);
        console.log(`  Size:   ${sizeKb} KB`);
        console.log(`  Tables: ${tables.length}`);
        tables.forEach((t) => console.log(`    - ${t.name}`));

        const machineId = getMachineId(dbPath);
        console.log(`  Machine ID: ${chalk.yellow(machineId)}`);
      } catch (err) {
        console.error(chalk.red('✖ Failed to initialize learning database:'), err);
        process.exit(1);
      }
    });

  // ── forge learn status ────────────────────────────────────────────────────
  learn
    .command('status')
    .description('Show learning DB stats (prompts scored, fix patterns, governance rules active)')
    .action(() => {
      try {
        const dbPath = getForgeDbPath();
        if (!existsSync(dbPath)) {
          console.log(chalk.yellow('Learning database not found. Run: forge learn init'));
          return;
        }
        const db = getConnection(dbPath);
        const sizeBytes = statSync(dbPath).size;
        const sizeKb = (sizeBytes / 1024).toFixed(1);
        const machineId = getMachineId(dbPath);
        const lastSync = getLastSyncTimestamp(dbPath);

        const totalScored = (db.prepare('SELECT COUNT(*) as count FROM prompt_scores').get() as { count: number } | undefined)?.count ?? 0;
        const fixPatterns = (db.prepare('SELECT COUNT(*) as count FROM fix_patterns').get() as { count: number } | undefined)?.count ?? 0;
        const activeRules = (db.prepare("SELECT COUNT(*) as count FROM governance_rules WHERE active = 1").get() as { count: number } | undefined)?.count ?? 0;

        console.log(chalk.bold('\n🧠 FORGE Learning Engine Status\n'));
        console.log(`  Database: ${chalk.cyan(dbPath)}`);
        console.log(`  Size:     ${sizeKb} KB`);
        console.log(`  Machine:  ${chalk.yellow(machineId)}`);
        console.log(`  Last Sync: ${lastSync === '1970-01-01T00:00:00.000Z' ? chalk.gray('never') : lastSync}`);

        console.log(chalk.bold('\n  Key Metrics:'));
        console.log(`    Total prompts scored:    ${chalk.cyan(String(totalScored))}`);
        console.log(`    Fix patterns learned:    ${chalk.cyan(String(fixPatterns))}`);
        console.log(`    Governance rules active: ${chalk.cyan(String(activeRules))}`);

        console.log(chalk.bold('\n  Table Row Counts:'));
        for (const table of VALID_TABLES) {
          try {
            const row = db.prepare(`SELECT COUNT(*) as count FROM ${table}`).get() as { count: number } | undefined;
            const count = row?.count ?? 0;
            const color = count > 0 ? chalk.green : chalk.gray;
            console.log(`    ${table.padEnd(25)} ${color(String(count))}`);
          } catch {
            console.log(`    ${table.padEnd(25)} ${chalk.red('error')}`);
          }
        }
        console.log('');
      } catch (err) {
        console.error(chalk.red('✖ Failed to read learning database:'), err);
      }
    });

  // ── forge learn patterns ──────────────────────────────────────────────────
  learn
    .command('patterns')
    .description('List top fix patterns by success rate')
    .option('--limit <n>', 'max patterns to show', '20')
    .action((opts: { limit?: string }) => {
      try {
        const dbPath = getForgeDbPath();
        if (!existsSync(dbPath)) {
          console.log(chalk.yellow('Learning database not found. Run: forge learn init'));
          return;
        }
        const limit = parseInt(opts.limit ?? '20', 10);
        const patterns = getForgeMemory(
          'fix_patterns',
          { orderBy: 'success_rate DESC, occurrence_count DESC', limit },
          dbPath,
        ) as FixPattern[];

        if (patterns.length === 0) {
          console.log(chalk.gray('No fix patterns recorded yet.'));
          return;
        }

        console.log(chalk.bold(`\n🔧 ${patterns.length} Fix Pattern(s) (sorted by success rate)\n`));
        for (const p of patterns) {
          const rate = `${(p.success_rate * 100).toFixed(0)}%`;
          const rateColor = p.success_rate >= 0.7 ? chalk.green : p.success_rate >= 0.4 ? chalk.yellow : chalk.red;
          console.log(
            `  [${chalk.cyan(p.error_category.padEnd(8))}] ${chalk.bold(p.error_fingerprint.slice(0, 16))}…  ` +
            `×${p.occurrence_count}  success ${rateColor(rate)}  applied ${p.times_fix_applied}x`,
          );
          console.log(`    ${chalk.dim(p.error_message.slice(0, 100))}`);
          if (p.fix_description) {
            console.log(`    fix: ${chalk.green(p.fix_description.slice(0, 80))}`);
          }
          console.log('');
        }
      } catch (err) {
        console.error(chalk.red('✖ Failed to load fix patterns:'), err);
      }
    });

  // ── forge learn sync ──────────────────────────────────────────────────────
  learn
    .command('sync')
    .description('Trigger cross-machine sync. Defaults to bidirectional (pull then push).')
    .option('--pull', 'pull only (master → local)')
    .option('--push', 'push only (local → master)')
    .action((opts: { pull?: boolean; push?: boolean }) => {
      try {
        const config = loadSyncConfig();
        if (!config.master_path) {
          console.log(chalk.yellow('No master_path configured. Set it in ~/.forge/sync_config.json'));
          return;
        }
        const dbPath = getForgeDbPath();
        const machineId = getMachineId(dbPath);

        const doPull = opts.pull === true || (!opts.pull && !opts.push);
        const doPush = opts.push === true || (!opts.pull && !opts.push);

        if (doPull) {
          console.log(`Pulling from ${chalk.cyan(config.master_path)}...`);
          const result = syncForgeMemory('pull', dbPath, config.master_path, machineId);
          if (result.synced > 0) {
            console.log(chalk.green(`✔ Pulled ${result.synced} records from tables: ${result.tables.join(', ')}`));
          } else {
            console.log(chalk.gray('No new records to pull.'));
          }
        }

        if (doPush) {
          console.log(`Pushing to ${chalk.cyan(config.master_path)}...`);
          const result = syncForgeMemory('push', dbPath, config.master_path, machineId);
          if (result.synced > 0) {
            console.log(chalk.green(`✔ Pushed ${result.synced} records to tables: ${result.tables.join(', ')}`));
          } else {
            console.log(chalk.gray('No new records to push.'));
          }
        }
      } catch (err) {
        console.error(chalk.red('✖ Sync failed:'), err);
      }
    });

  // ── forge learn evolutions ────────────────────────────────────────────────
  learn
    .command('evolutions')
    .description('List pending self-modification proposals')
    .option('--limit <n>', 'max proposals to show (default 50; use 0 for unbounded)', '50')
    .action((opts: { limit: string }) => {
      try {
        const dbPath = getForgeDbPath();
        if (!existsSync(dbPath)) {
          console.log(chalk.yellow('Learning database not found. Run: forge learn init'));
          return;
        }
        const limitArg = Math.min(1000, Math.max(0, parseInt(opts.limit, 10) || 0));
        const total = countPendingEvolutions(dbPath);
        const evolutions = getPendingEvolutions(dbPath, limitArg > 0 ? limitArg : undefined);
        if (evolutions.length === 0) {
          console.log(chalk.gray('No pending evolutions.'));
          return;
        }
        const header = evolutions.length < total
          ? `🔄 Showing ${evolutions.length} of ${total} Pending Evolution Proposals (use --limit to see more)`
          : `🔄 ${evolutions.length} Pending Evolution Proposals`;
        console.log(chalk.bold(`\n${header}\n`));
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

  // ── forge learn rules ─────────────────────────────────────────────────────
  learn
    .command('rules')
    .description('List active governance rules from the learning engine')
    .action(() => {
      try {
        const dbPath = getForgeDbPath();
        if (!existsSync(dbPath)) {
          console.log(chalk.yellow('Learning database not found. Run: forge learn init'));
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

  // ── forge learn transfer ──────────────────────────────────────────────────
  // CrossProjectKnowledgeTransfer (LEARNING_BLUEPRINT.md § Agent: CrossProjectKnowledgeTransfer) —
  // PUSH stack-compatible, non-retired cross_project_insights into <project-path>'s build.
  learn
    .command('transfer')
    .description('Transfer stack-compatible cross-project insights into a build (CrossProjectKnowledgeTransfer)')
    .argument('<project-path>', 'Absolute path to the target project (its detected stack is the match target)')
    .option('--dry-run', 'report what would be transferred; write nothing', false)
    .option('--build-id <id>', 'restrict transfer to insights sourced from one specific build')
    .action(async (projectPath: string, opts: { dryRun?: boolean; buildId?: string }) => {
      try {
        const dbPath = getForgeDbPath();
        if (!existsSync(dbPath)) {
          console.log(chalk.yellow('Learning database not found. Run: forge learn init'));
          return;
        }
        const db = getConnection(dbPath);
        const resolvedPath = resolve(projectPath);
        const targetStack = await detectStack(resolvedPath);

        const result = transferKnowledge(resolvedPath, targetStack, db, {
          dryRun: opts.dryRun ?? false,
          ...(opts.buildId ? { buildId: opts.buildId } : {}),
        });

        console.log(chalk.bold(`\n🔀 CrossProjectKnowledgeTransfer — ${resolvedPath}\n`));
        const stackLabel = [targetStack.language, targetStack.framework, targetStack.database]
          .filter((v): v is string => typeof v === 'string' && v !== '')
          .join(' / ');
        console.log(`  Target stack: ${chalk.cyan(stackLabel || 'unknown')}`);
        console.log(`  Transferred:  ${chalk.green(String(result.transferred))} insight(s)`);
        console.log(`  Skipped:      ${result.skippedIncompatible} incompatible, ${result.skippedRetired} retired`);
        if (opts.dryRun) console.log(chalk.gray('  (dry run — applied_count not incremented)'));
        for (const w of result.warnings) console.log(chalk.yellow(`  ⚠ ${w}`));
        if (result.contextBlock !== '') {
          console.log(chalk.bold('\n  Context block:\n'));
          console.log(result.contextBlock);
        }
        console.log('');
      } catch (err) {
        console.error(chalk.red('✖ Transfer refused:'), err instanceof Error ? err.message : err);
        process.exitCode = 1;
      }
    });

  // ── forge learn evolve ────────────────────────────────────────────────────
  // BuildBrainEvolver (LEARNING_BLUEPRINT.md § Agent: BuildBrainEvolver) — analyze one build's
  // Contract-9 rewrite-effectiveness observations (prompt_executions.was_rewritten /
  // sentinel_passed) and emit any TEMPLATE evolution proposals into pending_evolutions. Never
  // edits src/engine/prompt-rewriter.ts — proposals only (Learning Iron Law L5).
  learn
    .command('evolve')
    .description("Analyze a build's prompt-rewrite effectiveness and emit TEMPLATE evolution proposals (BuildBrainEvolver)")
    .argument('<build-id>', 'The build_runs.id to analyze')
    .action((buildId: string) => {
      try {
        const dbPath = getForgeDbPath();
        if (!existsSync(dbPath)) {
          console.log(chalk.yellow('Learning database not found. Run: forge learn init'));
          return;
        }
        const db = getConnection(dbPath);
        const proposals = emitProposals(buildId, db);

        console.log(chalk.bold(`\n🧬 BuildBrainEvolver — build ${buildId}\n`));
        if (proposals.length === 0) {
          console.log(chalk.gray('No new rewrite-effectiveness pattern found (or already proposed for this build).'));
          return;
        }
        for (const p of proposals) {
          const confidenceColor = p.confidence >= 0.7 ? chalk.green : p.confidence >= 0.4 ? chalk.yellow : chalk.red;
          console.log(`  [${chalk.cyan(p.evolution_type)}] ${p.proposed_change}`);
          console.log(`    Confidence: ${confidenceColor((p.confidence * 100).toFixed(0) + '%')}  |  Impact: ${p.estimated_impact}`);
        }
        console.log('');
      } catch (err) {
        console.error(chalk.red('✖ BuildBrainEvolver failed:'), err instanceof Error ? err.message : err);
        process.exitCode = 1;
      }
    });

  // ── forge learn promote ───────────────────────────────────────────────────
  // EvolutionPromoter (LEARNING_BLUEPRINT.md § Agent: EvolutionPromoter) — auto-promote every
  // pending_evolutions row whose confidence clears PROMOTION_THRESHOLD (and isn't a GATE), and
  // run monitoring-window rollback bookkeeping for already-promoted rows.
  learn
    .command('promote')
    .description('Auto-promote high-confidence pending evolutions and run rollback monitoring (EvolutionPromoter)')
    .action(async () => {
      try {
        const dbPath = getForgeDbPath();
        if (!existsSync(dbPath)) {
          console.log(chalk.yellow('Learning database not found. Run: forge learn init'));
          return;
        }
        const db = getConnection(dbPath);
        const results = await promoteEligible(db, { log: (m) => console.log(chalk.dim(`  ${m}`)) });

        console.log(chalk.bold('\n🚀 EvolutionPromoter\n'));
        if (results.length === 0) {
          console.log(chalk.gray('No pending evolutions cleared the promotion bar this run.'));
          return;
        }
        for (const r of results) {
          console.log(
            `  [${chalk.cyan(r.evolutionType)}] promoted (confidence ${(r.confidenceAtPromotion * 100).toFixed(0)}%)`
          );
          console.log(`    ${r.effectApplied}`);
        }
        console.log('');
      } catch (err) {
        console.error(chalk.red('✖ EvolutionPromoter failed:'), err instanceof Error ? err.message : err);
        process.exitCode = 1;
      }
    });
}
