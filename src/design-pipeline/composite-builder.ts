/**
 * FORGE 2.0 — Design Pipeline: CompositeBuilder (`src/design-pipeline/composite-builder.ts`).
 *
 * `upgrades/DESIGN_INTELLIGENCE.md`'s human "mix-and-match" workflow: a reviewer looking at
 * `design-tournament.ts`'s N variants (or any other set of generated components) rarely wants to
 * approve exactly ONE of them wholesale — the real ask is "take the header from Variant A, the nav
 * from Variant C, and the body from Variant D." This module is that assembly step:
 * {@link buildComposite} takes the human's own section-by-section picks
 * ({@link CompositeSectionSelection}[]) and reassembles them, VERBATIM, into one new component file
 * — never re-generating or rewriting the picked code, only recombining exactly what the human chose
 * (Iron Law 3: a composite is a literal reassembly, not a fresh AI guess at what the human meant).
 *
 * RE-RENDERS THROUGH THE REAL PIPELINE: once assembled and written to disk, the composite is fed
 * through `screenshotter.ts`'s own `PlaywrightScreenshotter.captureComponent` — the exact same real
 * headless-Chromium capture path every Design Tournament variant goes through (see
 * `design-tournament.ts`'s `captureVariant`, whose preview-page-under-`src/app`/dev-server-URL
 * pattern this module reuses directly) — so a composite is reviewable evidence (screenshots,
 * accessibility score) exactly like any other variant, never a "trust me, it renders" claim.
 *
 * DEV SERVER OWNERSHIP: unlike `design-tournament.ts`'s `DesignTournamentEngine` (which owns its
 * `PlaywrightScreenshotter` for one whole run and starts/stops the dev server itself), a composite
 * build may be one of several calls sharing a caller-supplied `PlaywrightScreenshotter` instance
 * (e.g. building several composites back-to-back against the same running dev server). This module
 * therefore calls `startDevServer` (idempotent — reuses an already-running server) but deliberately
 * never calls `stopDevServer`: stopping a server another in-flight composite build (or the caller
 * itself) still needs would be a real bug. The caller owns the screenshotter's lifecycle end-to-end,
 * matching `captureComponent`'s own low-level contract.
 *
 * House style, matching every sibling `src/design-pipeline/` module: {@link buildComposite} never
 * throws — a write failure, a missing screenshotter, or a render failure degrades to a returned
 * `renderError`/`filePath: null`/`screenshots: []`, never an uncaught exception.
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

import { logLine } from '../tools/forge-logger.js';
import type { PlaywrightScreenshotter, ScreenshotResult } from './screenshotter.js';

const log = logLine('composite-builder');

// ---------------------------------------------------------------------------
// Public contract
// ---------------------------------------------------------------------------

/**
 * One human-picked element/section, verbatim from a specific source variant. `code` is the exact
 * JSX/TSX snippet the human chose (already isolated by whatever review UI presented the variants —
 * this module assembles picks, it does not itself parse a full component file into sections).
 */
export interface CompositeSectionSelection {
  /** The source variant this section was picked from, e.g. a `design-tournament.ts` `DesignDirection.id`. */
  sourceVariantId: string;
  /** Optional human-readable label for the source variant, e.g. `'Command Center'`. */
  sourceVariantLabel?: string;
  /** The human's own name for what this snippet represents, e.g. `'header'`, `'sidebar nav'`. */
  sectionName: string;
  /** The verbatim picked code/JSX for this section — never rewritten. */
  code: string;
}

export interface BuildCompositeOptions {
  /** Name for the resulting composite component, e.g. `'InvoiceCardComposite'`. Sanitized to a valid identifier. */
  componentName: string;
  /** Ordered section selections — assembled in this order into the composite's JSX return body. */
  selections: readonly CompositeSectionSelection[];
  /** Target project root; the composite is written to `<projectPath>/src/components/<componentName>.tsx`. */
  projectPath: string;
  /** `build_runs.id` this composite belongs to, for `screenshotter.ts` capture provenance. */
  buildRunId?: string;
  /** Prompt id this composite was triggered by, for `screenshotter.ts` capture provenance. */
  promptId?: string;
  /** When supplied, the composite is re-rendered/captured through the real capture path (see file header). Omit to build-only. */
  screenshotter?: PlaywrightScreenshotter | null;
  log?: (message: string) => void;
}

