/**
 * FORGE 2.0 — Learning Engine: EvolutionPromoter.
 *
 * See `upgrades/LEARNING_BLUEPRINT.md` § Agent: EvolutionPromoter. The only FORGE component
 * permitted to cross the propose→activate line (Learning Iron Law L5) — and only within the
 * L1–L8 bounds. For each `pending_evolutions` row that clears the confidence bar:
 *   (1) writes the decision to `evolution_promotions` BEFORE anything else changes (L3),
 *   (2) applies the activation appropriate to its `evolution_type`, then flips the
 *       `pending_evolutions` row to APPROVED.
 * `evolution_type = 'GATE'` is never auto-promotable (L2) — Contract 2 gates only weaken via a
 * human-approved decision, which this module does not perform.
 *
 * Every call also runs monitoring-window bookkeeping for already-promoted rows: once
 * {@link MONITORING_WINDOW_BUILDS} builds have completed since a promotion, its post-promotion
 * success rate (mean `build_outcomes.first_pass_rate`) is compared against the pre-promotion
 * baseline captured at promotion time. A drop of more than {@link ROLLBACK_REGRESSION_POINTS}
 * (15 points) triggers an automatic rollback that reverses the activation (L8).
 */

import { newId, nowIso, logMemoryWarning, type MemoryDb } from '../memory/client.js';
import { getMachineId } from './database.js';
import type { PendingEvolution } from './types.js';

/** Confidence bar a `pending_evolutions` row must clear to auto-promote (Learning Iron Law L1/L2). */
export const PROMOTION_THRESHOLD = 0.9;

/** Builds a promoted change is observed over before its post-promotion success rate is judged. */
const MONITORING_WINDOW_BUILDS = 15;

/** A promoted change rolls back once its post-promotion success rate falls this far below baseline (L8). */
const ROLLBACK_REGRESSION_POINTS = 0.15;

/** One `evolution_promotions` row {@link promoteEligible} wrote for a newly-promoted evolution. */
export interface PromotionResult {
  id: string;
  pendingEvolutionId: string;
  evolutionType: PendingEvolution['evolution_type'];
  confidenceAtPromotion: number;
  prePromotionSuccessRate: number | null;
  effectApplied: string;
}

/** A `pending_evolutions` row that has cleared the auto-promotion bar. */
interface EligiblePendingRow {
  id: string;
  evolution_type: PendingEvolution['evolution_type'];
  change_detail: string;
  evidence: string;
  confidence: number;
}

/** The subset of an `evolution_promotions` row needed to check/act on its monitoring window. */
interface OpenPromotionRow {
  id: string;
  pending_evolution_id: string;
  evolution_type: PendingEvolution['evolution_type'];
  pre_promotion_success_rate: number | null;
  monitoring_window_builds: number;
  promoted_at: string;
}

// ---------------------------------------------------------------------------
// Helpers (pure / read-only)
// ---------------------------------------------------------------------------

