// FORGE 2.0 - SESSION_HANDOFF.md Generator
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export interface HandoffOptions {
  projectPath: string;
  buildId: string;
  runNumber: number;
  projectName: string;
  endReason: 'COMPLETED' | 'PAUSED' | 'FAILED' | 'INTERRUPTED';
  promptsExecuted: number;
  promptsPassed: number;
  promptsFailed: number;
  firstPassRate: number;
  durationMinutes: number;
  startTime: Date;
  lastPromptExecuted: number;
  queueTotal: number;
  queueRemaining: number;
  activeBlockers: string[];
  filesModifiedThisRun: string[];
  gitCommitSha: string | null;
  gitDirty: boolean;
  buildFingerprint: string;
  apiKey?: string;
}

export async function generateSessionHandoff(opts: HandoffOptions): Promise<string> {
  const {
    projectPath, buildId, runNumber, projectName, endReason,
    promptsExecuted, promptsPassed, promptsFailed, firstPassRate,
    durationMinutes, startTime, lastPromptExecuted, queueTotal,
    queueRemaining, activeBlockers, filesModifiedThisRun,
    gitCommitSha, gitDirty, buildFingerprint, apiKey,
  } = opts;

  const completedCount = queueTotal - queueRemaining;

  const lines: string[] = [
    `# FORGE 2.0 -- Session Handoff`,
    `**Project:** ${projectName}`,
    `**Build ID:** ${buildId}`,
    `**Run:** ${runNumber}`,
    `**Generated:** ${new Date().toISOString()}`,
    `**End Reason:** ${endReason}`,
    ``,
    `---`,
    ``,
    `## 1. Build Summary`,
    ``,
    `| Metric | Value |`,
    `|--------|-------|`,
    `| Prompts Executed | ${promptsExecuted} |`,
    `| Passed | ${promptsPassed} |`,
    `| Failed | ${promptsFailed} |`,
    `| First-Pass Rate | ${(firstPassRate * 100).toFixed(1)}% |`,
    `| Duration | ${durationMinutes} minutes |`,
    `| Start Time | ${startTime.toISOString()} |`,
    ``,
    `---`,
    ``,
    `## 2. Queue Status`,
    ``,
    `| Metric | Value |`,
    `|--------|-------|`,
    `| Total Prompts | ${queueTotal} |`,
    `| Completed | ${completedCount} |`,
    `| Remaining | ${queueRemaining} |`,
    `| Next Prompt Index | ${lastPromptExecuted + 1} |`,
    ``,
    `---`,
    ``,
    `## 3. Active Blockers`,
    ``,
    ...(activeBlockers.length > 0 ? activeBlockers.map(b => `- ${b}`) : ['None.']),
    ``,
    `---`,
    ``,
    `## 4. Git State`,
    ``,
    `- Commit: ${gitCommitSha?.substring(0, 8) ?? 'unknown'}`,
    `- Dirty: ${gitDirty ? 'YES -- uncommitted changes exist' : 'Clean'}`,
    `- Fingerprint: ${buildFingerprint.substring(0, 16)}...`,
    ``,
    `---`,
    ``,
    `## 5. Files Modified This Run`,
    ``,
    ...(filesModifiedThisRun.length > 0
      ? [
          ...filesModifiedThisRun.slice(0, 30).map(f => `- ${f}`),
          ...(filesModifiedThisRun.length > 30 ? [`... and ${filesModifiedThisRun.length - 30} more`] : []),
        ]
      : ['None recorded.']),
    ``,
    `---`,
    ``,
    `## 6. Next Run Launch Command`,
    ``,
    `\`\`\`powershell`,
    `cd C:\\Users\\manag\\Documents\\FORGE; $env:NODE_OPTIONS="--max-old-space-size=8192"; $env:ANTHROPIC_API_KEY=$null; $env:DANGEROUSLY_SKIP_PERMISSIONS=1; powershell -ExecutionPolicy Bypass -File .\\forge.ps1 -project ${projectName} -startFrom ${lastPromptExecuted + 1}`,
    `\`\`\``,
    ``,
    `---`,
    ``,
  ];

  let enriched = lines.join('\n');

  const key = apiKey ?? process.env['ANTHROPIC_API_KEY'];
  if (key && promptsExecuted > 0) {
    try {
      const context = [
        `Project: ${projectName}`,
        `Run: ${runNumber}`,
        `End: ${endReason}`,
        `Passed: ${promptsPassed}/${promptsExecuted}`,
        `Failed: ${promptsFailed}`,
        `Files: ${filesModifiedThisRun.slice(0, 10).join(', ')}`,
        `Blockers: ${activeBlockers.join(', ') || 'none'}`,
        `Remaining: ${queueRemaining} prompts`,
      ].join('\n');

      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': key,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6',
          max_tokens: 1000,
          messages: [{
            role: 'user',
            content: `Write three short markdown sections (start with ## 7, no preamble):\n\n## 7. What Was Built\n## 8. Recommendations\n## 9. Notes\n\nBased on:\n${context}`,
          }],
        }),
      });

      if (res.ok) {
        const data = await res.json() as { content: Array<{ type: string; text?: string }> };
        const addition = data.content.filter(c => c.type === 'text').map(c => c.text ?? '').join('');
        if (addition.trim()) enriched = enriched + addition;
      }
    } catch { /* non-fatal */ }
  }

  const forgeDir = join(projectPath, '.forge');
  mkdirSync(forgeDir, { recursive: true });
  const handoffPath = join(forgeDir, 'SESSION_HANDOFF.md');
  writeFileSync(handoffPath, enriched, 'utf8');
  console.log(`[SESSION] Handoff written: ${handoffPath}`);
  return handoffPath;
}
