/**
 * FORGE 2.0 — UI Engine: AccessibilityChecker (static WCAG 2.1 AA source scan).
 *
 * A regex-based (not AST-based — the same deliberate scope choice `src/retrofit/dead-code-detector.ts`
 * and its siblings document for themselves) static analyzer over a generated React/TSX component's
 * SOURCE CODE. It never boots a browser and never runs axe-core — that is the job of the separate,
 * heavier `src/tools/accessibility-auditor.ts` (Sentinel's existing OPTIONAL `accessibility` check,
 * which requires a bootable dev server). This module is the lightweight sibling purpose-built for
 * `src/ui-engine/component-generator.ts`'s output: it can flag a real WCAG 2.1 AA structural issue
 * directly from the `.tsx` text FORGE just wrote, with zero infrastructure, before the component
 * ever reaches a browser.
 *
 * House style, matching `component-generator.ts`/`shadcn-installer.ts`/`storybook-generator.ts`:
 * every exported function is pure and NEVER throws (Iron Law 3) — an unreadable file or an
 * unparseable snippet degrades to an empty/skipped result, never a fabricated pass and never an
 * uncaught exception that could take down a Sentinel gate.
 *
 * Checks implemented (each produces its own {@link AccessibilityIssue.rule} id so a caller can
 * filter/report per rule):
 *   1. `aria-label-required`            — icon-only / textless `<button>` with no aria-label(ledby)
 *   2. `img-alt-required`               — `<img>`/`<Image>` with no `alt` attribute
 *   3. `label-htmlfor-required`         — `<label>` with no `htmlFor` and no nested form control
 *   4. `onclick-non-interactive-element`— `onClick` on a bare `<div>`/`<span>`
 *   5. `missing-role-interactive`       — `onClick` on a non-native-interactive element with no `role`
 *   6. `hardcoded-color-contrast`       — a hardcoded hex/rgb(a) color that can't be contrast-verified
 *                                         (hex values already declared in the project's own
 *                                         tailwind.config/globals.css design tokens are exempt — see
 *                                         {@link extractDeclaredColorTokens})
 *   7. `keyboard-navigation-missing`    — `onClick` with no `onKeyDown`/`onKeyPress`/`onKeyUp` sibling
 *   8. `form-field-missing-label`       — `<input>`/`<select>`/`<textarea>` with no associated label
 *   9. `dialog-missing-arialabelledby`  — a dialog/modal element with no accessible name
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

// ---------------------------------------------------------------------------
// Public contract
// ---------------------------------------------------------------------------

/** One WCAG 2.1 AA finding, always paired with a concrete, actionable fix. */
export interface AccessibilityIssue {
  /** `'error'` blocks the gate; `'warning'` is surfaced but does not, by itself, fail the report. */
  severity: 'error' | 'warning';
  /** Stable machine-readable rule id (see the module doc comment for the full list). */
  rule: string;
  /** Human-readable description of what's wrong and why it matters to an assistive-tech user. */
  description: string;
  /** A specific, actionable fix — never a generic "improve accessibility" placeholder. */
  fix: string;
  /** The offending JSX snippet (trimmed to one line), when the issue is tag-scoped. */
  element?: string;
}

/** The full accessibility report for one component source file. */
export interface AccessibilityReport {
  /** The path the report was generated for (as passed to {@link checkComponentAccessibility}). */
  filePath: string;
  /** Every issue found, in the order the checks ran. */
  issues: AccessibilityIssue[];
  /** `100 - (errors * 10) - (warnings * 3)`, clamped to `[0, 100]`. */
  score: number;
  /** `true` iff `score >= 70` AND there are zero `'error'`-severity issues. */
  passed: boolean;
}

// ---------------------------------------------------------------------------
// Internals — JSX extraction (regex-based, documented limitation, not an oversight)
// ---------------------------------------------------------------------------

interface JsxTag {
  tagName: string;
  attrs: string;
  raw: string;
}

interface JsxElement extends JsxTag {
  /** Text between the opening and closing tag; `''` for a self-closing element. */
  innerText: string;
}

/**
 * Native (or native-resolving) elements that are keyboard-interactive out of the box — never
 * flagged for role/keyboard rules. `Link`/`link` covers Next.js's `<Link>` component, which
 * renders a real `<a>` and is already keyboard/role-correct — without it, every Next.js link
 * false-positives `missing-role-interactive` and `keyboard-navigation-missing`.
 */
