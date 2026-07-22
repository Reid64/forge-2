/**
 * FORGE 2.0 — Compliance Detector (agentic HIPAA/GDPR/PCI-DSS/SOX detection from PRD/BLUEPRINT).
 *
 * A build that touches health data, EU personal data, payment cards, or public-company financial
 * reporting carries regulatory obligations that have nothing to do with the Six Laws of feature
 * completion (BEHAVIORAL_CONTRACTS Contract 19) — those laws verify a feature was actually built,
 * not that it was built in a way a regulator would accept. Nothing in FORGE today reads a PRD for
 * that signal before Phase 3 starts writing code, so a HIPAA-shaped build could run start to finish
 * without a single prompt ever being told encryption-at-rest or an audit log is mandatory.
 *
 * This module gives Phase 0 that missing signal: read whatever PRD/blueprint text is already on
 * disk, classify which regulatory regimes the product plausibly falls under from a fixed keyword
 * table, and write `<project>/governance/COMPLIANCE_REQUIREMENTS.md` — a concrete, regime-specific
 * checklist of technical requirements and prohibited patterns Phase 3 prompts (and a human reviewer)
 * can act on. Detection deliberately errs toward false positives over false negatives: a PRD that
 * merely mentions "patient" in passing gets flagged HIPAA-adjacent, because the cost of an
 * unnecessary compliance doc is a few extra lines of governance text, while the cost of a missed
 * regime is a build that ships without encryption or an audit log it legally needed.
 *
 * Deliberately simple and dependency-free: no LLM call, no external skill invocation — just a
 * keyword classifier and a fixed, hand-curated table of regime-specific requirements/prohibitions,
 * in the same spirit as `src/skills/ux-intelligence.ts`'s industry-vertical classifier. Every export
 * here follows the house "guarded — never throws" convention: unreadable/absent PRD content
 * degrades to zero detected regimes (not an error), and a failed write degrades to a logged
 * warning, never a build blocker.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { toAsciiGovernanceText } from '../tools/governance-text.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * The result of {@link detectComplianceRegimes}: which regulatory regimes a product plausibly
 * falls under, plus the concrete technical requirements and prohibited patterns those regimes
 * impose. `regimes` is the human-readable list (e.g. `['HIPAA', 'GDPR']`); the four booleans are
 * the same information in a directly-queryable shape for callers that only care about one regime
 * (e.g. a Sentinel gate that only needs to know `pciDss`).
 */
export interface ComplianceRequirements {
  /** Human-readable regime names detected, e.g. `['HIPAA', 'GDPR']`. Empty when none detected. */
  regimes: string[];
  /** Health Insurance Portability and Accountability Act (US health/medical data). */
  hipaa: boolean;
  /** General Data Protection Regulation (EU personal data). */
  gdpr: boolean;
  /** Payment Card Industry Data Security Standard (card/payment processing). */
  pciDss: boolean;
  /** Sarbanes-Oxley Act (US public-company financial reporting). */
  sox: boolean;
  /** Concrete technical requirements across every detected regime, deduplicated. */
  requirements: string[];
  /** Concrete prohibited patterns across every detected regime, deduplicated. */
  prohibitions: string[];
  /** True when any detected regime mandates an audit log (HIPAA, PCI-DSS, SOX all do). */
  auditLogRequired: boolean;
  /** True when any detected regime mandates encryption at rest (HIPAA, PCI-DSS, GDPR all do). */
  encryptionAtRestRequired: boolean;
  /**
   * The shortest mandatory data-retention window across detected regimes, in days, or `null` when
   * no detected regime imposes one (GDPR imposes a maximum retention ceiling rather than a floor,
   * so it does not contribute a value here — see the regime table below).
   */
  dataRetentionDays: number | null;
}

// ---------------------------------------------------------------------------
// Regime detection keyword table
// ---------------------------------------------------------------------------

/** One regulatory regime's detection keywords + the requirements/prohibitions it imposes. */
interface RegimeDefinition {
  /** Human-readable name, as it appears in `ComplianceRequirements.regimes`. */
  name: string;
  /** Word-boundary, case-insensitive keywords. Any single hit is sufficient to flag the regime. */
  keywords: readonly string[];
  /** Concrete technical requirements this regime imposes on the build. */
  requirements: readonly string[];
  /** Concrete prohibited patterns this regime imposes on the build. */
  prohibitions: readonly string[];
  /** Whether this regime mandates an audit log of access/changes to regulated data. */
  auditLogRequired: boolean;
  /** Whether this regime mandates encryption at rest for regulated data. */
  encryptionAtRestRequired: boolean;
  /** A minimum mandatory retention window in days, or `null` if this regime does not impose one. */
  minRetentionDays: number | null;
}

