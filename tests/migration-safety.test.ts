/**
 * FORGE 2.0 — Migration Safety tests (pure `node:test`; no disk, no DB).
 *
 * Covers the SQL statement splitter (comment capture / dollar-quote / string awareness), the
 * confirmation-marker parser, destructive-operation detection (DROP TABLE / DROP COLUMN / lossy &
 * non-lossy ALTER COLUMN TYPE / TRUNCATE / DELETE-without-WHERE, with marker- and option-based
 * confirmation), statement classification + the production diff, RLS/FK breakage detection (with
 * acknowledgement), rollback generation (create⇄drop, recreate-from-snapshot, retype-revert),
 * backup-script generation, the full `analyzeMigration` orchestrator over a supplied production
 * snapshot + a capturing history store (blocked-when-unconfirmed, safe-when-confirmed, breakage
 * blocks), and the Phase 4 Sentinel integration (the optional pre-migration gate: opt-in, a blocked
 * migration fails the gate FIRST and short-circuits tsc, a safe migration passes, default five-check
 * path untouched).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  analyzeMigration,
  splitStatementsWithComments,
  parseConfirmMarkers,
  detectDestructiveOperations,
  classifyStatements,
  computeDiff,
  detectBreakages,
  generateRollback,
  generateBackupScript,
  affectedTablesOf,
  renderColumnDef,
  renderCreateTable,
  type MigrationStoredRecord,
  type MigrationSafetyReport,
} from '../src/tools/migration-safety.js';
import type { SchemaSnapshot, TableSchema } from '../src/tools/schema-extractor.js';
import { runSentinel, type CommandResult } from '../src/phases/phase4-sentinel.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A small production schema: companies(id) ← contacts(company_id), with an RLS policy + index. */
function prodSchema(): SchemaSnapshot {
  const companies: TableSchema = {
    name: 'companies',
    schema: 'public',
    columns: [
      { name: 'id', type: 'uuid', nullable: false, default: 'gen_random_uuid()', constraints: ['not null'] },
      { name: 'name', type: 'text', nullable: false, default: null, constraints: ['not null'] },
    ],
    primaryKey: ['id'],
    foreignKeys: [],
    rlsEnabled: true,
  };
  const contacts: TableSchema = {
    name: 'contacts',
    schema: 'public',
    columns: [
      { name: 'id', type: 'uuid', nullable: false, default: 'gen_random_uuid()', constraints: ['not null'] },
      { name: 'company_id', type: 'uuid', nullable: false, default: null, constraints: ['not null'] },
      { name: 'email', type: 'text', nullable: true, default: null, constraints: [] },
    ],
    primaryKey: ['id'],
    foreignKeys: [
      { name: 'contacts_company_fk', columns: ['company_id'], referencesTable: 'companies', referencesColumns: ['id'], onDelete: 'cascade', onUpdate: null },
    ],
    rlsEnabled: true,
  };
  return {
    tables: [companies, contacts],
    relationships: [
      { constraintName: 'contacts_company_fk', fromTable: 'contacts', fromColumns: ['company_id'], toTable: 'companies', toColumns: ['id'], onDelete: 'cascade', onUpdate: null },
    ],
    indexes: [{ name: 'idx_contacts_company', table: 'contacts', columns: ['company_id'], unique: false, method: 'btree', predicate: null }],
    rlsPolicies: [
      { name: 'contacts_company_isolation', table: 'contacts', command: 'ALL', roles: ['authenticated'], permissive: true, using: 'company_id = current_company()', withCheck: null },
    ],
    source: 'live',
    migrationFiles: [],
    warnings: [],
  };
}

/** A capturing history store so tests assert the Build-Memory write without a DB. */
function capturingStore(): { records: MigrationStoredRecord[]; store: (r: MigrationStoredRecord) => Promise<void> } {
  const records: MigrationStoredRecord[] = [];
  return { records, store: async (r) => { records.push(r); } };
}

/** Analyze a migration over the supplied production snapshot with a capturing store. */
async function analyze(
  sql: string,
  extra: { confirmations?: string[]; production?: SchemaSnapshot } = {}
): Promise<{ report: MigrationSafetyReport; records: MigrationStoredRecord[] }> {
  const cap = capturingStore();
  const report = await analyzeMigration(
    {
      sql,
      migrationName: 'test',
      projectName: 'proj',
      productionSchema: extra.production ?? prodSchema(),
      ...(extra.confirmations ? { confirmations: extra.confirmations } : {}),
    },
    { storeHistory: async (r) => cap.store(r), now: () => 'T', log: () => {} }
  );
  return { report, records: cap.records };
}

