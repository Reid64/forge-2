/**
 * FORGE 2.0 — Design Pipeline: PersonaProfiler (`src/design-pipeline/persona-profiler.ts`).
 *
 * `upgrades/DESIGN_INTELLIGENCE.md` component #04 ("User/Persona Profiler"), flagged MISSING by
 * `upgrades/SYSTEMS-5-9-GAP-MATRIX.md` row 04 and explicitly named as out-of-scope future work in
 * `app-profiler.ts`'s own header ("does not implement ... User/Persona Profiler (#04) as their own
 * standalone subsystem ... target-user extraction ... is folded into `app-profiler.ts`'s
 * `targetUsers: string[]` as a bare name list"). This module is the fuller refinement:
 * {@link inferTargetPersonas} derives a richer {@link TargetPersona} per detected role — not just
 * "this word appeared" but real quoted evidence sentences, goal-verbs found alongside the role,
 * and heuristic technical-proficiency/data-density expectations — from PRD text already on disk.
 *
 * DOC READING: reuses `src/skills/ux-intelligence.ts`'s `readProjectPrdContent` (same
 * `PRD.md`/`governance/PRD.md`/`BLUEPRINT.md`/`governance/BLUEPRINT.md` candidate-path
 * concatenation `brand-intelligence.ts` reuses too) rather than inventing a second file-scanning
 * convention.
 *
 * COMPOSES WITH `app-profiler.ts`: {@link TargetPersona.role} is drawn from a superset of
 * `app-profiler.ts`'s `TARGET_USER_VOCAB` role nouns, so every role `profileApp()` can already
 * detect from queue text is also a role this module can detect (with far more evidence) from PRD
 * text. Iron Law 3: every field is either a literal keyword-hit count, a literal quoted sentence
 * from the source text, or a documented heuristic lookup — never an invented biography.
 *
 * House style, matching every sibling `src/design-pipeline/` module: {@link inferTargetPersonas}
 * never throws — an empty/unreadable document corpus returns `[]` (no personas found), never a
 * fabricated default persona.
 */

import { readProjectPrdContent } from '../skills/ux-intelligence.js';

// ---------------------------------------------------------------------------
// Public contract
// ---------------------------------------------------------------------------

export type TechnicalProficiency = 'low' | 'medium' | 'high';
export type DataDensityPreference = 'low' | 'medium' | 'high';

export interface TargetPersona {
  /** Role noun, e.g. `'admin'`, `'architect'`, `'customer'` — see `TARGET_USER_VOCAB`. */
  role: string;
  /** Whole-word hit count for `role` across the source text. */
  evidenceCount: number;
  /** Up to 3 verbatim sentences from the source text that mention `role` — real quoted evidence. */
  contexts: string[];
  /** Goal-verb keywords (see `GOAL_VERB_VOCAB`) found in the same sentences as `role`. */
  goals: string[];
  /** Heuristic, from `PROFICIENCY_BY_ROLE` — never observed directly, always a documented lookup. */
  technicalProficiency: TechnicalProficiency;
  /** Heuristic UI-density expectation for this role, from `DENSITY_BY_ROLE`. */
  dataDensityPreference: DataDensityPreference;
}

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/**
 * Role nouns this module scans for — a superset of `app-profiler.ts`'s `TARGET_USER_VOCAB`
 * (kept in sync manually; both are small, hand-curated lists) plus a few additional roles useful
 * for persona-level detail that `app-profiler.ts`'s coarser `targetUsers: string[]` doesn't need.
 */
export const TARGET_USER_VOCAB: readonly string[] = [
  'architect',
  'contractor',
  'estimator',
  'fabricator',
  'customer',
  'admin',
  'administrator',
  'operator',
  'manager',
  'agent',
  'vendor',
  'supplier',
  'developer',
  'analyst',
  'guest',
  'member',
  'patient',
  'student',
  'teacher',
  'buyer',
  'seller',
  'owner',
  'reviewer',
  'moderator',
];

/** Goal-verb keywords looked for in the same sentence as a role mention. */
const GOAL_VERB_VOCAB: readonly string[] = [
  'manage',
  'track',
  'approve',
  'review',
  'configure',
  'create',
  'submit',
  'browse',
  'purchase',
  'monitor',
  'analyze',
  'schedule',
  'collaborate',
  'automate',
  'audit',
  'onboard',
  'invite',
  'export',
  'search',
  'compare',
];