export interface CompositeBuildResult {
  /** The sanitized component name actually used (matches the written file's exported function name). */
  componentName: string;
  /** The assembled composite TSX source. */
  code: string;
  /** Absolute path the composite was written to, or `null` if the write failed. */
  filePath: string | null;
  /** Distinct `sourceVariantId`s the composite was assembled from. */
  sourceVariantIds: string[];
  sectionCount: number;
  /** Real captures from `screenshotter.ts`, when a screenshotter was supplied and the re-render succeeded. */
  screenshots: ScreenshotResult[];
  /** Non-null iff the composite could not be fully built and/or re-rendered — never fabricated success. */
  renderError: string | null;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Strip anything that isn't a valid identifier character; guarantee a valid, non-empty PascalCase-ish name. */
function sanitizeComponentName(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9_]+/g, '');
  if (cleaned === '') return 'Composite';
  return /^[A-Za-z_]/.test(cleaned) ? cleaned : `Composite${cleaned}`;
}

function indentBlock(code: string, indent: string): string {
  return code
    .split('\n')
    .map((line) => (line.length > 0 ? `${indent}${line}` : line))
    .join('\n');
}

/**
 * Assemble one composite TSX component source from `selections`, in the order supplied. Each
 * selection's snippet is preserved verbatim and labeled with a JSX comment naming its section and
 * source variant, so the resulting file stays legible/auditable as a mix-and-match rather than a
 * black box a reviewer has to reverse-engineer.
 */
export function assembleCompositeCode(componentName: string, selections: readonly CompositeSectionSelection[]): string {
  const safeName = sanitizeComponentName(componentName);

  if (selections.length === 0) {
    return `export function ${safeName}() {\n  return null; // no sections selected\n}\n`;
  }

  const body = selections
    .map((s) => {
      const label = s.sourceVariantLabel ? `${s.sourceVariantLabel} (${s.sourceVariantId})` : s.sourceVariantId;
      return `{/* section: ${s.sectionName} — from ${label} */}\n${s.code}`;
    })
    .join('\n');

  return (
    `export function ${safeName}() {\n` +
    `  return (\n` +
    `    <>\n` +
    `${indentBlock(body, '      ')}\n` +
    `    </>\n` +
    `  );\n` +
    `}\n`
  );
}

function writeCompositeFile(projectPath: string, componentName: string, code: string, logFn: (m: string) => void): string | null {
  const filePath = join(projectPath, 'src', 'components', `${componentName}.tsx`);
  try {
    mkdirSync(join(projectPath, 'src', 'components'), { recursive: true });
    writeFileSync(filePath, code, 'utf8');
    logFn(`[COMPOSITE BUILDER] wrote ${filePath}`);
    return filePath;
  } catch (error) {
    logFn(`WARNING: [COMPOSITE BUILDER] failed to write composite file '${filePath}' (${describeError(error)})`);
    return null;
  }
}

/** POSIX-style relative import path (no extension) from `fromDir` to `toFileNoExt` — mirrors `design-tournament.ts`'s own helper. */
function relativeImportPath(fromDir: string, toFileNoExt: string): string {
  const rel = relative(fromDir, toFileNoExt).split('\\').join('/');
  return rel.startsWith('.') ? rel : `./${rel}`;
}

