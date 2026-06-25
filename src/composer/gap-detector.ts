// FORGE 2.0 - Composer: Gap Detector
import type { GovernanceSuite } from './task-extractor.js';

export interface GapReport {
  missingTables: string[];
  rlsMissingOn: string[];
  missingContracts: string[];
  inconsistencies: string[];
  severity: 'CLEAN' | 'WARNINGS' | 'BLOCKERS';
}

export function detectSchemaGaps(suite: GovernanceSuite): GapReport {
  const report: GapReport = {
    missingTables: [],
    rlsMissingOn: [],
    missingContracts: [],
    inconsistencies: [],
    severity: 'CLEAN',
  };

  const schemaTables = new Set<string>();
  for (const m of suite.schemaRegistry.matchAll(/^##\s+(?:Table:\s*)?`?([a-z_][a-z0-9_]*)`?/gim)) {
    if (m[1]) schemaTables.add(m[1]);
  }

  const rlsTables = new Set<string>();
  for (const m of suite.schemaRegistry.matchAll(/RLS[^\n]*(?:enabled|ON|true)/gi)) {
    const matchStr = m[0];
    if (!matchStr) continue;
    const matchIdx = suite.schemaRegistry.indexOf(matchStr);
    const nearby = suite.schemaRegistry
      .substring(Math.max(0, matchIdx - 500), matchIdx)
      .match(/`([a-z_][a-z0-9_]*)`/g);
    if (nearby) {
      for (const t of nearby) rlsTables.add(t.replace(/`/g, ''));
    }
  }

  const systemTables = new Set(['schema_migrations', 'extensions', 'buckets', 'objects']);
  for (const table of schemaTables) {
    if (!systemTables.has(table) && !rlsTables.has(table)) report.rlsMissingOn.push(table);
  }

  for (const m of suite.agents.matchAll(/^##\s+([A-Za-z][A-Za-z0-9]+(?:Agent|Service|Manager|Handler))/gm)) {
    if (m[1] && !suite.behavioralContracts.includes(m[1])) report.missingContracts.push(m[1]);
  }

  if (report.rlsMissingOn.length > 0 || report.missingContracts.length > 0) report.severity = 'BLOCKERS';
  else if (report.missingTables.length > 0) report.severity = 'WARNINGS';

  return report;
}

export function formatGapReport(report: GapReport): string {
  const lines = ['# FORGE Gap Detection Report', '', 'Severity: ' + report.severity, ''];
  if (report.rlsMissingOn.length > 0) {
    lines.push('## BLOCKERS: Tables Missing RLS');
    for (const t of report.rlsMissingOn) lines.push('- ' + t);
    lines.push('');
  }
  if (report.missingContracts.length > 0) {
    lines.push('## BLOCKERS: Agents Missing Contracts');
    for (const a of report.missingContracts) lines.push('- ' + a);
    lines.push('');
  }
  if (report.severity === 'CLEAN') lines.push('No gaps detected.');
  return lines.join('\n');
}

export async function detectGapsWithClaude(
  suite: GovernanceSuite,
  apiKey: string
): Promise<{ gaps: string[]; blockers: string[]; report: string }> {
  const staticReport = detectSchemaGaps(suite);
  const staticGaps = [
    ...staticReport.rlsMissingOn.map((t) => 'BLOCKER: RLS missing on ' + t),
    ...staticReport.missingContracts.map((a) => 'BLOCKER: No contract for ' + a),
  ];
  try {
    const content =
      'SCHEMA_REGISTRY:\n' +
      suite.schemaRegistry.substring(0, 3000) +
      '\n\nAGENTS:\n' +
      suite.agents.substring(0, 2000) +
      '\n\nBEHAVIORAL_CONTRACTS:\n' +
      suite.behavioralContracts.substring(0, 2000);
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 2000,
        system:
          'Find ALL gaps in these governance docs. Respond ONLY with JSON: { "blockers": string[], "warnings": string[] }',
        messages: [{ role: 'user', content }],
      }),
    });
    if (res.ok) {
      const data = (await res.json()) as { content: Array<{ type: string; text?: string }> };
      const text = data.content
        .filter((c) => c.type === 'text')
        .map((c) => c.text ?? '')
        .join('');
      const parsed = JSON.parse(text.replace(/```json|```/g, '').trim()) as {
        blockers: string[];
        warnings: string[];
      };
      const allGaps = [
        ...(parsed.blockers ?? []).map((b) => 'BLOCKER: ' + b),
        ...(parsed.warnings ?? []).map((w) => 'WARNING: ' + w),
      ];
      if (allGaps.length > staticGaps.length) {
        return {
          gaps: allGaps,
          blockers: parsed.blockers ?? [],
          report: formatGapReport(staticReport),
        };
      }
    }
  } catch {
    /* fall back */
  }
  return {
    gaps: staticGaps,
    blockers: [
      ...staticReport.rlsMissingOn.map((t) => 'RLS missing: ' + t),
      ...staticReport.missingContracts.map((a) => 'No contract: ' + a),
    ],
    report: formatGapReport(staticReport),
  };
}
