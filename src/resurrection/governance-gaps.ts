/**
 * FORGE 2.0 — System 1: governance content-gap detectors (F21).
 *
 * Nine per-artifact detectors. Each reads the artifact's Markdown content (if present) plus
 * the `ScanReport` (ground truth for drift) and returns a flat `Gap[]`. Detectors are pure and
 * read-only (Contract R-1) — they never write to the project.
 *
 * Required-section lists are grounded in the actual FORGE-authored templates
 * (`templates/governance/*.template.md`) and phase writers (`phase0-scout.ts` TOOLCHAIN.md,
 * `phase1a-prd.ts` PRD.md) — not invented.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { ScanReport } from '../retrofit/types.js';
import type { ArtifactName, DriftDetail, Gap } from './types.js';
import { ARTIFACT_FILENAMES, ARTIFACT_NAMES } from './types.js';

/** Required `##` section headers per artifact — the F21 completeness contract. */
export const REQUIRED_SECTIONS: Record<ArtifactName, readonly string[]> = {
  PRD: [
    'User Personas',
    'Feature Specifications',
    'Data Model Overview',
    'Integration Requirements',
    'Success Metrics',
    'Scope Boundaries',
  ],
  SCHEMA_REGISTRY: ['Database', 'Tables', 'Indexes', 'Row-Level Security Policies', 'Seed Data', 'Migrations'],
  AGENTS: ['Orchestration', 'Agent Definitions'],
  BEHAVIORAL_CONTRACTS: [
    'API Contracts',
    'Authentication & Authorization',
    'Interaction Contracts (summary)',
    'Standard FORGE Contracts',
  ],
  BLUEPRINT: [
    'System Identity',
    'System Overview',
    'Technology Stack',
    'Architecture Overview',
    'Project Structure',
    'Environment Variables',
    'Canonical Rules',
  ],
  TOOLCHAIN: [
    'Detected Stack',
    'Locked Tool Versions',
    'Skill Manifest',
    'Environment Variable Checklist',
    'Docker / Build Memory',
    'Blockers',
  ],
  SESSION_STATE: ['Active Build', 'IDE STATUS', 'Notes'],
  STATE_OF_THE_BUILD: ['Phase Status', 'Design Summary', 'Governance Package', 'Codebase Audit', 'Next Step'],
  TESTING: ['Test Plan Overview', 'Playwright Specifications', 'API Tests', 'Six Laws Verification Plan'],
};

const PLACEHOLDER_PATTERNS = [/\bTBD\b/g, /\bTODO\b/g, /\bFIXME\b/g, /\{\{[A-Z_]+\}\}/g, /\bXXX\b/g];

export function findGovernanceDoc(projectPath: string, artifact: ArtifactName): { path: string; content: string } | null {
  const filename = ARTIFACT_FILENAMES[artifact];
  const candidates = [join(projectPath, filename), join(projectPath, 'governance', filename), join(projectPath, 'docs', filename)];
  for (const path of candidates) {
    if (existsSync(path)) {
      try {
        return { path, content: readFileSync(path, 'utf8') };
      } catch {
        /* unreadable — treated as absent */
      }
    }
  }
  return null;
}

function countPlaceholders(content: string): number {
  let total = 0;
  for (const re of PLACEHOLDER_PATTERNS) {
    const matches = content.match(re);
    if (matches) total += matches.length;
  }
  return total;
}