const NATIVE_INTERACTIVE_TAGS = new Set(['button', 'a', 'link', 'input', 'select', 'textarea']);

/** First line of a (possibly multi-line) JSX snippet, trimmed, for compact issue reporting. */
function firstLineOf(raw: string): string {
  const first = raw.split('\n')[0]?.trim() ?? raw.trim();
  return raw.includes('\n') ? `${first} …` : first;
}

/**
 * Extract every JSX opening tag (self-closing or not) in `code`. Deliberately excludes closing
 * tags (`</div>`) since the regex requires a letter immediately after `<`. May pick up a rare
 * false positive on a TS generic (`Array<string>`) — harmless, since generics never carry the
 * attributes (`onClick`, `role`, `aria-*`) any rule below actually checks for.
 */
function extractJsxTags(code: string): JsxTag[] {
  const tags: JsxTag[] = [];
  const tagRe = /<([A-Za-z][\w.]*)((?:\s+[^<>]*?)?)\/?>/g;
  let match: RegExpExecArray | null;
  while ((match = tagRe.exec(code)) !== null) {
    tags.push({ tagName: match[1] ?? '', attrs: match[2] ?? '', raw: match[0] });
  }
  return tags;
}

/**
 * Extract every element with the given `tagName`, self-closing and open/close pairs alike, WITH
 * inner content for the paired case. Uses a non-greedy match between the first opening tag and
 * the next closing tag of the same name — does not handle same-name nesting (e.g. a `<label>`
 * inside a `<label>`), a pragmatic limitation shared with every other regex-based scanner in
 * this codebase.
 */
function extractElements(code: string, tagName: string): JsxElement[] {
  const elements: JsxElement[] = [];

  const selfClosingRe = new RegExp(`<${tagName}((?:\\s+[^<>]*?)?)\\/>`, 'gi');
  let match: RegExpExecArray | null;
  while ((match = selfClosingRe.exec(code)) !== null) {
    elements.push({ tagName, attrs: match[1] ?? '', raw: match[0], innerText: '' });
  }

  const pairedRe = new RegExp(`<${tagName}((?:\\s+[^<>]*?)?)>([\\s\\S]*?)<\\/${tagName}>`, 'gi');
  while ((match = pairedRe.exec(code)) !== null) {
    elements.push({ tagName, attrs: match[1] ?? '', raw: firstLineOf(match[0]), innerText: match[2] ?? '' });
  }

  return elements;
}

/** True iff `attrs` declares `attrName=` (any value form — string, expression, or shorthand-adjacent). */
function hasAttr(attrs: string, attrName: string): boolean {
  return new RegExp(`\\b${attrName}\\s*=`, 'i').test(attrs);
}

/** Best-effort extraction of a simple string-literal attribute value; `null` when not a plain string. */
function attrValue(attrs: string, attrName: string): string | null {
  const re = new RegExp(`\\b${attrName}\\s*=\\s*(?:\\{\\s*['"\`]?([^'"\`}]*)['"\`]?\\s*\\}|"([^"]*)"|'([^']*)')`, 'i');
  const match = re.exec(attrs);
  if (!match) return null;
  return match[1] ?? match[2] ?? match[3] ?? '';
}

/**
 * True iff `innerText` (the content between a paired tag's open/close) has some real, human-
 * visible text left after stripping nested JSX tags (icons render as empty) and JS comments.
 * A bare expression like `{label}` is generously counted as "has text" (its identifier survives
 * brace-stripping) to avoid false-positiving every component that renders a text prop — the
 * false-negative risk (missing a genuinely empty `{icon}`-only expression) is the safer failure
 * mode for a gate that blocks a build on 'error'.
 */
function hasVisibleTextContent(innerText: string): boolean {
  const withoutTags = innerText.replace(/<[^>]*>/g, ' ');
  const withoutComments = withoutTags.replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, ' ');
  const collapsed = withoutComments.replace(/[{}]/g, ' ').replace(/\s+/g, ' ').trim();
  return collapsed.length > 0;
}

// ---------------------------------------------------------------------------
// Rule 1 — missing aria-label on interactive elements (icon-only / textless buttons)
// ---------------------------------------------------------------------------