/**
 * The four regimes this module detects, in the order they are evaluated. Order does not affect
 * detection (every regime is checked independently, unlike `ux-intelligence.ts`'s highest-score
 * tie-break) — a PRD can and often does trigger more than one regime at once (e.g. a healthcare
 * SaaS billing patients by card is both HIPAA and PCI-DSS).
 */
const REGIME_DEFINITIONS: readonly RegimeDefinition[] = [
  {
    name: 'HIPAA',
    keywords: ['health', 'medical', 'patient', 'phi', 'clinical', 'hipaa'],
    requirements: [
      'Encrypt all Protected Health Information (PHI) at rest using AES-256 or equivalent.',
      'Encrypt all PHI in transit using TLS 1.2 or higher — no plaintext HTTP for any PHI-carrying route.',
      'Maintain an immutable audit log of every create/read/update/delete on PHI: who, what, when, from where.',
      'Enforce role-based access control (RBAC) scoped to minimum-necessary access for each role.',
      'Support a documented breach-notification workflow (detect, contain, notify within the regulatory window).',
      'De-identify or pseudonymize PHI in any non-production environment (staging, analytics, logs).',
      'Obtain and track a signed Business Associate Agreement (BAA) with every third-party processor of PHI.',
    ],
    prohibitions: [
      'Never log PHI (names, diagnoses, medical record numbers, SSNs) to plaintext application logs.',
      'Never send PHI to a third-party analytics, error-tracking, or AI service without a signed BAA in place.',
      'Never store PHI in client-side storage (localStorage, sessionStorage, unencrypted cookies).',
      'Never expose PHI in URL query strings (query strings land in browser history, proxy logs, referrer headers).',
    ],
    auditLogRequired: true,
    encryptionAtRestRequired: true,
    minRetentionDays: 2190, // 6 years — the HIPAA minimum for most covered-entity records.
  },
  {
    name: 'GDPR',
    keywords: ['eu', 'european', 'gdpr', 'personal data', 'privacy', 'consent'],
    requirements: [
      'Obtain explicit, opt-in, freely-given consent before collecting or processing personal data.',
      'Provide a self-service data export (Right to Access, Article 15) in a structured, machine-readable format.',
      'Provide a self-service or supported account/data deletion path (Right to Erasure, Article 17).',
      'Provide a data-portability export path (Right to Data Portability, Article 20).',
      'Maintain a Record of Processing Activities (ROPA) documenting what personal data is collected and why.',
      'Implement data minimization: collect only the personal data strictly necessary for the stated purpose.',
      'Support a documented 72-hour breach-notification workflow to the relevant supervisory authority.',
      'If transferring personal data outside the EU/EEA, use a valid transfer mechanism (SCCs or adequacy decision).',
    ],
    prohibitions: [
      'Never set non-essential cookies or trackers before consent is explicitly granted.',
      'Never use pre-checked consent checkboxes or bundle consent with terms-of-service acceptance.',
      'Never retain personal data indefinitely with no defined, documented retention/deletion policy.',
      'Never share personal data with a third party without a Data Processing Agreement (DPA) in place.',
    ],
    auditLogRequired: false,
    encryptionAtRestRequired: true,
    minRetentionDays: null, // GDPR imposes a maximum retention ceiling, not a minimum floor.
  },
  {
    name: 'PCI-DSS',
    keywords: ['payment', 'card', 'credit', 'debit', 'stripe', 'checkout', 'billing'],
    requirements: [
      'Never handle raw card numbers (PAN) directly — use a PCI-compliant processor\'s tokenized flow (e.g. Stripe Elements/Checkout, Stripe.js).',
      'Encrypt any stored payment-related data (tokens, last-4, billing address) at rest.',
      'Enforce TLS 1.2+ on every route that touches checkout, billing, or payment-method management.',
      'Maintain an audit log of every payment-method create/update/delete and every charge attempt.',
      'Restrict access to payment/billing admin functionality to a documented, minimum-necessary role set.',
      'Run the project through the appropriate PCI Self-Assessment Questionnaire (SAQ) type before go-live.',
    ],
    prohibitions: [
      'Never store the full Primary Account Number (PAN), CVV/CVC, or magnetic-stripe/chip data, in any form, anywhere.',
      'Never log a card number, even partially, to application logs, error trackers, or analytics events.',
      'Never transmit card data over an unencrypted channel or embed it in a URL.',
      'Never build a custom card-entry form that posts card data to your own backend instead of the processor\'s tokenized endpoint.',
    ],
    auditLogRequired: true,
    encryptionAtRestRequired: true,
    minRetentionDays: null, // PCI-DSS caps retention (delete PAN-adjacent data ASAP) rather than mandating a floor.
  },
  {
    name: 'SOX',
    keywords: ['financial reporting', 'audit', 'public company', 'sec'],
    requirements: [
      'Maintain an immutable, tamper-evident audit trail of every change to financial records: who, what, when.',
      'Enforce segregation of duties: no single role may both create and approve a financial transaction.',
      'Retain financial records and supporting audit evidence for a minimum of 7 years.',
      'Implement change-management controls (review + approval) for any code path that touches financial reporting logic.',
      'Support point-in-time reconstruction of financial data as of any past reporting period.',
    ],
    prohibitions: [
      'Never allow a financial record to be hard-deleted — use soft-delete/versioning so the audit trail is preserved.',
      'Never grant a single account both transaction-creation and transaction-approval permissions.',
      'Never allow direct database writes to financial tables that bypass the application\'s audit-logging layer.',
    ],
    auditLogRequired: true,
    encryptionAtRestRequired: false,
    minRetentionDays: 2555, // 7 years — the SOX minimum for financial records and audit workpapers.
  },
];

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/** Escape a string for safe embedding inside a `RegExp` (word-boundary keyword matching). */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * True if `haystack` (already lowercased) contains `keyword` as a whole word/phrase. Multi-word
 * keywords (e.g. `'personal data'`, `'financial reporting'`) match as a literal phrase with word
 * boundaries at each end, not as two independently-matched words.
 */