/** Parse a `change_detail` / `evidence` JSON TEXT column, degrading to `{}` on malformed input. */
function parseJsonObject(text: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Best-effort build-count signal from a proposal's `evidence` payload (OQ2 — no fixed shape is guaranteed across proposers). */
function evidenceBuildCount(evidenceText: string): number {
  const evidence = parseJsonObject(evidenceText);
  for (const key of ['evidence_build_count', 'buildCount', 'rewrittenCount', 'sample_size']) {
    const value = evidence[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return 0;
}

/** Mean `build_outcomes.first_pass_rate` over the most recent {@link MONITORING_WINDOW_BUILDS} scored builds, or `null` when none exist yet. */
function recentSuccessRate(db: MemoryDb): number | null {
  try {
    const rows = db
      .prepare(
        `SELECT first_pass_rate FROM build_outcomes
         WHERE first_pass_rate IS NOT NULL
         ORDER BY created_at DESC LIMIT ?`
      )
      .all(MONITORING_WINDOW_BUILDS) as Array<{ first_pass_rate: number }>;
    if (rows.length === 0) return null;
    return rows.reduce((sum, r) => sum + r.first_pass_rate, 0) / rows.length;
  } catch (err) {
    logMemoryWarning('evolution-promoter.recentSuccessRate', err);
    return null;
  }
}

/** Count of `build_outcomes` rows recorded strictly after `sinceIso`. */
function buildsSince(db: MemoryDb, sinceIso: string): number {
  try {
    const row = db
      .prepare(`SELECT COUNT(*) as count FROM build_outcomes WHERE created_at > ?`)
      .get(sinceIso) as { count: number } | undefined;
    return row?.count ?? 0;
  } catch (err) {
    logMemoryWarning('evolution-promoter.buildsSince', err);
    return 0;
  }
}

/** Mean `first_pass_rate` of scored `build_outcomes` rows recorded strictly after `sinceIso`, or `null` when none are scored yet. */
function successRateSince(db: MemoryDb, sinceIso: string): number | null {
  try {
    const rows = db
      .prepare(
        `SELECT first_pass_rate FROM build_outcomes
         WHERE created_at > ? AND first_pass_rate IS NOT NULL`
      )
      .all(sinceIso) as Array<{ first_pass_rate: number }>;
    if (rows.length === 0) return null;
    return rows.reduce((sum, r) => sum + r.first_pass_rate, 0) / rows.length;
  } catch (err) {
    logMemoryWarning('evolution-promoter.successRateSince', err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Activation (per evolution_type) + reversal
// ---------------------------------------------------------------------------

/**
 * Activate a promoted RULE: insert an `AUTO_ELEVATED` `governance_rules` row. Correlated back to
 * its `evolution_promotions.id` via `source_error_fingerprint` — the only free-text linkage column
 * on `governance_rules` — so a later rollback can find and deactivate exactly this row.
 */
function applyRule(
  db: MemoryDb,
  promotionId: string,
  pending: EligiblePendingRow,
  machineId: string
): string {
  const detail = parseJsonObject(pending.change_detail);
  const ruleText =
    typeof detail['rule_text'] === 'string' ? detail['rule_text'] : `Auto-elevated: ${pending.change_detail}`;
  const ruleShortName =
    typeof detail['rule_short_name'] === 'string' ? detail['rule_short_name'] : `auto-${pending.id.slice(0, 8)}`;
  const techStackTags =
    typeof detail['tech_stack_tags'] === 'string'
      ? detail['tech_stack_tags']
      : JSON.stringify(detail['tech_stack_tags'] ?? []);
  const scope = detail['scope'] === 'PROJECT_SPECIFIC' ? 'PROJECT_SPECIFIC' : 'GLOBAL';
  const projectName = typeof detail['project_name'] === 'string' ? detail['project_name'] : null;

  db.prepare(
    `INSERT INTO governance_rules (
      id, rule_text, rule_short_name, source, source_error_fingerprint, tech_stack_tags,
      scope, project_name, active, enforcement_count, last_enforced, machine_id, created_at
    ) VALUES (?, ?, ?, 'AUTO_ELEVATED', ?, ?, ?, ?, 1, 0, NULL, ?, ?)`
  ).run(newId(), ruleText, ruleShortName, promotionId, techStackTags, scope, projectName, machineId, nowIso());

  return `governance_rules: AUTO_ELEVATED rule "${ruleShortName}" activated`;
}

/**
 * Activate a promoted THRESHOLD/CONFIG: write the new value to `forge_meta` under the key named
 * in `change_detail.key`, appending the prior value into that record's `.history` (blueprint
 * "THRESHOLD/CONFIG → forge_meta with history" contract) so a rollback can restore it.
 */
function applyConfig(db: MemoryDb, pending: EligiblePendingRow): string {
  const detail = parseJsonObject(pending.change_detail);
  const key = typeof detail['key'] === 'string' ? detail['key'] : null;
  if (key === null || !('value' in detail)) {
    return 'forge_meta: no key/value in change_detail — activation skipped';
  }
  const value = detail['value'];

  const existing = db.prepare('SELECT value FROM forge_meta WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  let history: unknown[] = [];
  if (existing) {
    try {
      const parsed = JSON.parse(existing.value) as { value?: unknown; history?: unknown[] };
      history = Array.isArray(parsed.history) ? [...parsed.history, parsed.value] : [parsed];
    } catch {
      history = [existing.value];
    }
  }

  db.prepare(
    `INSERT INTO forge_meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(key, JSON.stringify({ value, history }));

  return `forge_meta['${key}'] updated to ${JSON.stringify(value)}`;
}

/**
 * Activate a promoted TEMPLATE: clear the `PROPOSED:` prefix on the newest `recursive_learner`
 * `governance_versions` row for `change_detail.template_name`, making it the active version
 * (effective at the build's next Phase 2 assembly, per blueprint — never mid-build).
 */
function applyTemplate(db: MemoryDb, pending: EligiblePendingRow): string {
  const detail = parseJsonObject(pending.change_detail);
  const templateName = typeof detail['template_name'] === 'string' ? detail['template_name'] : null;
  if (!templateName) return 'governance_versions: no template_name in change_detail — activation skipped';

  const row = db
    .prepare(
      `SELECT id, changes_description FROM governance_versions
       WHERE template_name = ? AND change_source = 'recursive_learner'
       ORDER BY version_number DESC LIMIT 1`
    )
    .get(templateName) as { id: string; changes_description: string | null } | undefined;

  if (!row || !row.changes_description || !row.changes_description.startsWith('PROPOSED:')) {
    return `governance_versions: no pending recursive_learner proposal found for "${templateName}"`;
  }

  const activatedDescription = row.changes_description.replace(/^PROPOSED:\s*/, '');
  db.prepare(
    `UPDATE governance_versions SET changes_description = ?, effectiveness_score = COALESCE(effectiveness_score, 0) WHERE id = ?`
  ).run(activatedDescription, row.id);

  return `governance_versions: "${templateName}" activated (PROPOSED: prefix cleared)`;
}

/** HOOK activation has no persistent enabled-flag store in this codebase yet — recorded as promoted only (Contract 4: degrade, never throw). */
function applyHook(): string {
  return 'HOOK activation is not yet backed by a persistent store — promotion recorded only';
}

/** Dispatch activation by `evolution_type`. Never throws — a handler failure degrades to a logged, descriptive no-op. */
function applyEffect(
  db: MemoryDb,
  promotionId: string,
  pending: EligiblePendingRow,
  machineId: string
): string {
  try {
    switch (pending.evolution_type) {
      case 'RULE':
        return applyRule(db, promotionId, pending, machineId);
      case 'THRESHOLD':
      case 'CONFIG':
        return applyConfig(db, pending);
      case 'TEMPLATE':
        return applyTemplate(db, pending);
      case 'HOOK':
        return applyHook();
      default:
        return `no activation handler for evolution_type ${pending.evolution_type}`;
    }
  } catch (err) {
    logMemoryWarning('evolution-promoter.applyEffect', err);
    return `activation failed (${err instanceof Error ? err.message : String(err)})`;
  }
}

/** Reverse a promoted evolution's activation on rollback (L8), mirroring {@link applyEffect} per `evolution_type`. */
function reverseEffect(
  db: MemoryDb,
  promotion: { id: string; evolutionType: PendingEvolution['evolution_type'] },
  pendingChangeDetail: string
): void {
  try {
    switch (promotion.evolutionType) {
      case 'RULE': {
        db.prepare(
          `UPDATE governance_rules SET active = 0 WHERE source = 'AUTO_ELEVATED' AND source_error_fingerprint = ?`
        ).run(promotion.id);
        break;
      }
      case 'THRESHOLD':
      case 'CONFIG': {
        const detail = parseJsonObject(pendingChangeDetail);
        const key = typeof detail['key'] === 'string' ? detail['key'] : null;
        if (!key) break;
        const existing = db.prepare('SELECT value FROM forge_meta WHERE key = ?').get(key) as
          | { value: string }
          | undefined;
        if (!existing) break;
        try {
          const parsed = JSON.parse(existing.value) as { value?: unknown; history?: unknown[] };
          const history = Array.isArray(parsed.history) ? parsed.history : [];
          if (history.length === 0) break;
          const restored = history[history.length - 1];
          const remaining = history.slice(0, -1);
          db.prepare('UPDATE forge_meta SET value = ? WHERE key = ?').run(
            JSON.stringify({ value: restored, history: remaining }),
            key
          );
        } catch {
          // Malformed forge_meta record — nothing safe to restore (Contract 4: never throw).
        }
        break;
      }
      case 'TEMPLATE': {
        const detail = parseJsonObject(pendingChangeDetail);
        const templateName = typeof detail['template_name'] === 'string' ? detail['template_name'] : null;
        if (!templateName) break;
        const row = db
          .prepare(
            `SELECT id, changes_description FROM governance_versions
             WHERE template_name = ? AND change_source = 'recursive_learner'
             ORDER BY version_number DESC LIMIT 1`
          )
          .get(templateName) as { id: string; changes_description: string | null } | undefined;
        if (!row || !row.changes_description || row.changes_description.startsWith('PROPOSED:')) break;
        db.prepare('UPDATE governance_versions SET changes_description = ? WHERE id = ?').run(
          `PROPOSED: ${row.changes_description}`,
          row.id
        );
        break;
      }
      case 'HOOK':
      default:
        break;
    }
  } catch (err) {
    logMemoryWarning('evolution-promoter.reverseEffect', err);
  }
}

// ---------------------------------------------------------------------------
// Monitoring window / rollback
// ---------------------------------------------------------------------------

/**
 * For every AUTO `evolution_promotions` row still awaiting judgement (`rollback_triggered = 0`,
 * `post_promotion_success_rate IS NULL`), once {@link MONITORING_WINDOW_BUILDS} builds have
 * completed since `promoted_at`, backfill its post-promotion success rate. A drop of more than
 * {@link ROLLBACK_REGRESSION_POINTS} below the pre-promotion baseline triggers a rollback: the
 * row is flagged and its activation is reversed via {@link reverseEffect} (L8).
 */
function checkMonitoringWindows(db: MemoryDb): void {
  try {
    const openPromotions = db
      .prepare(
        `SELECT id, pending_evolution_id, evolution_type, pre_promotion_success_rate,
                monitoring_window_builds, promoted_at
         FROM evolution_promotions
         WHERE rollback_triggered = 0 AND post_promotion_success_rate IS NULL AND promotion_method = 'AUTO'`
      )
      .all() as OpenPromotionRow[];

    for (const promotion of openPromotions) {
      try {
        if (buildsSince(db, promotion.promoted_at) < promotion.monitoring_window_builds) continue;

        const postRate = successRateSince(db, promotion.promoted_at);
        if (postRate === null) continue; // No scored builds yet to judge — leave the window open.

        const baseline = promotion.pre_promotion_success_rate;
        const regressed = baseline !== null && postRate < baseline - ROLLBACK_REGRESSION_POINTS;

        if (!regressed) {
          db.prepare(`UPDATE evolution_promotions SET post_promotion_success_rate = ? WHERE id = ?`).run(
            postRate,
            promotion.id
          );
          continue;
        }

        const reason = `post-promotion success rate ${postRate.toFixed(2)} fell more than ${ROLLBACK_REGRESSION_POINTS} below baseline ${(baseline as number).toFixed(2)}`;
        db.prepare(
          `UPDATE evolution_promotions
           SET post_promotion_success_rate = ?, rollback_triggered = 1, rollback_reason = ?
           WHERE id = ?`
        ).run(postRate, reason, promotion.id);

        const pendingRow = db
          .prepare('SELECT change_detail FROM pending_evolutions WHERE id = ?')
          .get(promotion.pending_evolution_id) as { change_detail: string } | undefined;
        reverseEffect(
          db,
          { id: promotion.id, evolutionType: promotion.evolution_type },
          pendingRow?.change_detail ?? '{}'
        );
      } catch (err) {
        logMemoryWarning('evolution-promoter.checkMonitoringWindows:row', err);
      }
    }
  } catch (err) {
    logMemoryWarning('evolution-promoter.checkMonitoringWindows', err);
  }
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Run monitoring-window bookkeeping for already-promoted evolutions, then auto-promote every
 * `pending_evolutions` row with `confidence >= {@link PROMOTION_THRESHOLD}`,
 * `evolution_type != 'GATE'`, and `status = 'PENDING'`. For each newly-promoted row: writes the
 * `evolution_promotions` audit row BEFORE applying its activation (L3), applies the activation,
 * then flips the row to `APPROVED`. Never throws (Contract 4) — degrades to `[]` on failure.
 */
export function promoteEligible(db: MemoryDb): PromotionResult[] {
  checkMonitoringWindows(db);

  const results: PromotionResult[] = [];
  try {
    const rows = db
      .prepare(
        `SELECT id, evolution_type, change_detail, evidence, confidence FROM pending_evolutions
         WHERE confidence >= ? AND evolution_type != 'GATE' AND status = 'PENDING'`
      )
      .all(PROMOTION_THRESHOLD) as EligiblePendingRow[];

    if (rows.length === 0) return results;

    const machineId = getMachineId();

    for (const pending of rows) {
      try {
        const promotionId = newId();
        const promotedAt = nowIso();
        const prePromotionSuccessRate = recentSuccessRate(db);

        // (1) Write the audit row BEFORE the effect takes hold (Learning Iron Law L3).
        db.prepare(
          `INSERT INTO evolution_promotions (
            id, pending_evolution_id, evolution_type, confidence_at_promotion,
            confidence_threshold_applied, promotion_method, evidence_build_count,
            pre_promotion_success_rate, post_promotion_success_rate, monitoring_window_builds,
            rollback_triggered, rollback_reason, promoted_at, reviewed_at, machine_id, created_at
          ) VALUES (?, ?, ?, ?, ?, 'AUTO', ?, ?, NULL, ?, 0, NULL, ?, NULL, ?, ?)`
        ).run(
          promotionId,
          pending.id,
          pending.evolution_type,
          pending.confidence,
          PROMOTION_THRESHOLD,
          evidenceBuildCount(pending.evidence),
          prePromotionSuccessRate,
          MONITORING_WINDOW_BUILDS,
          promotedAt,
          machineId,
          promotedAt
        );

        // (2) Apply the effect to the target table.
        const effectApplied = applyEffect(db, promotionId, pending, machineId);

        // Flip the proposal to APPROVED now that it has been acted on.
        db.prepare(
          `UPDATE pending_evolutions SET status = 'APPROVED', reviewed_at = ?, review_note = ? WHERE id = ?`
        ).run(
          promotedAt,
          `Auto-promoted by EvolutionPromoter (confidence ${pending.confidence} >= ${PROMOTION_THRESHOLD})`,
          pending.id
        );

        results.push({
          id: promotionId,
          pendingEvolutionId: pending.id,
          evolutionType: pending.evolution_type,
          confidenceAtPromotion: pending.confidence,
          prePromotionSuccessRate,
          effectApplied,
        });
      } catch (err) {
        logMemoryWarning('evolution-promoter.promoteEligible:row', err);
      }
    }
  } catch (err) {
    logMemoryWarning('evolution-promoter.promoteEligible', err);
  }
  return results;
}

/**
 * Wired into the end of Phase 5 (`src/phases/phase5-learner.ts`, appended after the existing
 * 10-step sequence per `upgrades/LEARNING_BLUEPRINT.md` — "NEW Step 11, appended in-process after
 * Step 10"). Runs {@link promoteEligible} under the same NON-FATAL house style as every other
 * Phase 5 step: a promotion failure degrades to an empty result, never halts the build.
 */
export function registerPromoterPhase5Hook(db: MemoryDb): PromotionResult[] {
  try {
    return promoteEligible(db);
  } catch (err) {
    logMemoryWarning('evolution-promoter.registerPromoterPhase5Hook', err);
    return [];
  }
}