// ---------------------------------------------------------------------------
// Statement splitter + comment capture
// ---------------------------------------------------------------------------

test('splitStatementsWithComments captures leading comments and skips dollar-quoted/strings', () => {
  const sql = `
    -- forge:confirm drop_table
    drop table old_thing;
    insert into t(x) values ('a; not a terminator');
    do $$ begin perform 1; end $$;
  `;
  const stmts = splitStatementsWithComments(sql);
  assert.equal(stmts.length, 3);
  assert.match(stmts[0]!.sql, /^drop table old_thing$/i);
  assert.match(stmts[0]!.comments, /forge:confirm drop_table/);
  // The semicolon inside the string literal does not split the insert.
  assert.match(stmts[1]!.sql, /values \('a; not a terminator'\)/);
  // The dollar-quoted block is one statement.
  assert.match(stmts[2]!.sql, /do \$\$ begin perform 1; end \$\$/);
});

test('parseConfirmMarkers reads bare and qualified markers', () => {
  assert.deepEqual(parseConfirmMarkers('-- forge:confirm'), ['*']);
  assert.deepEqual(parseConfirmMarkers('-- forge:confirm drop_table'), ['drop_table']);
  assert.deepEqual(parseConfirmMarkers('-- @forge-confirm contacts.email'), ['contacts.email']);
  assert.deepEqual(parseConfirmMarkers('no marker here'), []);
});

// ---------------------------------------------------------------------------
// Destructive-operation detection
// ---------------------------------------------------------------------------

test('detects all five destructive operations', () => {
  const sql = `
    drop table a;
    alter table b drop column c;
    alter table b alter column d type varchar(10);
    truncate table e;
    delete from f;
    delete from g where id = 1;
  `;
  const stmts = splitStatementsWithComments(sql);
  const ops = detectDestructiveOperations(stmts, [], true);
  const types = ops.map((o) => o.type).sort();
  assert.deepEqual(types, ['alter_column_type', 'delete_without_where', 'drop_column', 'drop_table', 'truncate']);
  // DELETE with a WHERE clause is NOT flagged.
  assert.equal(ops.filter((o) => o.table === 'g').length, 0);
});

test('ALTER COLUMN TYPE: narrowing is clearlyLossy, widening flagged only when flagAll', () => {
  const stmts = splitStatementsWithComments('alter table b alter column d type integer; alter table b alter column e type text;');
  const all = detectDestructiveOperations(stmts, [], true);
  assert.equal(all.length, 2);
  const toInt = all.find((o) => o.column === 'd')!;
  assert.equal(toInt.clearlyLossy, true);
  const toText = all.find((o) => o.column === 'e')!;
  assert.equal(toText.clearlyLossy, false);
  // With flagAllTypeChanges=false only the clearly-lossy narrowing is reported.
  const lossyOnly = detectDestructiveOperations(stmts, [], false);
  assert.equal(lossyOnly.length, 1);
  assert.equal(lossyOnly[0]!.column, 'd');
});

test('confirmation by inline marker and by option', () => {
  const sql = `-- forge:confirm drop_table
    drop table a;
    truncate table e;`;
  const stmts = splitStatementsWithComments(sql);
  // Marker confirms the drop_table only; truncate stays unconfirmed.
  const ops = detectDestructiveOperations(stmts, [], true);
  assert.equal(ops.find((o) => o.type === 'drop_table')!.confirmed, true);
  assert.equal(ops.find((o) => o.type === 'drop_table')!.confirmedBy, 'marker');
  assert.equal(ops.find((o) => o.type === 'truncate')!.confirmed, false);
  // Option-based confirmation by table name confirms the truncate too.
  const ops2 = detectDestructiveOperations(stmts, ['e'], true);
  assert.equal(ops2.find((o) => o.type === 'truncate')!.confirmed, true);
  assert.equal(ops2.find((o) => o.type === 'truncate')!.confirmedBy, 'option');
});

// ---------------------------------------------------------------------------
// Classification + diff
// ---------------------------------------------------------------------------

