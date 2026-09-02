// FORGE 2.0 CLI — Agent proposal review commands (approve/reject/list pending_evolutions)
import { Command } from 'commander';
import chalk from 'chalk';
import { existsSync } from 'node:fs';
import { getForgeDbPath, getConnection } from '../../learning/database.js';
import { getEvolutionsByStatus } from '../../learning/queries.js';
import { approveEvolution, rejectEvolution } from '../../learning/evolution-promoter.js';
import { approveAgent, rejectAgent } from '../../memory/agents.js';
import type { PendingEvolution } from '../../learning/types.js';

/** True when `err` is `approveEvolution`/`rejectEvolution`'s "no such pending_evolutions row" error. */
function isNoPendingEvolutionRow(err: unknown): boolean {
  return err instanceof Error && /^No pending_evolutions row found with id/.test(err.message);
}

const STATUSES = ['PENDING', 'APPROVED', 'REJECTED', 'SUPERSEDED'] as const;
type Status = (typeof STATUSES)[number];

function isStatus(value: string): value is Status {
  return (STATUSES as readonly string[]).includes(value);
}

function requireDb(): string | undefined {
  const dbPath = getForgeDbPath();
  if (!existsSync(dbPath)) {
    console.log(chalk.yellow('Learning database not found. Run: forge learn init'));
    return undefined;
  }
  return dbPath;
}

function printEvolution(evo: PendingEvolution): void {
  const confidenceColor =
    evo.confidence >= 0.7 ? chalk.green : evo.confidence >= 0.4 ? chalk.yellow : chalk.red;
  console.log(
    `  ${chalk.dim(evo.id)}\n  [${chalk.cyan(evo.evolution_type.padEnd(10))}] ${evo.proposed_change}`
  );
  console.log(
    `    Confidence: ${confidenceColor((evo.confidence * 100).toFixed(0) + '%')}  |  Impact: ${evo.estimated_impact}  |  Status: ${evo.status}`
  );
  console.log(`    Created: ${evo.created_at}`);
  if (evo.reviewed_at) console.log(`    Reviewed: ${evo.reviewed_at}${evo.review_note ? ` — ${evo.review_note}` : ''}`);
  console.log('');
}

export function registerAgentCommands(program: Command): void {
  const agent = program
    .command('agent')
    .description('Review agent self-modification proposals (pending_evolutions)');

  // ── forge agent list ──────────────────────────────────────────────────────
  agent
    .command('list')
    .description('List agent proposals (defaults to PENDING — the ones awaiting a decision)')
    .option('--status <status>', 'PENDING | APPROVED | REJECTED | SUPERSEDED', 'PENDING')
    .action((opts: { status: string }) => {
      const dbPath = requireDb();
      if (!dbPath) return;
      const status = opts.status.toUpperCase();
      if (!isStatus(status)) {
        console.error(chalk.red(`✖ Invalid --status "${opts.status}". Expected one of: ${STATUSES.join(', ')}`));
        process.exitCode = 1;
        return;
      }
      try {
        const evolutions = getEvolutionsByStatus(status, dbPath);
        if (evolutions.length === 0) {
          console.log(chalk.gray(`No ${status} agent proposals.`));
          return;
        }
        console.log(chalk.bold(`\n🔄 ${evolutions.length} ${status} Agent Proposal(s)\n`));
        for (const evo of evolutions) printEvolution(evo);
      } catch (err) {
        console.error(chalk.red('✖ Failed to load agent proposals:'), err instanceof Error ? err.message : err);
        process.exitCode = 1;
      }
    });

  // ── forge agent approve ───────────────────────────────────────────────────
  // `pending_evolutions` (behavior-evolution proposals) and `self_created_agents` (whole new
  // agents FORGE proposed via recursive learning) are two different tables sharing this one CLI
  // verb — try the evolution row first (the common case), and fall back to a self-created-agent
  // proposal only when the id isn't a pending_evolutions row at all (never both, so a real
  // evolution failure — e.g. "already APPROVED" — still reports as itself, not a misleading
  // "not found" from the fallback).
  agent
    .command('approve')
    .description('Approve a pending agent proposal (an evolution proposal or a self-created-agent proposal)')
    .argument('<id>', 'pending_evolutions.id or self_created_agents.id')
    .option('--note <text>', 'optional review note recorded on the decision (evolution proposals only)')
    .action(async (id: string, opts: { note?: string }) => {
      const dbPath = requireDb();
      if (!dbPath) return;
      try {
        const db = getConnection(dbPath);
        const result = approveEvolution(db, id, opts.note);
        console.log(chalk.bold('\n✔ Evolution proposal approved (pending_evolutions)\n'));
        console.log(`  [${chalk.cyan(result.evolutionType)}] ${result.pendingEvolutionId}`);
        console.log(`    ${result.effectApplied}`);
        console.log('');
      } catch (err) {
        if (!isNoPendingEvolutionRow(err)) {
          console.error(chalk.red('✖ Approve failed:'), err instanceof Error ? err.message : err);
          process.exitCode = 1;
          return;
        }
        const agentRow = await approveAgent(id);
        if (!agentRow) {
          console.error(
            chalk.red(`✖ Approve failed: "${id}" is neither a pending_evolutions row nor a self_created_agents row.`)
          );
          process.exitCode = 1;
          return;
        }
        console.log(chalk.bold('\n✔ Self-created agent proposal approved (self_created_agents)\n'));
        console.log(`  [${chalk.cyan(agentRow.name)}] ${agentRow.id}`);
        console.log(`    status: ${agentRow.status} (approved_at: ${agentRow.approved_at})`);
        console.log('');
      }
    });

  // ── forge agent reject ────────────────────────────────────────────────────
  agent
    .command('reject')
    .description('Reject a pending agent proposal (an evolution proposal or a self-created-agent proposal)')
    .argument('<id>', 'pending_evolutions.id or self_created_agents.id')
    .requiredOption('--reason <text>', 'why this proposal is being rejected (required for the audit trail)')
    .action(async (id: string, opts: { reason: string }) => {
      const dbPath = requireDb();
      if (!dbPath) return;
      try {
        const db = getConnection(dbPath);
        const result = rejectEvolution(db, id, opts.reason);
        console.log(chalk.bold('\n✖ Evolution proposal rejected (pending_evolutions)\n'));
        console.log(`  [${chalk.cyan(result.evolutionType)}] ${result.pendingEvolutionId}`);
        console.log(`    reason: ${opts.reason}`);
        console.log('');
      } catch (err) {
        if (!isNoPendingEvolutionRow(err)) {
          console.error(chalk.red('✖ Reject failed:'), err instanceof Error ? err.message : err);
          process.exitCode = 1;
          return;
        }
        const agentRow = await rejectAgent(id);
        if (!agentRow) {
          console.error(
            chalk.red(`✖ Reject failed: "${id}" is neither a pending_evolutions row nor a self_created_agents row.`)
          );
          process.exitCode = 1;
          return;
        }
        console.log(chalk.bold('\n✖ Self-created agent proposal rejected (self_created_agents)\n'));
        console.log(`  [${chalk.cyan(agentRow.name)}] ${agentRow.id}`);
        console.log(`    status: ${agentRow.status}  reason: ${opts.reason}`);
        console.log('');
      }
    });
}