function checkMissingAriaLabelOnInteractive(code: string): AccessibilityIssue[] {
  const issues: AccessibilityIssue[] = [];
  for (const button of extractElements(code, 'button')) {
    if (hasAttr(button.attrs, 'aria-label') || hasAttr(button.attrs, 'aria-labelledby')) continue;
    if (hasVisibleTextContent(button.innerText)) continue;
    issues.push({
      severity: 'error',
      rule: 'aria-label-required',
      description:
        'Button has no visible text content and no aria-label/aria-labelledby — screen reader ' +
        'users cannot determine what it does (this is typically an icon-only button).',
      fix: 'Add aria-label="<description of the action>" to the button (e.g. aria-label="Delete item").',
      element: button.raw,
    });
  }
  return issues;
}

// ---------------------------------------------------------------------------
// Rule 2 — missing alt on img elements
// ---------------------------------------------------------------------------

function checkMissingAltOnImages(tags: JsxTag[]): AccessibilityIssue[] {
  const issues: AccessibilityIssue[] = [];
  for (const tag of tags) {
    if (tag.tagName !== 'img' && tag.tagName !== 'Image') continue;
    if (hasAttr(tag.attrs, 'alt')) continue;
    issues.push({
      severity: 'error',
      rule: 'img-alt-required',
      description: 'Image element has no alt attribute — screen reader users get no description of its content.',
      fix: 'Add alt="<description of the image>", or alt="" if the image is purely decorative.',
      element: firstLineOf(tag.raw),
    });
  }
  return issues;
}

// ---------------------------------------------------------------------------
// Rule 3 — missing htmlFor on label elements
// ---------------------------------------------------------------------------

function checkMissingHtmlForOnLabels(code: string): AccessibilityIssue[] {
  const issues: AccessibilityIssue[] = [];
  for (const label of extractElements(code, 'label')) {
    if (hasAttr(label.attrs, 'htmlFor')) continue;
    if (/<input|<select|<textarea/i.test(label.innerText)) continue; // nested control — still associated
    issues.push({
      severity: 'warning',
      rule: 'label-htmlfor-required',
      description:
        'Label element has no htmlFor attribute and does not wrap a form control — it is not ' +
        'programmatically associated with the field it describes.',
      fix: "Add htmlFor=\"<input-id>\" matching the associated field's id, or nest the field inside the label.",
      element: label.raw,
    });
  }
  return issues;
}

// ---------------------------------------------------------------------------
// Rule 4 — onClick handlers on non-interactive elements (div, span)
// ---------------------------------------------------------------------------

function checkOnClickOnNonInteractiveElements(tags: JsxTag[]): AccessibilityIssue[] {
  const issues: AccessibilityIssue[] = [];
  for (const tag of tags) {
    if (tag.tagName !== 'div' && tag.tagName !== 'span') continue;
    if (!hasAttr(tag.attrs, 'onClick')) continue;
    issues.push({
      severity: 'error',
      rule: 'onclick-non-interactive-element',
      description:
        `A <${tag.tagName}> has an onClick handler — it looks clickable to a sighted mouse user ` +
        'but is invisible to keyboard and screen-reader users, who cannot tab to or activate it.',
      fix: 'Replace it with a <button> element, or add role="button" tabIndex={0} plus a matching onKeyDown handler.',
      element: firstLineOf(tag.raw),
    });
  }
  return issues;
}

// ---------------------------------------------------------------------------
// Rule 5 — missing role on custom interactive elements
// ---------------------------------------------------------------------------

function checkMissingRoleOnCustomInteractive(tags: JsxTag[]): AccessibilityIssue[] {
  const issues: AccessibilityIssue[] = [];
  for (const tag of tags) {
    const tagNameLower = tag.tagName.toLowerCase();
    if (NATIVE_INTERACTIVE_TAGS.has(tagNameLower)) continue;
    if (!hasAttr(tag.attrs, 'onClick')) continue;
    if (hasAttr(tag.attrs, 'role')) continue;
    issues.push({
      severity: 'warning',
      rule: 'missing-role-interactive',
      description:
        `<${tag.tagName}> has an onClick handler but is not a native interactive element and has ` +
        'no role attribute — assistive technology has no way to announce it as interactive.',
      fix: 'Add role="button" (or the ARIA role matching the actual widget, e.g. role="menuitem").',
      element: firstLineOf(tag.raw),
    });
  }
  return issues;
}

