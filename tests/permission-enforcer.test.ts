/**
 * FORGE 2.0 — Permission Enforcer unit tests (`src/governance/permission-enforcer.ts` +
 * `src/governance/agent-contracts.ts`).
 *
 * Pure `node:test` — NO claude, NO git, NO database; `checkPermission` is a synchronous, pure
 * path comparison, exercised directly against the REAL registered `AgentContract`s (so a
 * regression in the registry itself, not just the enforcer's matching logic, is also caught) plus
 * a small injected fixture registry for the edge cases the real registry doesn't otherwise exercise.
 *
 * HOW TO RUN
 *     node --import tsx --test tests/permission-enforcer.test.ts
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import { checkPermission, checkPermissions } from '../src/governance/permission-enforcer.js';
import { AGENT_CONTRACTS, ALL_AGENT_IDS, type AgentContract, type AgentId } from '../src/governance/agent-contracts.js';

const PROJECT_PATH = 'C:\\fake\\project';

describe('checkPermission — Build Agent (real registry)', () => {
  test('allows a write to an ordinary in-project source file', () => {
    const result = checkPermission({
      agentId: 'build-agent',
      writeTarget: 'src/components/UserCard.tsx',
      projectPath: PROJECT_PATH,
    });
    assert.equal(result.allowed, true);
    assert.equal(result.normalizedPath, 'src/components/UserCard.tsx');
  });

  test('allows a write given as an absolute path still under the project root', () => {
    const result = checkPermission({
      agentId: 'build-agent',
      writeTarget: join(PROJECT_PATH, 'src', 'api', 'route.ts'),
      projectPath: PROJECT_PATH,
    });
    assert.equal(result.allowed, true);
  });

  test('DENIES a write outside the target project root (path escape)', () => {
    const result = checkPermission({
      agentId: 'build-agent',
      writeTarget: '../../etc/passwd',
      projectPath: PROJECT_PATH,
    });
    assert.equal(result.allowed, false);
    assert.match(result.reason, /outside the target project root/);
  });

  test('DENIES a write to an absolute path entirely outside the project root', () => {
    const result = checkPermission({
      agentId: 'build-agent',
      writeTarget: 'C:\\Users\\manag\\Documents\\forge-2\\BEHAVIORAL_CONTRACTS.md',
      projectPath: PROJECT_PATH,
    });
    assert.equal(result.allowed, false);
    assert.match(result.reason, /outside the target project root/);
  });

  test('DENIES a write to a governance-protected shared_canonical doc (owned by a different subsystem)', () => {
    const result = checkPermission({
      agentId: 'build-agent',
      writeTarget: 'BEHAVIORAL_CONTRACTS.md',
      projectPath: PROJECT_PATH,
    });
    assert.equal(result.allowed, false);
    assert.match(result.reason, /denied path pattern/);
  });

  test('DENIES the same governance-protected doc under a nested docs/decisions/** glob', () => {
    const result = checkPermission({
      agentId: 'build-agent',
      writeTarget: 'docs/decisions/0001-use-postgres.md',
      projectPath: PROJECT_PATH,
    });
    assert.equal(result.allowed, false);
  });
});

describe('checkPermission — an agent with no registered contract', () => {
  test('DENIES rather than implicitly allowing', () => {
    const result = checkPermission({
      agentId: 'totally-unregistered-agent' as AgentId,
      writeTarget: 'src/index.ts',
      projectPath: PROJECT_PATH,
    });
    assert.equal(result.allowed, false);
    assert.match(result.reason, /no registered AgentContract/);
  });
});

describe('checkPermission — a read-only subsystem contract (no writablePathPatterns)', () => {
  test('Architecture Guardian is denied ANY write — it has no declared write scope', () => {
    const result = checkPermission({
      agentId: 'architecture-guardian',
      writeTarget: 'src/anything.ts',
      projectPath: PROJECT_PATH,
    });
    assert.equal(result.allowed, false);
    assert.match(result.reason, /none of Architecture Guardian's writable path patterns/);
  });
});

describe('checkPermission — Git Manager (narrow, single-file contract)', () => {
  test('allows its own commit-message temp file', () => {
    const result = checkPermission({ agentId: 'git-manager', writeTarget: '.forge-commit-msg', projectPath: PROJECT_PATH });
    assert.equal(result.allowed, true);
  });

  test('DENIES Git Manager writing an application file it has no business touching', () => {
    const result = checkPermission({ agentId: 'git-manager', writeTarget: 'src/index.ts', projectPath: PROJECT_PATH });
    assert.equal(result.allowed, false);
  });
});

describe('checkPermissions — batch form', () => {
  test('returns only the denied results, in input order, for a mixed batch', () => {
    const denied = checkPermissions(
      'build-agent',
      ['src/ok-1.ts', 'BEHAVIORAL_CONTRACTS.md', 'src/ok-2.ts', '../outside.ts'],
      PROJECT_PATH
    );
    assert.equal(denied.length, 2);
    assert.equal(denied[0]?.normalizedPath, 'BEHAVIORAL_CONTRACTS.md');
    assert.match(denied[1]?.reason ?? '', /outside the target project root/);
  });

  test('returns an empty array when every target is allowed', () => {
    const denied = checkPermissions('build-agent', ['src/a.ts', 'src/b.ts'], PROJECT_PATH);
    assert.deepEqual(denied, []);
  });
});

describe('checkPermission — injectable fixture registry', () => {
  const FIXTURE_CONTRACTS: Record<AgentId, AgentContract> = {
    ...AGENT_CONTRACTS,
    'build-agent': {
      ...AGENT_CONTRACTS['build-agent'],
      writablePathPatterns: ['src/generated/**'],
      deniedPathPatterns: ['src/generated/secrets.ts'],
    },
  };

  test('a narrower injected contract allows only what it declares', () => {
    const allowed = checkPermission({
      agentId: 'build-agent',
      writeTarget: 'src/generated/models.ts',
      projectPath: PROJECT_PATH,
      contracts: FIXTURE_CONTRACTS,
    });
    assert.equal(allowed.allowed, true);

    const deniedByScope = checkPermission({
      agentId: 'build-agent',
      writeTarget: 'src/components/UserCard.tsx',
      projectPath: PROJECT_PATH,
      contracts: FIXTURE_CONTRACTS,
    });
    assert.equal(deniedByScope.allowed, false);
  });

  test('an injected denied-pattern wins even inside the otherwise-writable scope', () => {
    const result = checkPermission({
      agentId: 'build-agent',
      writeTarget: 'src/generated/secrets.ts',
      projectPath: PROJECT_PATH,
      contracts: FIXTURE_CONTRACTS,
    });
    assert.equal(result.allowed, false);
    assert.match(result.reason, /denied path pattern/);
  });
});

describe('AGENT_CONTRACTS registry sanity', () => {
  test('every registered contract is keyed under its own id', () => {
    for (const id of ALL_AGENT_IDS) {
      assert.equal(AGENT_CONTRACTS[id].id, id);
    }
  });

  test('every registered contract has a non-empty name/description and observedIn citation', () => {
    for (const id of ALL_AGENT_IDS) {
      const contract = AGENT_CONTRACTS[id];
      assert.ok(contract.name.length > 0, `${id} missing a name`);
      assert.ok(contract.description.length > 0, `${id} missing a description`);
      assert.ok(contract.observedIn.length > 0, `${id} has no observedIn citation`);
    }
  });
});
