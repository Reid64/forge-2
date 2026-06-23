/**
 * FORGE 2.0 — Governance Gate (pre-commit governance enforcement).
 *
 * Converts governance rules from prompt-level suggestions to system-level gates
 * that cannot be bypassed. Integrates with HookManager as a `pre_file_write`
 * builtin so every file the build agent writes passes compliance checks.
 *
 * Two public entry points:
 *   checkGovernanceCompliance — file-level check (middleware, governance docs,
 *                               API scoping, hardcoded secrets).
 *   runSixLawsCheck           — full Six Laws verification via six-laws-verifier.
 *
 * Register the hook with: registerGovernanceHook(hookManagerInstance)
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { logLine } from '../tools/forge-logger.js';
import { verifySixLaws } from '../analysis/six-laws-verifier.js';
import type { GovernanceCheckResult, Hook, SixLawsResult } from '../types/index.js';

const log = logLine('governance-gate');

// ---------------------------------------------------------------------------
// Governance doc names — always READ-ONLY (Iron Law 1)
// ---------------------------------------------------------------------------

const GOVERNANCE_DOC_NAMES = new Set([
  'BLUEPRINT.md',
  'SCHEMA_REGISTRY.md',
  'BEHAVIORAL_CONTRACTS.md',
  'CLAUDE.md',
  'STATE_OF_THE_BUILD.md',
  'SESSION_STATE.md',
]);

// ---------------------------------------------------------------------------
// Secret / credential detection patterns
// Matches literal credential values assigned in source code.
// Does NOT flag process.env references or import statements.
// ---------------------------------------------------------------------------

const SECRET_PATTERNS: RegExp[] = [
  // Anthropic / OpenAI secret key format
  /\bsk-[A-Za-z0-9]{30,}\b/,
  // Stripe secret key
  /\bsk_(?:live|test)_[A-Za-z0-9]{24,}\b/,
  // JWT — only match full JWTs (three base64url segments), not env-var lines
  /(?<![/\w])eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}(?![A-Za-z0-9_-])/,
  // Generic: secret-sounding name directly assigned to a quoted literal (not process.env)
  /(?:api[_-]?key|api[_-]?secret|secret[_-]?key|auth[_-]?token|access[_-]?token|service[_-]?role[_-]?key)\s*[:=]\s*['"`][A-Za-z0-9+/\-_]{24,}['"`]/i,
];

// ---------------------------------------------------------------------------
// checkGovernanceCompliance
// ---------------------------------------------------------------------------

export async function checkGovernanceCompliance(
  filePath: string,
  content: string,
  projectPath: string,
): Promise<GovernanceCheckResult> {
  const violations: string[] = [];
  const suggestions: string[] = [];
  const normalized = filePath.replace(/\\/g, '/');

  // 1. middleware.ts — deny unless explicitly approved.
  if (/middleware\.[jt]s$/.test(normalized)) {
    const envApproved = process.env['FORGE_ALLOW_MIDDLEWARE'] === '1';
    const configApproved = readQueueConfig(projectPath)?.allow_middleware === true;
    if (!envApproved && !configApproved) {
      violations.push(
        'Iron Law 4: writes to middleware.ts are blocked. ' +
          'Set FORGE_ALLOW_MIDDLEWARE=1 or "allow_middleware": true in forge.config.json.',
      );
      suggestions.push(
        'Set FORGE_ALLOW_MIDDLEWARE=1 in the build environment, or add ' +
          '{"allow_middleware": true} to forge.config.json at the project root.',
      );
      log(`[DENY] middleware guard blocked write to ${filePath}`);
      return { allowed: false, violations, suggestions };
    }
  }

  // 2. Governance docs — always deny (Iron Law 1).
  const basename = normalized.split('/').pop() ?? '';
  if (GOVERNANCE_DOC_NAMES.has(basename) || isGovernancePath(normalized)) {
    violations.push(
      `Iron Law 1: "${filePath}" is a governance file and is READ-ONLY. Governance docs may never be modified by the build agent.`,
    );
    log(`[DENY] governance doc write blocked: ${filePath}`);
    return { allowed: false, violations, suggestions };
  }

  // 3. API routes — verify organization_id / company_id scoping.
  if (isApiRoute(normalized) && !isAuthRoute(normalized)) {
    if (!content.includes('organization_id') && !content.includes('company_id')) {
      violations.push(
        'API route is missing organization_id / company_id scoping. ' +
          'All data must be company-scoped (Iron Law 2 / Six Laws Law 2).',
      );
      suggestions.push(
        'Derive organization_id from the authenticated session (never from the request body) ' +
          'and apply it to every database query in this route.',
      );
    }
  }

  // 4. Hardcoded secrets / API keys — deny (Iron Law 8).
  for (const pattern of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    if (pattern.test(content)) {
      violations.push(
        'Hardcoded API key or secret detected in file content (Iron Law 8). ' +
          'Credentials must never appear as literals in source code.',
      );
      suggestions.push(
        'Move the credential to .env.local and read it via process.env.KEY_NAME. ' +
          'Never commit secret values.',
      );
      log(`[DENY] hardcoded secret detected in ${filePath}`);
      break;
    }
  }

  const allowed = violations.length === 0;
  if (!allowed) {
    log(`[DENY] governance violations in ${filePath}: ${violations.join(' | ')}`);
  }
  return { allowed, violations, suggestions };
}

// ---------------------------------------------------------------------------
// runSixLawsCheck
// ---------------------------------------------------------------------------

export async function runSixLawsCheck(projectPath: string): Promise<SixLawsResult> {
  log(`Running Six Laws check against ${projectPath}`);
  return verifySixLaws({ projectPath });
}

// ---------------------------------------------------------------------------
// registerGovernanceHook — wires checkGovernanceCompliance into HookManager
// ---------------------------------------------------------------------------

/** Minimal interface so governance-gate does not import HookManager (avoids circular deps). */
interface HookRegistrar {
  registerHook(hook: Hook): void;
}