// ---------------------------------------------------------------------------
// Rule 6 — color contrast (hardcoded color values that may fail WCAG AA contrast)
// ---------------------------------------------------------------------------

/** Files (relative to project root) that are the canonical source of a project's declared design tokens. */
const TOKEN_SOURCE_FILES: readonly string[] = [
  'tailwind.config.ts',
  'tailwind.config.js',
  'src/app/globals.css',
  'app/globals.css',
  'src/styles/globals.css',
  'styles/globals.css',
];

/**
 * Candidate locations for the project's own design brief — `forge design (site-)tournament`'s
 * `--brief <path-to-file>` copy of the source brief, when a project inlines its palette as named
 * prose tokens (e.g. `forest #1F3A2E`, `terracotta #C4663A`) rather than a tailwind.config/CSS
 * declaration. Any hex literal in one of these files is trusted as an approved token.
 */
const BRIEF_SOURCE_FILES: readonly string[] = ['brief.txt', 'brief.md', 'BRIEF.md', 'DESIGN_BRIEF.md', 'PRD.md'];

const HEX_LITERAL_RE = /#[0-9a-fA-F]{3}(?:[0-9a-fA-F]{3})?(?:[0-9a-fA-F]{2})?\b/g;

/** Normalize a hex color for palette comparison: lowercase, 3-digit shorthand expanded to 6-digit. */
function normalizeHex(hex: string): string {
  const h = hex.toLowerCase();
  if (h.length === 4) {
    const r = h[1];
    const g = h[2];
    const b = h[3];
    return `#${r}${r}${g}${g}${b}${b}`;
  }
  return h;
}

/**
 * Extract every hex color literal declared in `projectPath`'s own design-token sources
 * (`tailwind.config.ts`/`.js`, `globals.css`, and — since a brief may specify its palette as
 * named inline-hex tokens rather than a config file, e.g. "forest #1F3A2E ... sage #8FA68E ...
 * terracotta #C4663A" — the project's own brief file) into a normalized set. These ARE the
 * project's approved palette, so a component using one of these exact hex values is correctly
 * consuming a declared token, not hardcoding an unverified color. Degrades to an empty set
 * (never throws) when none of the candidate files exist, matching `detectProjectTokens`'s
 * posture in `design-token-manager.ts`.
 */
export function extractDeclaredColorTokens(projectPath: string): Set<string> {
  const tokens = new Set<string>();
  for (const relativePath of [...TOKEN_SOURCE_FILES, ...BRIEF_SOURCE_FILES]) {
    let source: string;
    try {
      source = readFileSync(join(projectPath, relativePath), 'utf8');
    } catch {
      continue;
    }
    for (const match of source.matchAll(HEX_LITERAL_RE)) {
      tokens.add(normalizeHex(match[0]));
    }
  }
  return tokens;
}

function checkHardcodedColorContrast(code: string, declaredColorTokens: Set<string>): AccessibilityIssue[] {
  const issues: AccessibilityIssue[] = [];
  const seen = new Set<string>();

  const hexRe = /#[0-9a-fA-F]{3}(?:[0-9a-fA-F]{3})?(?:[0-9a-fA-F]{2})?\b/g;
  let match: RegExpExecArray | null;
  while ((match = hexRe.exec(code)) !== null) {
    const color = match[0];
    if (seen.has(color)) continue;
    seen.add(color);
    if (declaredColorTokens.has(normalizeHex(color))) continue; // an approved project design token
    issues.push(colorContrastIssue(color));
  }

  const rgbRe = /rgba?\([^)]+\)/g;
  while ((match = rgbRe.exec(code)) !== null) {
    const color = match[0];
    if (seen.has(color)) continue;
    seen.add(color);
    issues.push(colorContrastIssue(color));
  }

  return issues;
}

function colorContrastIssue(color: string): AccessibilityIssue {
  return {
    severity: 'warning',
    rule: 'hardcoded-color-contrast',
    description:
      `Hardcoded color value ${color} cannot be verified for WCAG AA contrast (4.5:1 for normal ` +
      'text, 3:1 for large text and UI components) without knowing its paired foreground/background.',
    fix:
      'Replace with a design-token/Tailwind theme color that has already been contrast-checked, ' +
      'or verify this exact color pairing with a contrast checker before shipping.',
    element: color,
  };
}

