// FORGE 2.0 — RETROFIT RECONCILE + QUEUE + RENDERER + PIPELINE
import { createInterface } from 'node:readline';
import { existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { homedir } from 'node:os';
import type { ReconcileDecision, DiagnoseFinding, ScanScope } from './types.js';
import type { GovernanceReconciliationReport, EnterprisePatternsGapReport } from './diagnose.js';
import { runScan } from './scan.js';
import { generateArchitectureHealthReport, buildGovernanceReconciliationReport, buildEnterprisePatternsGapReport } from './diagnose.js';
import { runDeepAnalysis, renderDeepAnalysisContextBlock, writeDeepAnalysisReport } from './deep-analysis.js';

// ── RECONCILE ──────────────────────────────────────────────────────────────────
export interface ReconcileInput { criticalFindings: DiagnoseFinding[]; warnFindings: DiagnoseFinding[]; governanceReport: GovernanceReconciliationReport; enterpriseReport: EnterprisePatternsGapReport; dbPath?: string; }
export interface ReconcileOutput { decisions: ReconcileDecision[]; approved: DiagnoseFinding[]; deferred: string[]; abandoned: string[]; confirmedAt: string; }

function ask(rl: ReturnType<typeof createInterface>, q: string): Promise<string> { return new Promise(res => rl.question(q, res)); }
function dbPath(override?: string): string { return override ?? join(homedir(), '.forge', 'forge_memory.db'); }

function loadPrior(projectName: string, db?: string): ReconcileDecision[] {
  const p = dbPath(db); if (!existsSync(p)) return [];
  try { const raw = execSync(`sqlite3 "${p}" "SELECT item_id,item_type,decision,reason FROM reconcile_decisions WHERE project_name='${projectName.replace(/'/g,"''")}' ORDER BY timestamp DESC"`, { stdio: 'pipe' }).toString().trim(); if (!raw) return []; return raw.split('\n').map(line => { const [itemId,itemType,decision,reason] = line.split('|'); return { itemId, itemType, decision, reason, timestamp: '' } as ReconcileDecision; }); }
  catch { return []; }
}

function persist(d: ReconcileDecision, projectName: string, db?: string): void {
  const p = dbPath(db); if (!existsSync(p)) return;
  const s = (v: string) => v.replace(/'/g,"''");
  try { execSync(`sqlite3 "${p}" "INSERT OR REPLACE INTO reconcile_decisions (id,project_name,item_id,item_type,decision,reason,timestamp) VALUES (hex(randomblob(16)),'${s(projectName)}','${s(d.itemId)}','${s(d.itemType)}','${s(d.decision)}','${s(d.reason??'')}','${s(d.timestamp)}')"`, { stdio: 'pipe' }); } catch {}
}

export async function runReconcile(projectName: string, input: ReconcileInput, nonInteractive = false, acceptBlockers = false): Promise<ReconcileOutput> {
  const decisions: ReconcileDecision[] = []; const approved: DiagnoseFinding[] = []; const deferred: string[] = []; const abandoned: string[] = [];
  const prior = loadPrior(projectName, input.dbPath);
  if (nonInteractive || acceptBlockers) {
    for (const f of input.criticalFindings) { decisions.push({ itemId: f.message, itemType: 'CRITICAL_FIX', decision: 'APPROVE', timestamp: new Date().toISOString() }); approved.push(f); }
    for (const f of input.warnFindings) { decisions.push({ itemId: f.message, itemType: 'WARN_FIX', decision: 'APPROVE', timestamp: new Date().toISOString() }); approved.push(f); }
    for (const u of input.governanceReport.unbuilt) { const dec = u.recommendation === 'ABANDON' ? 'ABANDON' : 'BUILD'; decisions.push({ itemId: u.feature, itemType: 'UNBUILT_FEATURE', decision: dec, timestamp: new Date().toISOString() }); if (dec === 'ABANDON') abandoned.push(u.feature); else deferred.push(u.feature); }
    for (const g of input.enterpriseReport.gaps.filter(g => !g.present)) { decisions.push({ itemId: g.pattern, itemType: 'ENTERPRISE_PATTERN', decision: 'BUILD', timestamp: new Date().toISOString() }); }
    for (const d of decisions) persist(d, projectName, input.dbPath);
    return { decisions, approved, deferred, abandoned, confirmedAt: new Date().toISOString() };
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  console.log('\n╔══════════════════════════════════════╗\n  FORGE 2.0 — RETROFIT RECONCILE\n╚══════════════════════════════════════╝\n');
  if (prior.length) console.log(`  ${prior.length} prior decisions loaded.\n`);
  if (input.criticalFindings.length) {
    console.log(`\n── CRITICAL (${input.criticalFindings.length}) — ENTER to approve, SKIP to override ──`);
    for (const f of input.criticalFindings) { const p = prior.find(x => x.itemId === f.message); const ans = await ask(rl, `  [CRITICAL] ${f.category}: ${f.message}${p?` [Prior: ${p.decision}]`:''}\n  > `); if (ans.toUpperCase().startsWith('SKIP')) decisions.push({ itemId: f.message, itemType: 'CRITICAL_FIX', decision: 'SKIP', reason: ans.slice(4).trim(), timestamp: new Date().toISOString() }); else { decisions.push({ itemId: f.message, itemType: 'CRITICAL_FIX', decision: 'APPROVE', timestamp: new Date().toISOString() }); approved.push(f); } }
  }
  if (input.governanceReport.unbuilt.length) {
    console.log(`\n── UNBUILT (${input.governanceReport.unbuilt.length}) — B/D/A ──`);
    for (const u of input.governanceReport.unbuilt) { const p = prior.find(x => x.itemId === u.feature); const ans = (await ask(rl, `  ${u.feature}${p?` [Prior: ${p.decision}]`:''} (B/D/A): `)).toUpperCase().trim(); const dec: ReconcileDecision['decision'] = ans==='B'?'BUILD':ans==='A'?'ABANDON':'DEFER'; const d: ReconcileDecision = { itemId: u.feature, itemType: 'UNBUILT_FEATURE', decision: dec, timestamp: new Date().toISOString() }; decisions.push(d); persist(d, projectName, input.dbPath); if (dec==='ABANDON') abandoned.push(u.feature); else if (dec==='DEFER') deferred.push(u.feature); }
  }
  if (input.warnFindings.length) {
    console.log(`\n── WARN (${input.warnFindings.length}) — A/S/I ──`);
    const ans = (await ask(rl, '[A]pprove all / [S]elect / [I]gnore all: ')).toUpperCase().trim();
    for (const f of input.warnFindings) { if (ans==='A') { decisions.push({ itemId: f.message, itemType: 'WARN_FIX', decision: 'APPROVE', timestamp: new Date().toISOString() }); approved.push(f); } else if (ans==='S') { const a = (await ask(rl, `  ${f.category}: ${f.message} (Y/n): `)).toUpperCase().trim(); if (a!=='N') { decisions.push({ itemId: f.message, itemType: 'WARN_FIX', decision: 'APPROVE', timestamp: new Date().toISOString() }); approved.push(f); } else decisions.push({ itemId: f.message, itemType: 'WARN_FIX', decision: 'IGNORE', timestamp: new Date().toISOString() }); } else decisions.push({ itemId: f.message, itemType: 'WARN_FIX', decision: 'IGNORE', timestamp: new Date().toISOString() }); }
  }
  const gaps = input.enterpriseReport.gaps.filter(g => !g.present);
  if (gaps.length) { console.log(`\n── ENTERPRISE PATTERNS (${gaps.length} gaps) ──`); for (const g of gaps) { const a = (await ask(rl, `  Inject '${g.pattern}'? (y/N): `)).toUpperCase().trim(); decisions.push({ itemId: g.pattern, itemType: 'ENTERPRISE_PATTERN', decision: a==='Y'?'BUILD':'DEFER', timestamp: new Date().toISOString() }); } }
  const confirm = (await ask(rl, '\nProceed to QUEUE? (Y/n): ')).toUpperCase().trim();
  rl.close();
  if (confirm === 'N') { console.log('Aborted.'); process.exit(0); }
  for (const d of decisions) persist(d, projectName, input.dbPath);
  return { decisions, approved, deferred, abandoned, confirmedAt: new Date().toISOString() };
}

// ── QUEUE GENERATOR ───────────────────────────────────────────────────────────
/** Mirrors `src/engine/queue-generator.ts`'s `PromptType` — kept as a literal union here (not
 * imported) since retrofit's queue.yaml is hand-serialized, not built via `serializeQueue`. */
export type RetrofitPromptType = 'schema' | 'auth' | 'api' | 'ui' | 'feature' | 'agent' | 'test' | 'deploy';
export interface QueuePrompt { id: string; tier: string; name: string; dependsOn: string[]; prompt: string; promptType: RetrofitPromptType; }
export interface GeneratedQueue { buildId: string; projectName: string; totalPrompts: number; tiers: { critical_fixes: number; warn_fixes_and_features: number; enterprise_patterns: number }; prompts: QueuePrompt[]; generatedAt: string; }

const sid = (prefix: string, i: number) => `${prefix}-${String(i+1).padStart(3,'0')}`;

/**
 * Infer a {@link RetrofitPromptType} from a finding's free-text category/message (or an
 * enterprise pattern name) via keyword match, defaulting to `'feature'`. `queue.yaml`'s
 * `prompt_type` is a REQUIRED field (`phase3-executor.ts`'s `coerceQueueEntry` silently SKIPS
 * any entry missing it) — without this, every retrofit-generated prompt was unusable by a
 * subsequent `forge build --use-existing-queue`, and the downstream skills-injection call
 * (`buildSkillsContext(ctx.projectPath, promptText, entry.prompt_type)`) degraded to its
 * weakest whole-library fallback for lack of a `prompt_type` to match against.
 */
function inferPromptType(text: string): RetrofitPromptType {
  const t = text.toLowerCase();
  if (/\b(schema|migration|database|table|column|rls|sql)\b/.test(t)) return 'schema';
  if (/\b(auth|jwt|session|login|rbac|permission)\b/.test(t)) return 'auth';
  if (/\b(api|route|endpoint|webhook)\b/.test(t)) return 'api';
  if (/\b(ui|component|accessibility|a11y|wcag|css|style|design)\b/.test(t)) return 'ui';
  if (/\b(agent|orchestrat)\b/.test(t)) return 'agent';
  if (/\b(test|coverage|spec)\b/.test(t)) return 'test';
  if (/\b(deploy|ci|cd|pipeline|vercel|docker)\b/.test(t)) return 'deploy';
  return 'feature';
}

export function generateRetrofitQueue(projectName: string, projectPath: string, reconcile: ReconcileOutput, outputPath: string, deepAnalysisContext?: string): GeneratedQueue {
  const prompts: QueuePrompt[] = [];
  const criticals = reconcile.decisions.filter(d => d.itemType==='CRITICAL_FIX' && d.decision==='APPROVE').map(d => reconcile.approved.find(f => f.message===d.itemId)).filter((f): f is DiagnoseFinding => !!f);
  const warns = reconcile.decisions.filter(d => d.itemType==='WARN_FIX' && d.decision==='APPROVE').map(d => reconcile.approved.find(f => f.message===d.itemId)).filter((f): f is DiagnoseFinding => !!f);
  const patterns = reconcile.decisions.filter(d => d.itemType==='ENTERPRISE_PATTERN' && d.decision==='BUILD').map(d => d.itemId);
  // Deep analysis findings (dead code, orphaned routes, schema drift, dependency issues,
  // coverage gaps) — a concise digest, never the full report — appended as context to every
  // generated prompt so agents see it alongside their specific fix instructions.
  const contextSuffix = deepAnalysisContext ? `\n\n${deepAnalysisContext}` : '';

  criticals.forEach((f,i) => prompts.push({ id: sid('RC',i), tier: 'CRITICAL', name: `Fix CRITICAL: ${f.category} — ${f.message.substring(0,60)}`, dependsOn: i>0?[sid('RC',i-1)]:[], promptType: inferPromptType(`${f.category} ${f.message}`), prompt: `Fix CRITICAL issue in ${projectPath}.\n\nISSUE (${f.category}): ${f.message}${f.file?'\nFILE: '+f.file:''}\n\nFix completely. Run: pnpm tsc --noEmit — must pass 0 errors.\nUpdate STATE_OF_THE_BUILD.md and SESSION_STATE.md.${contextSuffix}` }));
  warns.forEach((f,i) => { const prior = i>0?[sid('RW',i-1)]:criticals.length>0?[sid('RC',criticals.length-1)]:[];prompts.push({ id: sid('RW',i), tier: 'WARN', name: `Fix WARN: ${f.category}`, dependsOn: prior, promptType: inferPromptType(`${f.category} ${f.message}`), prompt: `Fix WARN issue in ${projectPath}.\n\nISSUE (${f.category}): ${f.message}\n\nFix cleanly. Run: pnpm tsc --noEmit.\nUpdate STATE_OF_THE_BUILD.md and SESSION_STATE.md.${contextSuffix}` }); });
  const lastId = warns.length>0?sid('RW',warns.length-1):criticals.length>0?sid('RC',criticals.length-1):undefined;
  patterns.forEach((p,i) => prompts.push({ id: sid('RE',i), tier: 'ENTERPRISE', name: `Inject: ${p}`, dependsOn: i>0?[sid('RE',i-1)]:lastId?[lastId]:[], promptType: inferPromptType(p), prompt: `Inject '${p}' pattern into ${projectPath}.\n\nImplement for Next.js/TypeScript/Supabase.\nRun: pnpm tsc --noEmit && pnpm build.\nUpdate STATE_OF_THE_BUILD.md and SESSION_STATE.md.${contextSuffix}` }));

  const queue: GeneratedQueue = { buildId: `forge-retrofit-${projectName}-${Date.now()}`, projectName, totalPrompts: prompts.length, tiers: { critical_fixes: criticals.length, warn_fixes_and_features: warns.length, enterprise_patterns: patterns.length }, prompts, generatedAt: new Date().toISOString() };
  mkdirSync(outputPath, { recursive: true });
  const lines = [`project: ${projectName}`,'','governance:','  - BLUEPRINT.md','  - STATE_OF_THE_BUILD.md','  - SESSION_STATE.md','  - SCHEMA_REGISTRY.md','  - BEHAVIORAL_CONTRACTS.md','  - AGENTS.md','','settings:','  build_model: claude-sonnet-4-6','  max_retries: 3','','prompts:'];
  for (const p of prompts) { lines.push(`  - id: ${p.id}`); lines.push(`    name: "${p.name.replace(/"/g,'\\"')}"`); lines.push(`    prompt_type: ${p.promptType}`); if (p.dependsOn.length) { lines.push('    depends_on:'); for (const d of p.dependsOn) lines.push(`      - ${d}`); } lines.push('    prompt: |'); for (const l of p.prompt.split('\n')) lines.push(`      ${l}`); lines.push(''); }
  writeFileSync(join(outputPath, 'queue.yaml'), lines.join('\n'), 'utf8');
  return queue;
}

// ── PIPELINE ──────────────────────────────────────────────────────────────────
export interface RetrofitPipelineOptions { projectPath: string; scope?: ScanScope; skipDynamic?: boolean; resume?: boolean; nonInteractive?: boolean; acceptBlockers?: boolean; queueOutputPath?: string; apiKey?: string; }

export async function runRetrofitPipeline(options: RetrofitPipelineOptions): Promise<void> {
  const { projectPath, scope = 'C', skipDynamic = false, resume = false, nonInteractive = false, acceptBlockers = false, queueOutputPath, apiKey } = options;
  const projectName = projectPath.split(/[/\\]/).pop() ?? 'unknown';
  const C = { reset:'\x1b[0m', red:'\x1b[31m', yellow:'\x1b[33m', green:'\x1b[32m', cyan:'\x1b[36m', bold:'\x1b[1m' };
  console.log(`\n${C.bold}${C.cyan}  FORGE 2.0 RETROFIT | ${projectName} | Scope ${scope}${C.reset}\n`);

  const { report, preFlightHalted } = await runScan({ projectPath, scope, skipDynamic, resume, onProgress: (step, i, total) => { const pct = Math.round((i/total)*100); process.stdout.write(`\r  [${C.cyan}${'='.repeat(Math.floor(pct/5))}${' '.repeat(20-Math.floor(pct/5))}${C.reset}] ${pct}% ${step}          `); if (i===total) process.stdout.write('\n'); } });
  if (preFlightHalted) { console.error('Pre-flight FAILED. Aborted.'); process.exit(1); }

  console.log(`\n  ${C.green}SCAN complete.${C.reset} Files: ${report.fileTree.totalFiles} | Broken imports: ${C.red}${report.brokenImports.length}${C.reset} | TS errors: ${C.red}${report.compilationErrors.length}${C.reset}`);

  console.log(`\n  ${C.cyan}Running deep analysis (dead code, orphaned routes, schema drift, dependencies, coverage)...${C.reset}`);
  const deepAnalysis = await runDeepAnalysis(projectPath);
  const deepAnalysisReportPath = await writeDeepAnalysisReport(deepAnalysis);
  const deepAnalysisContext = renderDeepAnalysisContextBlock(deepAnalysis, deepAnalysisReportPath);
  console.log(
    `  Deep analysis: health score ${C.bold}${deepAnalysis.healthScore}/100${C.reset} — ` +
      `${deepAnalysis.deadCode.length} dead code, ${deepAnalysis.orphanedRoutes.length} orphaned routes, ` +
      `${deepAnalysis.schemaDrift.length} schema drift, ${deepAnalysis.dependencies.length} dependency issue(s), ` +
      `${deepAnalysis.coverage.filter(f => f.priority !== 'low').length} coverage gap(s) — ${deepAnalysisReportPath}`
  );

  const health = await generateArchitectureHealthReport(report, apiKey);
  console.log(`\n  CRITICAL: ${C.red}${health.critical.length}${C.reset} | WARN: ${C.yellow}${health.warn.length}${C.reset} | INFO: ${health.info.length}`);
  if (health.critical.length) for (const f of health.critical) console.log(`    ${C.red}[CRITICAL]${C.reset} [${f.category}] ${f.message}${f.file?' ('+f.file+')':''}`);

  const governance = buildGovernanceReconciliationReport(report, projectPath);
  const enterprise = buildEnterprisePatternsGapReport(report, projectPath);

  const reconciled = await runReconcile(projectName, { criticalFindings: health.critical, warnFindings: health.warn, governanceReport: governance, enterpriseReport: enterprise }, nonInteractive, acceptBlockers);

  const outPath = queueOutputPath ?? join(process.env['USERPROFILE'] ?? process.env['HOME'] ?? homedir(), 'Documents', 'FORGE', 'projects', projectName);
  const queue = generateRetrofitQueue(projectName, projectPath, reconciled, outPath, deepAnalysisContext);

  console.log(`\n${C.bold}${C.green}  QUEUE GENERATED: ${queue.totalPrompts} prompts → ${outPath}/queue.yaml${C.reset}`);
  console.log(`  Tier 1 CRITICAL: ${queue.tiers.critical_fixes} | Tier 2 WARN/FEAT: ${queue.tiers.warn_fixes_and_features} | Tier 3 ENTERPRISE: ${queue.tiers.enterprise_patterns}`);
}