test('computeDiff reflects adds/drops/retypes against production', () => {
  const sql = `
    create table widgets (id uuid primary key);
    alter table contacts add column phone text;
    alter table contacts drop column email;
    alter table contacts alter column company_id type text;
    drop table contacts;
  `;
  const diff = computeDiff(classifyStatements(splitStatementsWithComments(sql)), prodSchema());
  assert.deepEqual(diff.tablesAdded, ['widgets']);
  assert.deepEqual(diff.tablesDropped, ['contacts']);
  assert.equal(diff.columnsAdded.some((c) => c.column === 'phone'), true);
  const dropped = diff.columnsDropped.find((c) => c.column === 'email')!;
  assert.equal(dropped.existsInProduction, true);
  assert.equal(dropped.fromType, 'text');
  const retyped = diff.columnsRetyped.find((c) => c.column === 'company_id')!;
  assert.equal(retyped.fromType, 'uuid');
  assert.equal(retyped.type, 'text');
});

// ---------------------------------------------------------------------------
// Breakage detection
// ---------------------------------------------------------------------------

test('detectBreakages flags RLS + FK on dropped table and column', () => {
  const sql = 'drop table contacts;';
  const ops = detectDestructiveOperations(splitStatementsWithComments(sql), [], true);
  const { rls, fk } = detectBreakages(ops, prodSchema(), []);
  assert.equal(rls.length, 1);
  assert.equal(rls[0]!.objectName, 'contacts_company_isolation');
  assert.equal(fk.length, 1);
  assert.equal(fk[0]!.objectName, 'contacts_company_fk');
  assert.equal(rls[0]!.acknowledged, false);
});

test('dropping a column referenced by an RLS policy / participating in an FK breaks both', () => {
  const sql = 'alter table contacts drop column company_id;';
  const ops = detectDestructiveOperations(splitStatementsWithComments(sql), [], true);
  const { rls, fk } = detectBreakages(ops, prodSchema(), []);
  assert.equal(rls.length, 1, 'policy USING references company_id');
  assert.equal(fk.length, 1, 'company_id is the FK source column');
  // Acknowledgement via the `fk`/`rls` keywords.
  const acked = detectBreakages(ops, prodSchema(), ['rls', 'fk']);
  assert.equal(acked.rls[0]!.acknowledged, true);
  assert.equal(acked.fk[0]!.acknowledged, true);
});

// ---------------------------------------------------------------------------
// Rollback + backup
// ---------------------------------------------------------------------------

test('renderColumnDef + renderCreateTable reconstruct from a snapshot', () => {
  const t = prodSchema().tables.find((x) => x.name === 'contacts')!;
  assert.match(renderColumnDef(t.columns[1]!), /^company_id uuid not null$/);
  const ddl = renderCreateTable(t);
  assert.match(ddl, /create table contacts/);
  assert.match(ddl, /primary key \(id\)/);
  assert.match(ddl, /foreign key \(company_id\) references companies\(id\) on delete cascade/);
});

test('generateRollback inverts create/add and reconstructs drops from production', () => {
  const sql = `
    create table widgets (id uuid primary key);
    alter table contacts add column phone text;
    alter table contacts drop column email;
    alter table contacts alter column email type varchar(5);
    drop table contacts;
  `;
  const intents = classifyStatements(splitStatementsWithComments(sql));
  const rb = generateRollback(intents, prodSchema(), 'm', 'backup-m.mjs');
  // create table widgets → drop table widgets
  assert.match(rb, /drop table if exists widgets;/);
  // add column phone → drop column phone
  assert.match(rb, /drop column if exists phone;/);
  // drop column email → re-add from the production definition
  assert.match(rb, /add column email text/);
  // drop table contacts → recreate from production
  assert.match(rb, /create table contacts/);
  // pure-data note references the backup
  assert.match(rb, /backup-m\.mjs/);
});

test('generateBackupScript: empty for no affected tables, script for affected', () => {
  assert.equal(generateBackupScript([], 'm').script, '');
  const bs = generateBackupScript(['contacts', 'companies'], 'm');
  assert.deepEqual(bs.affectedTables, ['contacts', 'companies']);
  assert.match(bs.script, /createClient/);
  assert.match(bs.script, /\["contacts","companies"\]/);
  assert.equal(bs.filename, 'backup-m.mjs');
});

test('affectedTablesOf de-dupes and sorts destructive targets', () => {
  const sql = 'drop table b; truncate b; alter table a drop column c;';
  const ops = detectDestructiveOperations(splitStatementsWithComments(sql), [], true);
  assert.deepEqual(affectedTablesOf(ops), ['a', 'b']);
});

// ---------------------------------------------------------------------------
// Full orchestrator
// ---------------------------------------------------------------------------