/** Minimal, valid Next.js App Router page that renders `componentName`, for screenshot capture. */
function buildPreviewPageSource(pageDir: string, componentFilePathNoExt: string, componentName: string): string {
  const importPath = relativeImportPath(pageDir, componentFilePathNoExt);
  return (
    `import { ${componentName} } from '${importPath}';\n\n` +
    `export default function ForgeCompositePreviewPage() {\n` +
    `  return <${componentName} />;\n` +
    `}\n`
  );
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Assemble `options.selections` (human-picked element/section choices from different generated
 * variants) into one coherent composite component, write it to
 * `<projectPath>/src/components/<componentName>.tsx`, and — when a {@link PlaywrightScreenshotter}
 * is supplied — re-render it through the SAME real capture path every other variant goes through, so
 * the composite can be visually reviewed exactly like any other variant (see file header). Never
 * throws.
 */
export async function buildComposite(options: BuildCompositeOptions): Promise<CompositeBuildResult> {
  const logFn = options.log ?? log;
  const componentName = sanitizeComponentName(options.componentName);
  const sourceVariantIds = [...new Set(options.selections.map((s) => s.sourceVariantId))];
  const code = assembleCompositeCode(componentName, options.selections);

  if (options.selections.length === 0) {
    logFn(`WARNING: [COMPOSITE BUILDER] '${componentName}' has zero section selections — writing an empty placeholder`);
  }

  const filePath = writeCompositeFile(options.projectPath, componentName, code, logFn);

  const base: CompositeBuildResult = {
    componentName,
    code,
    filePath,
    sourceVariantIds,
    sectionCount: options.selections.length,
    screenshots: [],
    renderError: filePath === null ? 'composite file could not be written to disk' : null,
  };

  if (filePath === null) return base;

  if (!options.screenshotter) {
    logFn(`[COMPOSITE BUILDER] '${componentName}' built from ${sourceVariantIds.length} source variant(s) (no screenshotter supplied — skipping re-render)`);
    return base;
  }

  return renderComposite(base, options.screenshotter, options, logFn);
}

/** Re-render an already-written composite through the real Playwright capture path. Never throws. */
async function renderComposite(
  base: CompositeBuildResult,
  screenshotter: PlaywrightScreenshotter,
  options: BuildCompositeOptions,
  logFn: (m: string) => void
): Promise<CompositeBuildResult> {
  const filePath = base.filePath as string;
  const runId = `composite-${Date.now()}-${Math.round(Math.random() * 1e6)}`;
  const previewDir = join(options.projectPath, 'src', 'app', '_forge-design-composite', runId);

  let screenshots: ScreenshotResult[] = [];
  let renderError: string | null = null;

  try {
    mkdirSync(previewDir, { recursive: true });
    const componentFileNoExt = filePath.replace(/\.tsx$/, '');
    const pageSource = buildPreviewPageSource(previewDir, componentFileNoExt, base.componentName);
    writeFileSync(join(previewDir, 'page.tsx'), pageSource, 'utf8');

    const port = await screenshotter.startDevServer(options.projectPath);
    if (port === null) {
      renderError = 'dev server did not become ready — composite was built but not re-rendered';
      logFn(`WARNING: [COMPOSITE BUILDER] ${renderError}`);
    } else {
      const route = `/_forge-design-composite/${runId}`;
      const url = `http://localhost:${port}${route}`;
      screenshots = await screenshotter.captureComponent(url, {
        projectPath: options.projectPath,
        buildRunId: options.buildRunId,
        promptId: options.promptId,
        componentName: base.componentName,
      });
      if (screenshots.length === 0) {
        renderError = 'composite was built but no screenshot could be captured';
      }
    }
  } catch (error) {
    renderError = `re-render failed: ${describeError(error)}`;
    logFn(`WARNING: [COMPOSITE BUILDER] ${renderError}`);
  } finally {
    try {
      rmSync(previewDir, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup — never blocks the returned result */
    }
  }

  logFn(
    `[COMPOSITE BUILDER] '${base.componentName}' built from ${base.sourceVariantIds.length} source variant(s), ` +
      `${screenshots.length} screenshot(s) captured`
  );

  return { ...base, screenshots, renderError };
}

export default buildComposite;
