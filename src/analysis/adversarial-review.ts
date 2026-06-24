// FORGE 2.0 - Adversarial Review Module
export type AdversaryPhase =
  | 'ARCHITECT_PRD'
  | 'ARCHITECT_GOVERNANCE'
  | 'COMPOSE_QUEUE'
  | 'EXECUTE_PROMPT'
  | 'DIAGNOSE_HEALTH'
  | 'DEPLOY_CANARY';

export type AdversarySeverity = 'BLOCKER' | 'SIGNIFICANT' | 'MINOR' | 'DISMISSED';
export type AdversaryVector = 'SCHEMA' | 'SECURITY' | 'SCALE' | 'INTEGRATION' | 'UX' | 'ARCH' | 'DATA';

export interface AdversaryFinding {
  severity: AdversarySeverity;
  vector: AdversaryVector;
  specificIssue: string;
  evidence: string;
  recommendedFix: string;
}

export interface AdversaryResult {
  phase: AdversaryPhase;
  findings: AdversaryFinding[];
  blockers: AdversaryFinding[];
  significant: AdversaryFinding[];
  minor: AdversaryFinding[];
  canProceed: boolean;
  reviewedAt: string;
  tokensUsed: number;
}

const SYSTEM_PROMPT = `You are a hostile adversarial code reviewer. Your mandate is to PROVE THE WORK IS INSUFFICIENT.
Attack from all vectors: SCHEMA, SECURITY, SCALE, INTEGRATION, UX, ARCH, DATA.
Every finding must cite specific evidence. Generic concerns are rejected. Find minimum 3 issues.
Respond ONLY with a JSON array. No preamble, no markdown.
Each object: { "severity": "BLOCKER"|"SIGNIFICANT"|"MINOR", "vector": "SCHEMA"|"SECURITY"|"SCALE"|"INTEGRATION"|"UX"|"ARCH"|"DATA", "specificIssue": string, "evidence": string, "recommendedFix": string }`;

const PHASE_PROMPTS: Record<AdversaryPhase, string> = {
  ARCHITECT_PRD: `Attack this PRD. Find minimum 5 issues across SCHEMA (missing columns, full-table-scans), SECURITY (auth gaps, cross-tenant access), SCALE (no LIMIT, N+1), INTEGRATION (no error handling), UX (no empty states).\nPRD:\n{content}`,
  ARCHITECT_GOVERNANCE: `Attack this governance suite. Find minimum 3 issues: PRD stories without agents, DB entities without RLS, BLUEPRINT dependency mismatches, BEHAVIORAL_CONTRACTS security gaps, circular agent dependencies.\nGOVERNANCE:\n{content}`,
  COMPOSE_QUEUE: `Attack this prompt queue. Find minimum 3 issues: missing dependencies causing later failures, prompts touching too many files, ordering errors (code before migration), untestable acceptance criteria, vague specs producing stubs.\nQUEUE:\n{content}`,
  EXECUTE_PROMPT: `Attack this code diff. Find minimum 3 issues: security vulnerabilities, scale failures (full scans, N+1), unhandled errors, missing RLS on user-data tables, TypeScript type safety bypasses.\nCODE DIFF:\n{content}`,
  DIAGNOSE_HEALTH: `Attack this health report. Find minimum 3 issues: CRITICAL misclassified as INFO, systemic problems spanning multiple findings, issues that will break in 6 months, missed issues, incorrect recommended fixes.\nHEALTH REPORT:\n{content}`,
  DEPLOY_CANARY: `Attack these canary results. Find minimum 3 issues: silent failures below threshold, migrations causing rollback data loss, env var differences causing runtime failures, untested routes that will fail in production, performance regressions trending toward breach.\nCANARY RESULTS:\n{content}`,
};

export async function runAdversarialReview(
  phase: AdversaryPhase,
  content: string,
  apiKey?: string
): Promise<AdversaryResult> {
  const empty: AdversaryResult = {
    phase, findings: [], blockers: [], significant: [], minor: [],
    canProceed: true, reviewedAt: new Date().toISOString(), tokensUsed: 0,
  };

  const key = apiKey ?? process.env['ANTHROPIC_API_KEY'];
  if (!key) return empty;

  const userPrompt = PHASE_PROMPTS[phase].replace('{content}', content.substring(0, 8000));

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 3000, system: SYSTEM_PROMPT, messages: [{ role: 'user', content: userPrompt }] }),
    });

    if (!res.ok) return empty;

    const data = await res.json() as { content: Array<{ type: string; text?: string }>; usage?: { input_tokens: number; output_tokens: number } };
    const text = data.content.filter(c => c.type === 'text').map(c => c.text ?? '').join('');
    const tokensUsed = (data.usage?.input_tokens ?? 0) + (data.usage?.output_tokens ?? 0);

    let findings: AdversaryFinding[] = [];
    try {
      const parsed = JSON.parse(text.replace(/```json|```/g, '').trim());
      if (Array.isArray(parsed)) findings = parsed as AdversaryFinding[];
    } catch { return { ...empty, tokensUsed }; }

    const blockers = findings.filter(f => f.severity === 'BLOCKER');
    const significant = findings.filter(f => f.severity === 'SIGNIFICANT');
    const minor = findings.filter(f => f.severity === 'MINOR');

    return { phase, findings, blockers, significant, minor, canProceed: blockers.length === 0, reviewedAt: new Date().toISOString(), tokensUsed };
  } catch { return empty; }
}

export function shouldRunAdversarialReview(
  taskType: string,
  filesModified: string[],
  complexity: string,
  historicalFailureRate?: number
): boolean {
  if (filesModified.some(f => /middleware/i.test(f))) return true;
  if (filesModified.some(f => /rls|polic/i.test(f))) return true;
  if (filesModified.some(f => /auth|session|jwt|token/i.test(f))) return true;
  if (filesModified.some(f => /payment|billing|stripe/i.test(f))) return true;
  if (complexity === 'HIGH' || complexity === 'CRITICAL') return true;
  if (complexity === 'MEDIUM' && filesModified.length >= 3) return true;
  if (historicalFailureRate !== undefined && historicalFailureRate > 0.5) return true;
  if (taskType === 'SCAFFOLD' || taskType === 'CONFIG') return false;
  return false;
}

export async function persistAdversaryFindings(
  buildId: string,
  phase: AdversaryPhase,
  result: AdversaryResult,
  dbPath?: string
): Promise<void> {
  if (result.findings.length === 0) return;
  const { homedir } = await import('node:os');
  const { existsSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { randomUUID } = await import('node:crypto');
  const { execSync } = await import('node:child_process');
  const resolved = dbPath ?? join(homedir(), '.forge', 'forge_memory.db');
  if (!existsSync(resolved)) return;
  try {
    for (const f of result.findings) {
      const id = randomUUID();
      const s = (v: string) => (v ?? '').replace(/'/g, "''").substring(0, 500);
      execSync(`sqlite3 "${resolved}" "INSERT OR IGNORE INTO adversary_findings (id,build_id,phase,severity,vector,issue,fix,machine_id) VALUES ('${id}','${s(buildId)}','${s(phase)}','${s(f.severity)}','${s(f.vector)}','${s(f.specificIssue)}','${s(f.recommendedFix)}','unknown')"`, { stdio: 'pipe' });
    }
  } catch { /* non-fatal */ }
}