function extractSectionHeaders(content: string): Set<string> {
  const headers = new Set<string>();
  for (const m of content.matchAll(/^##\s+(.+?)\s*$/gm)) {
    headers.add((m[1] ?? '').trim());
  }
  return headers;
}

export interface DetectorResult {
  gaps: Gap[];
  missingSections: string[];
  placeholderCount: number;
  driftDetail: DriftDetail[];
}

function detectMissingSections(artifact: ArtifactName, content: string): { gaps: Gap[]; missingSections: string[] } {
  const required = REQUIRED_SECTIONS[artifact];
  const present = extractSectionHeaders(content);
  const missing = required.filter((h) => !present.has(h));
  const gaps: Gap[] = missing.map((section) => ({
    artifact,
    severity: missing.length > required.length / 2 ? 'MAJOR' : 'MINOR',
    kind: 'MISSING_SECTION',
    message: `${ARTIFACT_FILENAMES[artifact]} is missing required section "## ${section}"`,
    section,
  }));
  return { gaps, missingSections: missing };
}

function detectPlaceholders(artifact: ArtifactName, content: string): { gaps: Gap[]; count: number } {
  const count = countPlaceholders(content);
  if (count === 0) return { gaps: [], count: 0 };
  return {
    gaps: [
      {
        artifact,
        severity: count > 5 ? 'MAJOR' : 'MINOR',
        kind: 'PLACEHOLDER',
        message: `${ARTIFACT_FILENAMES[artifact]} contains ${count} unresolved placeholder occurrence(s) (TBD/TODO/{{...}})`,
      },
    ],
    count,
  };
}

/** SCHEMA_REGISTRY drift: a table the codebase actually uses but the doc never mentions. */
function detectSchemaRegistryDrift(content: string, scanReport: ScanReport | null): { gaps: Gap[]; drift: DriftDetail[] } {
  if (!scanReport) return { gaps: [], drift: [] };
  const gaps: Gap[] = [];
  const drift: DriftDetail[] = [];
  for (const entry of scanReport.schemaAudit) {
    if (entry.issue === 'TABLE_MISSING_IN_TYPES' || entry.issue === 'OK') continue;
    const mentioned = content.includes(entry.tableName);
    if (!mentioned) {
      const detail: DriftDetail = { section: 'Tables', docSays: '(not present)', codeShows: entry.tableName };
      drift.push(detail);
      gaps.push({
        artifact: 'SCHEMA_REGISTRY',
        severity: entry.severity === 'CRITICAL' ? 'CRITICAL' : 'MAJOR',
        kind: 'DRIFT',
        message: `Table "${entry.tableName}" (${entry.issue}) is absent from SCHEMA_REGISTRY.md`,
        section: 'Tables',
        docSays: detail.docSays,
        codeShows: detail.codeShows,
      });
    }
  }
  return { gaps, drift };
}

/** AGENTS drift: API routes the codebase serves that no agent entry documents. */
function detectAgentsDrift(content: string, scanReport: ScanReport | null): { gaps: Gap[]; drift: DriftDetail[] } {
  if (!scanReport) return { gaps: [], drift: [] };
  const gaps: Gap[] = [];
  const drift: DriftDetail[] = [];
  const undocumented = scanReport.routeInventory.filter(
    (r) => r.type === 'API' && !content.includes(r.route) && !content.includes(r.file)
  );
  for (const r of undocumented.slice(0, 20)) {
    const detail: DriftDetail = { section: 'Agent Definitions', docSays: '(not present)', codeShows: r.route };
    drift.push(detail);
    gaps.push({
      artifact: 'AGENTS',
      severity: 'MINOR',
      kind: 'DRIFT',
      message: `API route "${r.route}" (${r.file}) has no documenting agent entry in AGENTS.md`,
      section: 'Agent Definitions',
      docSays: detail.docSays,
      codeShows: detail.codeShows,
    });
  }
  return { gaps, drift };
}

/** BEHAVIORAL_CONTRACTS drift: the doc must still name FORGE's numbered Contracts 1-20. */
function detectBehavioralContractsDrift(content: string): { gaps: Gap[]; drift: DriftDetail[] } {
  const matches = content.match(/Contract\s+(\d+)/g) ?? [];
  const numbers = new Set(matches.map((m) => parseInt(m.replace(/\D/g, ''), 10)));
  const missing = Array.from({ length: 20 }, (_, i) => i + 1).filter((n) => !numbers.has(n));
  if (missing.length === 0) return { gaps: [], drift: [] };
  const drift: DriftDetail[] = [
    { section: 'Standard FORGE Contracts', docSays: `${20 - missing.length}/20 contracts present`, codeShows: '20/20 required' },
  ];
  return {
    gaps: [
      {
        artifact: 'BEHAVIORAL_CONTRACTS',
        severity: missing.length > 5 ? 'CRITICAL' : 'MAJOR',
        kind: 'DRIFT',
        message: `BEHAVIORAL_CONTRACTS.md is missing ${missing.length} of the 20 standard FORGE contracts (missing: ${missing.join(', ')})`,
        section: 'Standard FORGE Contracts',
      },
    ],
    drift,
  };
}

/** STATE_OF_THE_BUILD / SESSION_STATE freshness: reuse ForgeRetrofit's staleness classification. */
function detectStalenessDrift(artifact: ArtifactName, scanReport: ScanReport | null): { gaps: Gap[]; drift: DriftDetail[] } {
  if (!scanReport) return { gaps: [], drift: [] };
  const filename = ARTIFACT_FILENAMES[artifact];
  const entry = scanReport.governanceInventory.find((g) => g.filename === filename);
  if (!entry || entry.staleness === 'CURRENT' || entry.staleness === 'MISSING') return { gaps: [], drift: [] };
  const drift: DriftDetail[] = [
    { section: 'root', docSays: `last modified ${entry.lastModifiedDays ?? '?'}d ago`, codeShows: 'active project (recent commits)' },
  ];
  return {
    gaps: [
      {
        artifact,
        severity: entry.staleness === 'STALE' ? 'MAJOR' : 'MINOR',
        kind: 'DRIFT',
        message: `${filename} is ${entry.staleness} (${entry.lastModifiedDays ?? '?'} days since last edit)`,
      },
    ],
    drift,
  };
}

/** TOOLCHAIN drift: a package.json dependency the manifest never locked. */
function detectToolchainDrift(content: string, scanReport: ScanReport | null): { gaps: Gap[]; drift: DriftDetail[] } {
  if (!scanReport) return { gaps: [], drift: [] };
  const gaps: Gap[] = [];
  const drift: DriftDetail[] = [];
  for (const p of scanReport.packageAudit) {
    if (p.issue === 'OK') continue;
    if (!content.includes(p.name)) {
      const detail: DriftDetail = { section: 'Locked Tool Versions', docSays: '(not present)', codeShows: p.name };
      drift.push(detail);
      gaps.push({
        artifact: 'TOOLCHAIN',
        severity: 'MINOR',
        kind: 'DRIFT',
        message: `Dependency "${p.name}" (${p.issue}) is not tracked in TOOLCHAIN.md's Locked Tool Versions table`,
      });
    }
  }
  return { gaps, drift };
}

/** Cross-document consistency: a table only SCHEMA_REGISTRY knows about, absent from PRD's data model. */
function detectCrossDocConsistency(docs: Partial<Record<ArtifactName, string>>): Gap[] {
  const schema = docs.SCHEMA_REGISTRY;
  const prd = docs.PRD;
  if (!schema || !prd) return [];
  const gaps: Gap[] = [];
  const tableNames = Array.from(schema.matchAll(/^###?\s+`?(\w+)`?\s*$/gm)).map((m) => m[1]).filter((n): n is string => !!n);
  for (const table of tableNames.slice(0, 30)) {
    if (!prd.toLowerCase().includes(table.toLowerCase())) {
      gaps.push({
        artifact: 'SCHEMA_REGISTRY',
        severity: 'MINOR',
        kind: 'CROSS_DOC_CONTRADICTION',
        message: `Table "${table}" appears in SCHEMA_REGISTRY.md but is not referenced anywhere in PRD.md's data model`,
        section: 'Tables',
      });
    }
  }
  return gaps;
}

/**
 * Run all applicable detectors for one artifact. Returns `null` (a MISSING_DOC critical gap,
 * separately) when the file does not exist — the caller (`ArtifactHealthScorer`) handles the
 * `exists_on_disk = 0` case; this function assumes the doc exists.
 */
export function detectGapsForArtifact(
  projectPath: string,
  artifact: ArtifactName,
  content: string,
  scanReport: ScanReport | null,
  allDocs: Partial<Record<ArtifactName, string>>
): DetectorResult {
  const gaps: Gap[] = [];
  let driftDetail: DriftDetail[] = [];

  const missing = detectMissingSections(artifact, content);
  gaps.push(...missing.gaps);

  const placeholders = detectPlaceholders(artifact, content);
  gaps.push(...placeholders.gaps);

  switch (artifact) {
    case 'SCHEMA_REGISTRY': {
      const r = detectSchemaRegistryDrift(content, scanReport);
      gaps.push(...r.gaps);
      driftDetail = driftDetail.concat(r.drift);
      break;
    }
    case 'AGENTS': {
      const r = detectAgentsDrift(content, scanReport);
      gaps.push(...r.gaps);
      driftDetail = driftDetail.concat(r.drift);
      break;
    }
    case 'BEHAVIORAL_CONTRACTS': {
      const r = detectBehavioralContractsDrift(content);
      gaps.push(...r.gaps);
      driftDetail = driftDetail.concat(r.drift);
      break;
    }
    case 'STATE_OF_THE_BUILD':
    case 'SESSION_STATE': {
      const r = detectStalenessDrift(artifact, scanReport);
      gaps.push(...r.gaps);
      driftDetail = driftDetail.concat(r.drift);
      break;
    }
    case 'TOOLCHAIN': {
      const r = detectToolchainDrift(content, scanReport);
      gaps.push(...r.gaps);
      driftDetail = driftDetail.concat(r.drift);
      break;
    }
    case 'PRD':
    case 'BLUEPRINT':
    case 'TESTING':
      // No direct ScanReport signal for these three beyond completeness/placeholders above.
      break;
  }

  if (artifact === 'SCHEMA_REGISTRY' || artifact === 'PRD') {
    gaps.push(...detectCrossDocConsistency(allDocs));
  }

  void projectPath; // reserved for future file-path-scoped detectors
  return { gaps, missingSections: missing.missingSections, placeholderCount: placeholders.count, driftDetail };
}

/** Reads every governance doc present on disk, keyed by artifact — used for cross-doc checks. */
function loadAllDocs(projectPath: string): Partial<Record<ArtifactName, string>> {
  const docs: Partial<Record<ArtifactName, string>> = {};
  for (const artifact of ARTIFACT_NAMES) {
    const doc = findGovernanceDoc(projectPath, artifact);
    if (doc) docs[artifact] = doc.content;
  }
  return docs;
}

/**
 * Per-artifact entry point shared by the nine exported detectors below. `existsOnDisk = false`
 * is always CRITICAL (RESURRECTION_BLUEPRINT §ArtifactHealthScorer — absent doc forces the gate).
 */
function detectArtifactGaps(projectPath: string, artifact: ArtifactName, scanReport: ScanReport): Gap[] {
  const doc = findGovernanceDoc(projectPath, artifact);
  if (!doc) {
    return [
      {
        artifact,
        severity: 'CRITICAL',
        kind: 'MISSING_DOC',
        message: `${ARTIFACT_FILENAMES[artifact]} does not exist on disk`,
      },
    ];
  }
  const allDocs = loadAllDocs(projectPath);
  return detectGapsForArtifact(projectPath, artifact, doc.content, scanReport, allDocs).gaps;
}

/** F21 detector: PRD.md — completeness, placeholders, cross-doc consistency vs SCHEMA_REGISTRY.md. */
export function detectPrdGaps(projectPath: string, scanReport: ScanReport): Gap[] {
  return detectArtifactGaps(projectPath, 'PRD', scanReport);
}

/** F21 detector: BLUEPRINT.md — completeness, placeholders. */
export function detectBlueprintGaps(projectPath: string, scanReport: ScanReport): Gap[] {
  return detectArtifactGaps(projectPath, 'BLUEPRINT', scanReport);
}

/** F21 detector: SCHEMA_REGISTRY.md — completeness, placeholders, table drift vs ScanReport.schemaAudit. */
export function detectSchemaRegistryGaps(projectPath: string, scanReport: ScanReport): Gap[] {
  return detectArtifactGaps(projectPath, 'SCHEMA_REGISTRY', scanReport);
}

/** F21 detector: BEHAVIORAL_CONTRACTS.md — completeness, placeholders, Contract 1-20 presence (CRITICAL on major drift). */
export function detectBehavioralContractsGaps(projectPath: string, scanReport: ScanReport): Gap[] {
  return detectArtifactGaps(projectPath, 'BEHAVIORAL_CONTRACTS', scanReport);
}

/** F21 detector: AGENTS.md — completeness, placeholders, undocumented API routes vs ScanReport.routeInventory. */
export function detectAgentsGaps(projectPath: string, scanReport: ScanReport): Gap[] {
  return detectArtifactGaps(projectPath, 'AGENTS', scanReport);
}

/** F21 detector: TOOLCHAIN.md — completeness, placeholders, untracked dependencies vs ScanReport.packageAudit. */
export function detectToolchainGaps(projectPath: string, scanReport: ScanReport): Gap[] {
  return detectArtifactGaps(projectPath, 'TOOLCHAIN', scanReport);
}

/** F21 detector: SESSION_STATE.md — completeness, placeholders, staleness vs ScanReport.governanceInventory. */
export function detectSessionStateGaps(projectPath: string, scanReport: ScanReport): Gap[] {
  return detectArtifactGaps(projectPath, 'SESSION_STATE', scanReport);
}

/** F21 detector: STATE_OF_THE_BUILD.md — completeness, placeholders, staleness vs ScanReport.governanceInventory. */
export function detectStateOfBuildGaps(projectPath: string, scanReport: ScanReport): Gap[] {
  return detectArtifactGaps(projectPath, 'STATE_OF_THE_BUILD', scanReport);
}

/** F21 detector: TESTING.md — completeness, placeholders. */
export function detectTestingGaps(projectPath: string, scanReport: ScanReport): Gap[] {
  return detectArtifactGaps(projectPath, 'TESTING', scanReport);
}

/** Runs all nine detectors and returns their `Gap[]` keyed by `ArtifactName`. */
export function detectAllGaps(projectPath: string, scanReport: ScanReport): Map<string, Gap[]> {
  const results = new Map<string, Gap[]>();
  results.set('PRD', detectPrdGaps(projectPath, scanReport));
  results.set('BLUEPRINT', detectBlueprintGaps(projectPath, scanReport));
  results.set('SCHEMA_REGISTRY', detectSchemaRegistryGaps(projectPath, scanReport));
  results.set('BEHAVIORAL_CONTRACTS', detectBehavioralContractsGaps(projectPath, scanReport));
  results.set('AGENTS', detectAgentsGaps(projectPath, scanReport));
  results.set('TOOLCHAIN', detectToolchainGaps(projectPath, scanReport));
  results.set('SESSION_STATE', detectSessionStateGaps(projectPath, scanReport));
  results.set('STATE_OF_THE_BUILD', detectStateOfBuildGaps(projectPath, scanReport));
  results.set('TESTING', detectTestingGaps(projectPath, scanReport));
  return results;
}