/** Heuristic technical-proficiency lookup by role. `medium` is the documented fallback. */
const PROFICIENCY_BY_ROLE: Readonly<Record<string, TechnicalProficiency>> = {
  admin: 'high',
  administrator: 'high',
  developer: 'high',
  analyst: 'high',
  operator: 'high',
  architect: 'medium',
  estimator: 'medium',
  manager: 'medium',
  agent: 'medium',
  vendor: 'medium',
  supplier: 'medium',
  teacher: 'medium',
  reviewer: 'medium',
  moderator: 'medium',
  contractor: 'medium',
  fabricator: 'medium',
  owner: 'medium',
  customer: 'low',
  guest: 'low',
  member: 'low',
  patient: 'low',
  student: 'low',
  buyer: 'low',
  seller: 'low',
};

/** Heuristic data-density expectation lookup by role. `medium` is the documented fallback. */
const DENSITY_BY_ROLE: Readonly<Record<string, DataDensityPreference>> = {
  admin: 'high',
  administrator: 'high',
  operator: 'high',
  analyst: 'high',
  developer: 'high',
  architect: 'medium',
  estimator: 'medium',
  manager: 'medium',
  agent: 'medium',
  vendor: 'medium',
  supplier: 'medium',
  reviewer: 'medium',
  moderator: 'medium',
  contractor: 'medium',
  fabricator: 'medium',
  owner: 'medium',
  teacher: 'medium',
  customer: 'low',
  guest: 'low',
  member: 'low',
  patient: 'low',
  student: 'low',
  buyer: 'low',
  seller: 'low',
};

const MAX_CONTEXTS_PER_PERSONA = 3;
const MAX_PERSONAS_RETURNED = 8;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function countHits(text: string, keyword: string): number {
  const pattern = new RegExp(`\\b${escapeRegExp(keyword)}\\b`, 'gi');
  const matches = text.match(pattern);
  return matches ? matches.length : 0;
}

/** Split `text` into trimmed, non-empty sentences on `.`/`!`/`?`/newline boundaries. */
function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function safeReadPrdContent(projectPath: string): string {
  try {
    return readProjectPrdContent(projectPath);
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Derive `TargetPersona`s from `documentText` (defaults to
 * {@link readProjectPrdContent}(`projectPath`) when omitted — pass it explicitly to test purely,
 * no disk I/O). Every role in {@link TARGET_USER_VOCAB} with at least one whole-word hit becomes a
 * persona; roles with zero hits are omitted entirely (never a fabricated persona nobody's PRD
 * mentioned). Returns at most {@link MAX_PERSONAS_RETURNED}, ranked by `evidenceCount` desc.
 * Never throws.
 */
export function inferTargetPersonas(projectPath: string, documentText?: string): TargetPersona[] {
  const text = documentText ?? safeReadPrdContent(projectPath);
  if (text.trim() === '') return [];

  const sentences = splitSentences(text);
  const personas: TargetPersona[] = [];

  for (const role of TARGET_USER_VOCAB) {
    const evidenceCount = countHits(text, role);
    if (evidenceCount === 0) continue;

    const rolePattern = new RegExp(`\\b${escapeRegExp(role)}\\b`, 'i');
    const matchingSentences = sentences.filter((s) => rolePattern.test(s));
    const contexts = matchingSentences.slice(0, MAX_CONTEXTS_PER_PERSONA);

    const goalSet = new Set<string>();
    for (const sentence of matchingSentences) {
      for (const verb of GOAL_VERB_VOCAB) {
        if (countHits(sentence, verb) > 0) goalSet.add(verb);
      }
    }

    personas.push({
      role,
      evidenceCount,
      contexts,
      goals: [...goalSet],
      technicalProficiency: PROFICIENCY_BY_ROLE[role] ?? 'medium',
      dataDensityPreference: DENSITY_BY_ROLE[role] ?? 'medium',
    });
  }

  return personas.sort((a, b) => b.evidenceCount - a.evidenceCount).slice(0, MAX_PERSONAS_RETURNED);
}

export default inferTargetPersonas;