function containsKeyword(haystack: string, keyword: string): boolean {
  const pattern = new RegExp(`\\b${escapeRegExp(keyword.toLowerCase())}\\b`);
  return pattern.test(haystack);
}

/**
 * Detect which regulatory regimes `prdContent` + `blueprintContent` plausibly trigger, and return
 * the concrete, regime-specific requirements/prohibitions those regimes impose. Both inputs are
 * concatenated and matched case-insensitively against {@link REGIME_DEFINITIONS} — a single
 * keyword hit anywhere in either document is sufficient to flag a regime (this module errs toward
 * over-detection; see the module doc comment for why). Empty/blank/absent input for both
 * parameters returns an all-false, empty result — never throws.
 */
export function detectComplianceRegimes(
  prdContent: string,
  blueprintContent: string
): ComplianceRequirements {
  const safePrd = typeof prdContent === 'string' ? prdContent : '';
  const safeBlueprint = typeof blueprintContent === 'string' ? blueprintContent : '';
  const haystack = `${safePrd}\n\n${safeBlueprint}`.toLowerCase();

  const detected: RegimeDefinition[] = [];
  for (const regime of REGIME_DEFINITIONS) {
    const hit = regime.keywords.some((keyword) => containsKeyword(haystack, keyword));
    if (hit) detected.push(regime);
  }

  const requirements = dedupe(detected.flatMap((r) => r.requirements));
  const prohibitions = dedupe(detected.flatMap((r) => r.prohibitions));
  const auditLogRequired = detected.some((r) => r.auditLogRequired);
  const encryptionAtRestRequired = detected.some((r) => r.encryptionAtRestRequired);

  const retentionFloors = detected
    .map((r) => r.minRetentionDays)
    .filter((d): d is number => d !== null);
  const dataRetentionDays = retentionFloors.length > 0 ? Math.max(...retentionFloors) : null;

  const byName = new Set(detected.map((r) => r.name));

  return {
    regimes: detected.map((r) => r.name),
    hipaa: byName.has('HIPAA'),
    gdpr: byName.has('GDPR'),
    pciDss: byName.has('PCI-DSS'),
    sox: byName.has('SOX'),
    requirements,
    prohibitions,
    auditLogRequired,
    encryptionAtRestRequired,
    dataRetentionDays,
  };
}

/** Deduplicate a string array while preserving first-seen order. */
function dedupe(values: readonly string[]): string[] {
  return [...new Set(values)];
}

// ---------------------------------------------------------------------------
// COMPLIANCE_REQUIREMENTS.md rendering + write
// ---------------------------------------------------------------------------

