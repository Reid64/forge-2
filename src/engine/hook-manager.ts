/**
 * FORGE 2.0 — Hook Manager (lifecycle hook system).
 *
 * Implements automated hooks that fire on build lifecycle events, replacing
 * prompt-embedded governance instructions with system-level enforcement.
 *
 * Built-in hooks (always registered, not overridable):
 *   pre_file_write  — blocks writes to middleware.ts unless explicitly approved
 *   post_file_write — runs `pnpm tsc --noEmit` after every file write
 *   pre_build       — verifies governance docs exist and are readable
 *
 * Custom hooks are loaded from `hooks.json` in the project root via {@link loadHooks},
 * or injected programmatically via {@link registerHook}. All hooks for a given event
 * are sorted by `priority` (ascending — lower number runs first) before firing.
 *
 * If ANY hook returns `action: 'deny'`, {@link fireEvent} short-circuits and the
 * overall result array's first element carries the denial. All `additionalContext`
 * strings from passing hooks are collected and included in the result.
 */

import { execSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { logLine } from '../tools/forge-logger.js';
import { checkGovernanceCompliance } from './governance-gate.js';
import type { Hook, HookEvent, HookResult } from '../types/index.js';

const log = logLine('hook-manager');

// ---------------------------------------------------------------------------
// Governance docs required before a build (pre_build hook)
// ---------------------------------------------------------------------------

const REQUIRED_GOVERNANCE_DOCS = [
  'BLUEPRINT.md',
  'governance/SCHEMA_REGISTRY.md',
  'governance/BEHAVIORAL_CONTRACTS.md',
  'CLAUDE.md',
];

// ---------------------------------------------------------------------------
// Built-in hooks
// ---------------------------------------------------------------------------

const BUILTIN_HOOKS: Hook[] = [
  {
    id: 'builtin:pre_file_write:middleware_guard',
    event: 'pre_file_write',
    script: '__builtin__',
    enabled: true,
    priority: 0,
    description: 'Blocks writes to middleware.ts unless FORGE_ALLOW_MIDDLEWARE=1 is set',
  },
  {
    id: 'builtin:post_file_write:tsc_check',
    event: 'post_file_write',
    script: '__builtin__',
    enabled: true,
    priority: 0,
    description: 'Runs pnpm tsc --noEmit after every file write to catch type regressions immediately',
  },
  {
    id: 'builtin:pre_build:governance_check',
    event: 'pre_build',
    script: '__builtin__',
    enabled: true,
    priority: 0,
    description: 'Verifies required governance docs exist and are readable before any build starts',
  },
  {
    id: 'governance:pre_file_write:governance_gate',
    event: 'pre_file_write',
    script: '__builtin__',
    enabled: true,
    priority: 5,
    description: 'Runs governance compliance checks before every file write (Iron Laws 1, 4, 8 + org-scoping)',
  },
];

// ---------------------------------------------------------------------------
// Built-in hook implementations
// ---------------------------------------------------------------------------

async function runBuiltinHook(
  hook: Hook,
  context: Record<string, unknown>,
): Promise<HookResult> {
  switch (hook.id) {
    case 'builtin:pre_file_write:middleware_guard': {
      const filePath = String(context['filePath'] ?? context['file'] ?? '');
      const isMiddleware =
        filePath.endsWith('middleware.ts') || filePath.endsWith('middleware.js');
      if (isMiddleware && process.env['FORGE_ALLOW_MIDDLEWARE'] !== '1') {
        log(
          `[DENY] middleware_guard blocked write to ${filePath} — set FORGE_ALLOW_MIDDLEWARE=1 to override`,
        );
        return {
          action: 'deny',
          reason:
            'Writes to middleware.ts are blocked by Iron Law 4. Set FORGE_ALLOW_MIDDLEWARE=1 to explicitly approve.',
        };
      }
      return { action: 'allow' };
    }

    case 'builtin:post_file_write:tsc_check': {
      const projectPath = String(context['projectPath'] ?? process.cwd());
      log(`[post_file_write] Running tsc --noEmit in ${projectPath}`);
      try {
        execSync('pnpm tsc --noEmit', {
          cwd: projectPath,
          stdio: 'pipe',
          timeout: 120_000,
        });
        log('[post_file_write] tsc --noEmit passed');
        return { action: 'allow' };
      } catch (err) {
        const stderr =
          err instanceof Error && 'stderr' in err
            ? String((err as Error & { stderr: unknown }).stderr)
            : String(err);
        log(`[post_file_write] tsc --noEmit FAILED:\n${stderr}`);
        return {
          action: 'deny',
          reason: 'TypeScript compilation errors detected after file write (Iron Law 6).',
          additionalContext: stderr,
        };
      }
    }

    case 'builtin:pre_build:governance_check': {
      const projectPath = String(context['projectPath'] ?? process.cwd());
      const missing: string[] = [];
      for (const doc of REQUIRED_GOVERNANCE_DOCS) {
        const fullPath = join(projectPath, doc);
        if (!existsSync(fullPath)) {
          missing.push(doc);
        } else {
          try {
            readFileSync(fullPath, 'utf8');
          } catch {
            missing.push(`${doc} (unreadable)`);
          }
        }
      }
      if (missing.length > 0) {
        const list = missing.join(', ');
        log(`[pre_build] governance_check FAILED — missing: ${list}`);
        return {
          action: 'deny',
          reason: `Required governance docs missing or unreadable: ${list}`,
        };
      }
      log('[pre_build] governance_check passed — all governance docs present');
      return { action: 'allow' };
    }

    case 'governance:pre_file_write:governance_gate': {
      const filePath = String(context['filePath'] ?? context['file'] ?? '');
      const content = String(context['content'] ?? '');
      const projectPath = String(context['projectPath'] ?? process.cwd());
      const result = await checkGovernanceCompliance(filePath, content, projectPath);
      if (!result.allowed) {
        return {
          action: 'deny',
          reason: result.violations.join(' | '),
          additionalContext: result.suggestions.join(' | '),
        };
      }
      return { action: 'allow' };
    }

    default:
      return { action: 'allow' };
  }
}

// ---------------------------------------------------------------------------
// HookManager
// ---------------------------------------------------------------------------

export class HookManager {
  private hooks: Hook[] = [...BUILTIN_HOOKS];

  /**
   * Load hooks from `<projectPath>/hooks.json`. Merges with existing registered hooks;
   * built-in hooks are never replaced. Malformed JSON is logged and skipped.
   */
  loadHooks(projectPath: string): void {
    const hooksPath = join(projectPath, 'hooks.json');
    if (!existsSync(hooksPath)) {
      log(`No hooks.json found at ${hooksPath} — only built-in hooks active`);
      return;
    }
    try {
      const raw = readFileSync(hooksPath, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        log('hooks.json must export a JSON array of Hook objects — skipping');
        return;
      }
      let loaded = 0;
      for (const item of parsed as unknown[]) {
        if (isHook(item)) {
          this.registerHook(item);
          loaded++;
        } else {
          log(`Skipping malformed hook entry: ${JSON.stringify(item)}`);
        }
      }
      log(`Loaded ${loaded} hook(s) from ${hooksPath}`);
    } catch (err) {
      log(`Failed to parse hooks.json: ${String(err)}`);
    }
  }

  /**
   * Register a hook programmatically. Built-in hook IDs (prefixed `builtin:`) are
   * protected — registering one silently no-ops to avoid accidental overwrites.
   */
  registerHook(hook: Hook): void {
    if (hook.id.startsWith('builtin:')) {
      log(`Cannot override built-in hook "${hook.id}" — skipping`);
      return;
    }
    const existing = this.hooks.findIndex((h) => h.id === hook.id);
    if (existing !== -1) {
      this.hooks[existing] = hook;
      log(`Updated hook "${hook.id}" (event=${hook.event}, priority=${hook.priority})`);
    } else {
      this.hooks.push(hook);
      log(`Registered hook "${hook.id}" (event=${hook.event}, priority=${hook.priority})`);
    }
  }

  /**
   * Fire all enabled hooks for `event`, sorted by `priority` ascending.
   *
   * - If ANY hook returns `action: 'deny'`, execution stops immediately and the
   *   result array contains only that single denial result.
   * - Otherwise returns all results; callers can inspect `additionalContext` strings
   *   for injecting into the next prompt.
   */
  async fireEvent(
    event: HookEvent,
    context: Record<string, unknown>,
  ): Promise<HookResult[]> {
    const candidates = this.hooks
      .filter((h) => h.enabled && h.event === event)
      .sort((a, b) => a.priority - b.priority);

    if (candidates.length === 0) {
      return [{ action: 'allow' }];
    }

    log(`Firing ${candidates.length} hook(s) for event "${event}"`);

    const results: HookResult[] = [];

    for (const hook of candidates) {
      log(`  → Hook "${hook.id}" (priority=${hook.priority}): ${hook.description}`);

      let result: HookResult;
      if (hook.script === '__builtin__') {
        result = await runBuiltinHook(hook, context);
      } else {
        result = await runScriptHook(hook, context);
      }

      log(
        `  ← Hook "${hook.id}" returned action="${result.action}"` +
          (result.reason ? ` reason="${result.reason}"` : ''),
      );

      if (result.action === 'deny') {
        return [result];
      }

      results.push(result);
    }

    return results;
  }

  /** Returns a snapshot of all currently registered hooks (built-in + custom). */
  getHooks(): Hook[] {
    return [...this.hooks];
  }
}

// ---------------------------------------------------------------------------
// Script-based hook runner
// ---------------------------------------------------------------------------

async function runScriptHook(
  hook: Hook,
  context: Record<string, unknown>,
): Promise<HookResult> {
  try {
    const contextJson = JSON.stringify(context);
    const output = execSync(`${hook.script} ${shellEscape(contextJson)}`, {
      stdio: 'pipe',
      timeout: 60_000,
      env: { ...process.env, FORGE_HOOK_CONTEXT: contextJson },
    });
    const stdout = output.toString().trim();
    if (!stdout) {
      return { action: 'allow' };
    }
    const parsed: unknown = JSON.parse(stdout);
    if (isHookResult(parsed)) {
      return parsed;
    }
    log(`Hook "${hook.id}" returned non-HookResult JSON — treating as allow`);
    return { action: 'allow' };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`Hook "${hook.id}" script failed: ${message}`);
    return {
      action: 'deny',
      reason: `Hook script "${hook.id}" exited with an error: ${message}`,
    };
  }
}

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

function isHook(value: unknown): value is Hook {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v['id'] === 'string' &&
    typeof v['event'] === 'string' &&
    typeof v['script'] === 'string' &&
    typeof v['enabled'] === 'boolean' &&
    typeof v['priority'] === 'number' &&
    typeof v['description'] === 'string'
  );
}

function isHookResult(value: unknown): value is HookResult {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    v['action'] === 'allow' || v['action'] === 'deny' || v['action'] === 'modify'
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function shellEscape(str: string): string {
  return `'${str.replace(/'/g, "'\\''")}'`;
}
