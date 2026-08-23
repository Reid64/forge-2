/**
 * FORGE 2.0 — Prompt density enforcement unit test.
 *
 * HOW TO RUN
 *     node --import tsx --test tests/prompt-density.test.ts
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { validatePrompt } from '../src/validation/promptDensity.js';

test('a normal prompt is valid with no warnings or errors', () => {
  const result = validatePrompt('Build the users CRUD API route with Supabase RLS.', 'p1');
  assert.equal(result.valid, true);
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(result.errors, []);
});

test('backgrounding + network work combination is an error', () => {
  const result = validatePrompt(
    'Use Start-Job to run the ingest script in the background so it does not block.',
    'p2'
  );
  assert.equal(result.valid, false);
  assert.equal(result.errors.length, 1);
});

test('nohup + fetch combination is an error', () => {
  const result = validatePrompt('Run nohup fetch-data.sh & to fetch the dataset in background.', 'p3');
  assert.equal(result.valid, false);
});

test('more than 15 distinct URLs without --dry-run is an error', () => {
  const urls = Array.from({ length: 16 }, (_, i) => `https://example.com/page${i}`).join(' ');
  const result = validatePrompt(`Download all of these: ${urls}`, 'p4');
  assert.equal(result.valid, false);
  assert.equal(result.errors.length, 1);
});

test('more than 15 distinct URLs WITH --dry-run is not an error', () => {
  const urls = Array.from({ length: 16 }, (_, i) => `https://example.com/page${i}`).join(' ');
  const result = validatePrompt(`Download all of these (--dry-run first): ${urls}`, 'p5');
  assert.equal(result.valid, true);
});

test('15 or fewer distinct URLs is not an error', () => {
  const urls = Array.from({ length: 15 }, (_, i) => `https://example.com/page${i}`).join(' ');
  const result = validatePrompt(`Reference these: ${urls}`, 'p6');
  assert.equal(result.valid, true);
});

test('a very long prompt warns on estimated token count', () => {
  const longPrompt = 'x'.repeat(8001 * 4);
  const result = validatePrompt(longPrompt, 'p7');
  assert.equal(result.valid, true);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0]!, /token/);
});

test('fetch + embed combination warns to suggest splitting', () => {
  const result = validatePrompt('Fetch the documents then embed them into the vector store.', 'p8');
  assert.equal(result.valid, true);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0]!, /splitting/);
});

test('errors and warnings can both fire on the same prompt', () => {
  const urls = Array.from({ length: 20 }, (_, i) => `https://example.com/doc${i}`).join(' ');
  const result = validatePrompt(`Start-Job to fetch and embed: ${urls}`, 'p9');
  assert.equal(result.valid, false);
  assert.ok(result.errors.length >= 1);
  assert.ok(result.warnings.length >= 1);
});