test('analyzeMigration BLOCKS an unconfirmed destructive migration and stores history', async () => {
  const { report, records } = await analyze('truncate table contacts;');
  assert.equal(report.passed, false);
  assert.equal(report.blocked, true);
  assert.equal(report.unconfirmed.length, 1);
  assert.equal(report.backupScript.affectedTables.includes('contacts'), true);
  assert.match(report.rollbackMigration, /restore .* from the backup|irreversible/i);
  assert.equal(records.length, 1);
  assert.equal(records[0]!.blocked, true);
  assert.equal(records[0]!.unconfirmedCount, 1);
});

test('analyzeMigration PASSES when every destructive op is confirmed and nothing breaks', async () => {
  // Drop a standalone table (not an FK/RLS endpoint), confirmed.
  const prod = prodSchema();
  prod.tables.push({ name: 'scratch', schema: 'public', columns: [{ name: 'id', type: 'uuid', nullable: false, default: null, constraints: ['not null'] }], primaryKey: ['id'], foreignKeys: [], rlsEnabled: false });
  const { report } = await analyze('-- forge:confirm\n drop table scratch;', { production: prod });
  assert.equal(report.passed, true);
  assert.equal(report.blocked, false);
  assert.equal(report.destructiveOperations.length, 1);
  assert.equal(report.unconfirmed.length, 0);
});

test('analyzeMigration BLOCKS on an un-acknowledged breakage even when the op is confirmed', async () => {
  const { report } = await analyze('-- forge:confirm\n drop table contacts;');
  assert.equal(report.blocked, true, 'confirmed drop still breaks the FK + RLS policy');
  assert.equal(report.rlsBreakages.length + report.fkBreakages.length >= 2, true);
  // Acknowledging the breakages unblocks it.
  const acked = await analyze('-- forge:confirm\n drop table contacts;', { confirmations: ['all'] });
  assert.equal(acked.report.passed, true);
});

test('analyzeMigration: additive migration is safe with no backup needed', async () => {
  const { report } = await analyze('alter table contacts add column phone text;');
  assert.equal(report.passed, true);
  assert.equal(report.destructiveOperations.length, 0);
  assert.equal(report.backupScript.affectedTables.length, 0);
  assert.equal(report.diff.columnsAdded.some((c) => c.column === 'phone'), true);
});

// ---------------------------------------------------------------------------
// Phase 4 Sentinel integration (the optional pre-migration gate)
// ---------------------------------------------------------------------------

/** A command runner that always succeeds (so tsc/build never gate the test). */
const okRunner = async (): Promise<CommandResult> => ({ ok: true, exitCode: 0, stdout: '', stderr: '', timedOut: false });

test('Sentinel without migrationSafety keeps exactly the five Contract-13 checks', async () => {
  const res = await runSentinel({
    projectPath: '/proj',
    runCommand: okRunner,
    getFileChanges: async () => null,
    packageJsonContent: '{}',
    log: () => {},
  });
  assert.equal(res.checks.some((c) => c.name === 'migration_safety'), false);
  assert.equal(res.checks[0]!.name, 'typescript');
});

test('Sentinel runs migration_safety FIRST and FAILS the gate on a blocked migration', async () => {
  const res = await runSentinel({
    projectPath: '/proj',
    runCommand: okRunner,
    getFileChanges: async () => null,
    packageJsonContent: '{}',
    log: () => {},
    migrationSafety: { sql: 'truncate table contacts;', productionSchema: prodSchema() },
    migrationSafetyOptions: { storeHistory: async () => {}, now: () => 'T', log: () => {} },
  });
  assert.equal(res.passed, false);
  assert.equal(res.failedCheck, 'migration_safety');
  assert.equal(res.checks[0]!.name, 'migration_safety');
  assert.equal(res.checks[0]!.passed, false);
  // stopOnFirstFailure short-circuits the costly tsc/build checks.
  const tsc = res.checks.find((c) => c.name === 'typescript')!;
  assert.equal(tsc.skipped, true);
});

test('Sentinel migration_safety PASSES a fully-confirmed, non-breaking migration', async () => {
  const res = await runSentinel({
    projectPath: '/proj',
    runCommand: okRunner,
    getFileChanges: async () => null,
    packageJsonContent: '{}',
    log: () => {},
    migrationSafety: { sql: 'alter table contacts add column phone text;', productionSchema: prodSchema() },
    migrationSafetyOptions: { storeHistory: async () => {}, now: () => 'T', log: () => {} },
  });
  const ms = res.checks.find((c) => c.name === 'migration_safety')!;
  assert.equal(ms.passed, true);
  assert.equal(res.checks[0]!.name, 'migration_safety');
});