// ---------------------------------------------------------------------------
// Rule 7 — keyboard navigation (onKeyDown missing when onClick present on non-native elements)
// ---------------------------------------------------------------------------

function checkKeyboardNavigation(tags: JsxTag[]): AccessibilityIssue[] {
  const issues: AccessibilityIssue[] = [];
  for (const tag of tags) {
    const tagNameLower = tag.tagName.toLowerCase();
    if (NATIVE_INTERACTIVE_TAGS.has(tagNameLower)) continue;
    if (!hasAttr(tag.attrs, 'onClick')) continue;
    if (hasAttr(tag.attrs, 'onKeyDown') || hasAttr(tag.attrs, 'onKeyPress') || hasAttr(tag.attrs, 'onKeyUp')) continue;
    issues.push({
      severity: 'error',
      rule: 'keyboard-navigation-missing',
      description:
        `<${tag.tagName}> has an onClick handler but no onKeyDown/onKeyPress/onKeyUp handler — ` +
        'keyboard-only users cannot activate it even if it is otherwise focusable.',
      fix:
        'Add an onKeyDown handler that triggers the same action on Enter and Space, or use a ' +
        'native <button>/<a> element, which handles this automatically.',
      element: firstLineOf(tag.raw),
    });
  }
  return issues;
}

// ---------------------------------------------------------------------------
// Rule 8 — form fields missing associated labels
// ---------------------------------------------------------------------------

const FORM_FIELD_TAGS = new Set(['input', 'select', 'textarea']);

function checkFormFieldsMissingLabels(tags: JsxTag[], code: string): AccessibilityIssue[] {
  const issues: AccessibilityIssue[] = [];
  for (const tag of tags) {
    const tagNameLower = tag.tagName.toLowerCase();
    if (!FORM_FIELD_TAGS.has(tagNameLower)) continue;
    if (attrValue(tag.attrs, 'type') === 'hidden') continue;
    if (hasAttr(tag.attrs, 'aria-label') || hasAttr(tag.attrs, 'aria-labelledby')) continue;

    const id = attrValue(tag.attrs, 'id');
    if (id !== null && id !== '' && codeHasMatchingHtmlFor(code, id)) continue;

    issues.push({
      severity: 'error',
      rule: 'form-field-missing-label',
      description:
        `<${tag.tagName}> has no associated <label> (via htmlFor/id) and no aria-label/aria-labelledby ` +
        '— screen reader users will not know what to enter into this field.',
      fix: "Add a <Label htmlFor=\"<id>\"> matching the field's id, or add an aria-label attribute directly on the field.",
      element: firstLineOf(tag.raw),
    });
  }
  return issues;
}

/** True iff `code` contains a `htmlFor` attribute (string-literal form) whose value equals `id`. */
function codeHasMatchingHtmlFor(code: string, id: string): boolean {
  const escapedId = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`htmlFor\\s*=\\s*(?:"${escapedId}"|'${escapedId}'|\\{\\s*['"\`]${escapedId}['"\`]\\s*\\})`, 'm');
  return re.test(code);
}

// ---------------------------------------------------------------------------
// Rule 9 — dialog missing aria-labelledby
// ---------------------------------------------------------------------------

const DIALOG_TAG_NAMES = new Set(['dialog', 'Dialog', 'DialogContent', 'Modal', 'AlertDialog', 'AlertDialogContent']);