/** Render the implementation checklist section from a {@link ComplianceRequirements}. */
function renderImplementationChecklist(requirements: ComplianceRequirements): string {
  const lines: string[] = [];
  lines.push(`- [ ] Audit logging: ${requirements.auditLogRequired ? 'REQUIRED — implement an immutable audit log before any regulated data is written.' : 'not required by any detected regime.'}`);
  lines.push(`- [ ] Encryption at rest: ${requirements.encryptionAtRestRequired ? 'REQUIRED — regulated data must be encrypted at rest (AES-256 or equivalent).' : 'not required by any detected regime.'}`);
  lines.push(
    `- [ ] Data retention: ${
      requirements.dataRetentionDays !== null
        ? `minimum ${requirements.dataRetentionDays} days (${Math.round(requirements.dataRetentionDays / 365)} years) mandated by the strictest detected regime.`
        : 'no mandatory minimum from a detected regime — confirm whether a maximum retention ceiling applies (e.g. GDPR data minimization).'
    }`
  );
  for (const requirement of requirements.requirements) {
    lines.push(`- [ ] ${requirement}`);
  }
  return lines.join('\n');
}

/** Render a complete `COMPLIANCE_REQUIREMENTS.md` body from a {@link ComplianceRequirements}. */
function renderComplianceMarkdown(requirements: ComplianceRequirements): string {
  const lines: string[] = [];

  lines.push('# COMPLIANCE_REQUIREMENTS.md — Regulatory Compliance Baseline');
  lines.push('');
  lines.push(
    '> Generated by FORGE 2.0 Phase 0 (Compliance Detector, `src/skills/compliance-detector.ts`). ' +
      'Detected from keyword analysis of PRD.md/BLUEPRINT.md — a REGIME BEING DETECTED IS NOT LEGAL ' +
      'ADVICE and a regime NOT being detected does not mean the build is exempt. This document is a ' +
      'starting checklist for engineering + human legal/compliance review, not a substitute for either.'
  );
  lines.push('');

  if (requirements.regimes.length === 0) {
    lines.push('- **Detected regimes:** _(none — no HIPAA/GDPR/PCI-DSS/SOX keyword signal found in PRD/BLUEPRINT)_');
  } else {
    lines.push(`- **Detected regimes:** ${requirements.regimes.join(', ')}`);
  }
  lines.push(`- **HIPAA:** ${requirements.hipaa ? 'YES' : 'no'}`);
  lines.push(`- **GDPR:** ${requirements.gdpr ? 'YES' : 'no'}`);
  lines.push(`- **PCI-DSS:** ${requirements.pciDss ? 'YES' : 'no'}`);
  lines.push(`- **SOX:** ${requirements.sox ? 'YES' : 'no'}`);
  lines.push(`- **Audit log required:** ${requirements.auditLogRequired ? 'YES' : 'no'}`);
  lines.push(`- **Encryption at rest required:** ${requirements.encryptionAtRestRequired ? 'YES' : 'no'}`);
  lines.push(
    `- **Minimum data retention:** ${
      requirements.dataRetentionDays !== null ? `${requirements.dataRetentionDays} days` : 'none mandated'
    }`
  );
  lines.push('');

  lines.push('## Technical Requirements');
  lines.push('');
  if (requirements.requirements.length === 0) {
    lines.push('_(none — no regime detected)_');
  } else {
    for (const requirement of requirements.requirements) lines.push(`- ${requirement}`);
  }
  lines.push('');

  lines.push('## Prohibited Patterns');
  lines.push('');
  if (requirements.prohibitions.length === 0) {
    lines.push('_(none — no regime detected)_');
  } else {
    for (const prohibition of requirements.prohibitions) lines.push(`- ${prohibition}`);
  }
  lines.push('');

  lines.push('## Implementation Checklist');
  lines.push('');
  if (requirements.regimes.length === 0) {
    lines.push('_(no checklist items — no regime detected)_');
  } else {
    lines.push(renderImplementationChecklist(requirements));
  }
  lines.push('');

  return lines.join('\n');
}

/**
 * Write a {@link ComplianceRequirements} to `<projectPath>/governance/COMPLIANCE_REQUIREMENTS.md`.
 * Creates the `governance/` directory if it does not yet exist. Guarded — a failed write is caught
 * and silently logged to the console rather than thrown, matching every other Phase 0 step's
 * degraded-not-fatal posture (BEHAVIORAL_CONTRACTS Contract 4); this module has no `log` injection
 * point of its own, so the caller (Phase 0) is responsible for its own success/failure logging
 * around this call.
 */
export function writeComplianceDoc(requirements: ComplianceRequirements, projectPath: string): void {
  try {
    const governanceDir = join(projectPath, 'governance');
    mkdirSync(governanceDir, { recursive: true });
    const outputPath = join(governanceDir, 'COMPLIANCE_REQUIREMENTS.md');
    const markdown = renderComplianceMarkdown(requirements);
    writeFileSync(outputPath, toAsciiGovernanceText(markdown), 'utf8');
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    // eslint-disable-next-line no-console
    console.error(`[COMPLIANCE] failed to write COMPLIANCE_REQUIREMENTS.md: ${detail}`);
  }
}
