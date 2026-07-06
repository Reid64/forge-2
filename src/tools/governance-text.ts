/**
 * FORGE 2.0 — Governance text sanitization (Session 5 finding — mojibake).
 *
 * Governance/state documents (BLUEPRINT.md, STATE_OF_THE_BUILD.md, TOOLCHAIN.md, halt reports,
 * …) get opened by a wide variety of tools — PowerShell's `type`, git diff viewers, editors on a
 * non-UTF-8-default codepage — and the checkmark/emoji/smart-punctuation characters FORGE's own
 * renderers like to use (✅ ❌ ⚠️ — → “ ” • …) come out as mojibake on several of them even though
 * the file itself is valid UTF-8. This module gives every governance write ONE choke point that
 * downgrades those characters to their ASCII equivalents, and strips a stray BOM — the file stays
 * plain, portable UTF-8 (no BOM) that reads correctly everywhere.
 */

import { writeFile } from 'node:fs/promises';

/** Character-for-character (or short-run) ASCII replacements for common mojibake-prone glyphs. */
const ASCII_REPLACEMENTS: ReadonlyArray<readonly [RegExp, string]> = [
  [/﻿/g, ''], // BOM, wherever it appears (not just position 0 — defensive)
  [/✅/g, '[PASS]'],
  [/❌/g, '[FAIL]'],
  [/⚠️/g, '[WARN]'],
  [/⚠/g, '[WARN]'],
  [/✔/g, '[OK]'],
  [/✖/g, '[X]'],
  [/→/g, '->'],
  [/←/g, '<-'],
  [/—/g, '--'],
  [/–/g, '-'],
  [/[“”]/g, '"'],
  [/[‘’]/g, "'"],
  [/…/g, '...'],
  [/•/g, '-'],
  [/[━─│┌┐└┘├┤┬┴┼═║╔╗╚╝]/g, '-'],
];

/** Downgrade governance-doc text to plain ASCII-safe punctuation/symbols; strip any BOM. */
export function toAsciiGovernanceText(text: string): string {
  let out = text;
  for (const [pattern, replacement] of ASCII_REPLACEMENTS) out = out.replace(pattern, replacement);
  return out;
}

/**
 * Write a governance/state document: sanitized to ASCII-safe punctuation (see
 * {@link toAsciiGovernanceText}) and encoded UTF-8 WITHOUT a BOM (`fs.writeFile(..., 'utf8')`
 * never emits one). The single write path every governance-doc writer should use.
 */
export async function writeGovernanceFile(path: string, text: string): Promise<void> {
  await writeFile(path, toAsciiGovernanceText(text), 'utf8');
}
