// FORGE 2.0 — Enterprise Test Suite: MIGRATION_SAFETY runner (destructive-op / RLS / FK breakage
// analysis of the project's most recent Supabase migration).
//
// Reuses FORGE's existing src/tools/migration-safety.ts rather than re-implementing SQL parsing /
// schema diffing — DRY, per the blueprint's "reuse, never re-implement" rule (same pattern
// security-runner.ts uses for security-scanner.ts). migration-safety.ts's `analyzeMigration` is a
// PRE-MIGRATION gate that requires the migration SQL text up front (it has no "scan the project"
// mode) — TestOrchestrator has no specific migration in flight, so this runner analyzes the most
// recently modified `*.sql` file under `supabase/migrations/`, with zero pre-supplied
// confirmations (any destructive op is reported unconfirmed — never a fabricated pass).

import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { analyzeMigration } from '../../tools/migration-safety.js';
import { errorOutcome, skippedOutcome, type RunnerFailure, type RunnerInput, type RunnerOutcome } from './types.js';

const MIGRATION_DIR = 'supabase/migrations';

async function findLatestMigration(projectPath: string): Promise<{ name: string; sql: string } | null> {
  const dir = join(projectPath, MIGRATION_DIR);
  let files: string[];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith('.sql'));
  } catch {
    return null;
  }
  if (files.length === 0) return null;

  const withMtime = await Promise.all(
    files.map(async (f) => ({ f, mtime: (await stat(join(dir, f))).mtimeMs }))
  );
  withMtime.sort((a, b) => b.mtime - a.mtime);
  const latest = withMtime[0]!.f;
  const sql = await readFile(join(dir, latest), 'utf8');
  return { name: latest, sql };
}

export async function run(input: RunnerInput): Promise<RunnerOutcome> {
  const started = Date.now();
  try {
    const migration = await findLatestMigration(input.projectPath);
    if (!migration) {
      return skippedOutcome(
        'migration-safety',
        `no *.sql migration found under ${MIGRATION_DIR} — migration safety not evaluated`
      );
    }

    const report = await analyzeMigration({
      sql: migration.sql,
      migrationName: migration.name,
      projectPath: input.projectPath,
    });
    const durationMs = Date.now() - started;

    const unacknowledgedBreakages = [...report.rlsBreakages, ...report.fkBreakages].filter((b) => !b.acknowledged);
    const failures: RunnerFailure[] = [
      ...report.unconfirmed.map((op) => ({ name: op.rule, message: op.message, file: op.table ?? migration.name })),
      ...unacknowledgedBreakages.map((b) => ({ name: b.rule, message: b.message, file: b.objectTable })),
    ].slice(0, 20);

    const testsTotal = report.destructiveOperations.length + report.rlsBreakages.length + report.fkBreakages.length;
    const status: RunnerOutcome['status'] = report.passed ? 'passed' : 'failed';
    return {
      runner: 'migration-safety',
      status,
      testsTotal,
      testsPassed: testsTotal - failures.length,
      testsFailed: failures.length,
      testsSkipped: 0,
      durationMs,
      failures,
      reportPath: null,
      exitCode: null,
      detail: report.passed
        ? `'${migration.name}' safe to apply (${report.statementCount} statement(s), schema source: ${report.productionSchemaSource})`
        : `'${migration.name}' BLOCKED — ${report.unconfirmed.length} unconfirmed destructive op(s), ${unacknowledgedBreakages.length} un-acknowledged breakage(s)`,
      coverage: null,
    };
  } catch (error) {
    return errorOutcome(
      'migration-safety',
      `migration safety analysis threw: ${error instanceof Error ? error.message : String(error)}`,
      Date.now() - started
    );
  }
}