/**
 * Register the governance gate as a `pre_file_write` builtin hook.
 * Call once during build initialisation:
 *   import { registerGovernanceHook } from './governance-gate.js';
 *   registerGovernanceHook(hookManager);
 */
export function registerGovernanceHook(manager: HookRegistrar): void {
  manager.registerHook({
    id: 'governance:pre_file_write:governance_gate',
    event: 'pre_file_write',
    // '__builtin__' routes the hook through runBuiltinHook in hook-manager,
    // which calls checkGovernanceCompliance for this ID.
    script: '__builtin__',
    enabled: true,
    priority: 5,
    description:
      'Runs governance compliance checks before every file write (Iron Laws 1, 4, 8 + org-scoping)',
  });
  log('Registered governance:pre_file_write:governance_gate hook (priority=5)');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Read forge.config.json from the project root; return null on any error. */
function readQueueConfig(projectPath: string): Record<string, unknown> | null {
  const configPath = join(projectPath, 'forge.config.json');
  if (!existsSync(configPath)) return null;
  try {
    const raw = readFileSync(configPath, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

function isGovernancePath(normalized: string): boolean {
  return (
    normalized.includes('/governance/') ||
    normalized.endsWith('/BLUEPRINT.md') ||
    normalized.endsWith('/CLAUDE.md') ||
    normalized.endsWith('/STATE_OF_THE_BUILD.md') ||
    normalized.endsWith('/SESSION_STATE.md')
  );
}

function isApiRoute(normalized: string): boolean {
  return (
    normalized.includes('/app/api/') ||
    normalized.includes('/pages/api/') ||
    // loose match for route handlers outside Next.js conventions
    (normalized.includes('/api/') && normalized.endsWith('.ts'))
  );
}

function isAuthRoute(normalized: string): boolean {
  return /\/(auth|login|logout|signup|register|callback)\b/.test(normalized);
}