function checkDialogMissingAriaLabelledby(tags: JsxTag[]): AccessibilityIssue[] {
  const issues: AccessibilityIssue[] = [];
  for (const tag of tags) {
    const isDialogTag = DIALOG_TAG_NAMES.has(tag.tagName);
    const isRoleDialog = attrValue(tag.attrs, 'role') === 'dialog' || attrValue(tag.attrs, 'role') === 'alertdialog';
    if (!isDialogTag && !isRoleDialog) continue;
    if (hasAttr(tag.attrs, 'aria-labelledby') || hasAttr(tag.attrs, 'aria-label')) continue;
    issues.push({
      severity: 'warning',
      rule: 'dialog-missing-arialabelledby',
      description:
        'Dialog/modal element has no aria-labelledby or aria-label — screen reader users will not ' +
        'hear an accessible name announced when it opens.',
      fix: "Add aria-labelledby=\"<title-element-id>\" pointing at the dialog's title element, or aria-label=\"<purpose>\".",
      element: firstLineOf(tag.raw),
    });
  }
  return issues;
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

const PASS_SCORE_THRESHOLD = 70;
const ERROR_PENALTY = 10;
const WARNING_PENALTY = 3;

function clampScore(score: number): number {
  return Math.max(0, Math.min(100, score));
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run every WCAG 2.1 AA check above against one component's already-read `code`, tagged with
 * `filePath` for the report. Pure and synchronous — never touches the filesystem itself, EXCEPT
 * that `declaredColorTokens` (see {@link extractDeclaredColorTokens}) is expected to already
 * reflect the project's own design-token palette so rule 6 can exempt approved tokens; callers
 * that omit it (or pass an empty set) get the old behavior of flagging every hardcoded hex value.
 */
export function checkComponentAccessibility(
  filePath: string,
  code: string,
  declaredColorTokens: Set<string> = new Set()
): AccessibilityReport {
  const tags = extractJsxTags(code);

  const issues: AccessibilityIssue[] = [
    ...checkMissingAriaLabelOnInteractive(code),
    ...checkMissingAltOnImages(tags),
    ...checkMissingHtmlForOnLabels(code),
    ...checkOnClickOnNonInteractiveElements(tags),
    ...checkMissingRoleOnCustomInteractive(tags),
    ...checkHardcodedColorContrast(code, declaredColorTokens),
    ...checkKeyboardNavigation(tags),
    ...checkFormFieldsMissingLabels(tags, code),
    ...checkDialogMissingAriaLabelledby(tags),
  ];

  const errorCount = issues.filter((issue) => issue.severity === 'error').length;
  const warningCount = issues.filter((issue) => issue.severity === 'warning').length;
  const score = clampScore(100 - errorCount * ERROR_PENALTY - warningCount * WARNING_PENALTY);
  const passed = score >= PASS_SCORE_THRESHOLD && errorCount === 0;

  return { filePath, issues, score, passed };
}

const COMPONENT_FILE_RE = /\.tsx$/;
const TEST_OR_STORY_RE = /\.(test|spec)\.tsx$|\.stories\.tsx$/;
const EXCLUDE_DIRS = new Set(['node_modules', '.git', '.next', 'dist', 'build', 'out', 'coverage']);

/** Recursively collects every `*.tsx` file under `dir` (skipping test/story files and build output). */
function walkComponentFiles(dir: string): string[] {
  const acc: string[] = [];

  function walk(current: string): void {
    let entries: string[];
    try {
      entries = readdirSync(current);
    } catch {
      return; // unreadable/absent directory — skip, never throw
    }

    for (const entry of entries) {
      if (EXCLUDE_DIRS.has(entry)) continue;
      const fullPath = join(current, entry);

      let stats;
      try {
        stats = statSync(fullPath);
      } catch {
        continue; // unreadable entry — skip
      }

      if (stats.isDirectory()) {
        walk(fullPath);
      } else if (COMPONENT_FILE_RE.test(entry) && !TEST_OR_STORY_RE.test(entry)) {
        acc.push(fullPath);
      }
    }
  }

  walk(dir);
  return acc;
}

/**
 * Scan every `src/components/**\/*.tsx` file under `projectPath` and return one
 * {@link AccessibilityReport} per file. Degrades to an empty array when `src/components/` is
 * absent or unreadable — a project with no components yet is not a failure (Iron Law 3: never
 * fabricate a result for work that never happened).
 */
export async function checkProjectAccessibility(projectPath: string): Promise<AccessibilityReport[]> {
  const componentsDir = join(projectPath, 'src', 'components');
  const files = walkComponentFiles(componentsDir);
  const declaredColorTokens = extractDeclaredColorTokens(projectPath);

  const reports: AccessibilityReport[] = [];
  for (const filePath of files) {
    let code: string;
    try {
      code = readFileSync(filePath, 'utf8');
    } catch {
      continue; // unreadable file — skip, never throw
    }
    reports.push(checkComponentAccessibility(relative(projectPath, filePath), code, declaredColorTokens));
  }
  return reports;
}
