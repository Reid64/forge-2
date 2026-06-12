/**
 * FORGE 2.0 — PDF Generator (`pdf-generator`).
 *
 * A self-contained layout engine + document builders that turn FORGE data (and the
 * applications FORGE builds) into professional, submission-ready PDFs using `pdf-lib`
 * (pure JS — NO native deps, NO fontkit; only the embedded Standard 14 fonts are used,
 * so a generated PDF carries no font binaries and renders identically everywhere).
 *
 * WHAT IT PRODUCES
 *   - FORGE BUILD REPORTS — the build's status, gate results, prompt roll-up, token/cost
 *     totals, each rendered with a COLORED STATUS BADGE (green = pass/completed, amber =
 *     warning/halted, red = fail, blue = running/info, grey = neutral).
 *   - GOVERNANCE DOCUMENTS — any governance markdown (BLUEPRINT / PRD / SCHEMA_REGISTRY /
 *     BEHAVIORAL_CONTRACTS …) rendered to PDF via a small, bounded markdown→blocks parser.
 *   - GRANT NARRATIVES — submission-ready: 1-inch margins, a title block, running header,
 *     numbered sections, and a "Page X of N" footer on every page.
 *   - BOARD REPORTS — a metrics dashboard (label/value/status rows) plus narrative sections.
 *   - AUDIT REPORTS — findings with severity badges, detail, and recommendations.
 *
 * SHARED LAYOUT ENGINE ({@link renderPdf} over a {@link PdfDocumentSpec} of {@link Block}s):
 *   automatic word-wrap (measured with the embedded font metrics), automatic page breaks,
 *   an optional auto-generated TABLE OF CONTENTS (reserved at the front so its page numbers
 *   are the FINAL page numbers), and a HEADER + FOOTER WITH PAGE NUMBERS stamped on every
 *   page at finalize time (after the total page count is known).
 *
 * BRANDING is configurable PER PROJECT and resolved (highest priority first) from: an inline
 * `brand` override → a `brandConfigPath` JSON file → a project's
 * `governance/DESIGN_SYSTEM.md` (hex colors are parsed out of the UI/UX Pro Max design
 * system) → built-in FORGE defaults. See {@link loadBrandTokens}.
 *
 * HOUSE STYLE (matching the sibling `src/tools/` modules — doc-generator, design-system-
 * generator): best-effort and NON-FATAL. Every file read is guarded, the logger is
 * injectable, and a missing DESIGN_SYSTEM.md / unreadable brand config / failed write
 * degrades to a `warnings` entry rather than throwing. `renderPdf` and every `generate*Pdf`
 * wrapper ALWAYS resolve. Writing is opt-in (`outputPath`); no `.env*` secret VALUES are
 * read or emitted, and only the caller-named output path is ever written.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import {
  PDFDocument,
  StandardFonts,
  rgb,
  PageSizes,
  type PDFFont,
  type PDFPage,
  type RGB,
} from 'pdf-lib';

import { logLine } from './forge-logger.js';
import { nowIso } from '../memory/index.js';
import type { BuildRun, BuildStatus } from '../types/index.js';

// ---------------------------------------------------------------------------
// Public content model
// ---------------------------------------------------------------------------

/** Semantic status of a row/badge → drives the indicator color. */
export type StatusLevel = 'success' | 'warning' | 'danger' | 'info' | 'neutral';

/** One labelled value, optionally carrying a status that tints its indicator. */
export interface KeyValueRow {
  label: string;
  value: string;
  status?: StatusLevel;
}

/**
 * A renderable content block. A {@link PdfDocumentSpec} is an ordered list of these; the
 * layout engine renders them top-to-bottom, breaking pages automatically.
 */
export type Block =
  | { kind: 'heading'; level: 1 | 2 | 3; text: string; /** default true for level≤tocDepth */ toc?: boolean }
  | { kind: 'paragraph'; text: string }
  | { kind: 'bullets'; items: string[] }
  | { kind: 'keyValues'; rows: KeyValueRow[] }
  | { kind: 'status'; label: string; status: StatusLevel; detail?: string }
  | { kind: 'table'; columns: string[]; rows: string[][] }
  | { kind: 'divider' }
  | { kind: 'spacer'; size?: number }
  | { kind: 'pageBreak' };

/** A document to render: a title/subtitle plus an ordered block list and optional metadata. */
export interface PdfDocumentSpec {
  title: string;
  subtitle?: string;
  blocks: Block[];
  meta?: { author?: string; subject?: string; keywords?: string[] };
}

// ---------------------------------------------------------------------------
// Branding
// ---------------------------------------------------------------------------

/** The three built-in font families (Standard 14 — no embedding of external fonts). */
export type BrandFontFamily = 'Helvetica' | 'Times' | 'Courier';

/** A fully-resolved brand palette + type choice used by the renderer. */
export interface BrandTokens {
  brandName: string;
  /** Headings + primary accents. */
  primary: RGB;
  /** Secondary accent (sub-rules, secondary headings). */
  secondary: RGB;
  /** Body text. */
  text: RGB;
  /** Captions, footer, muted labels. */
  muted: RGB;
  /** Page background for badges' text-on-color. */
  onColor: RGB;
  /** Status indicator colors. */
  success: RGB;
  warning: RGB;
  danger: RGB;
  info: RGB;
  neutral: RGB;
  fontFamily: BrandFontFamily;
}

/** A partial brand the caller may supply inline or via JSON (hex strings allowed for colors). */
export interface BrandOverride {
  brandName?: string;
  fontFamily?: BrandFontFamily;
  /** Any color may be a `#rrggbb`/`#rgb` hex string or an `RGB`. */
  primary?: string | RGB;
  secondary?: string | RGB;
  text?: string | RGB;
  muted?: string | RGB;
  success?: string | RGB;
  warning?: string | RGB;
  danger?: string | RGB;
  info?: string | RGB;
  neutral?: string | RGB;
}

/** The outcome of {@link loadBrandTokens}: resolved tokens + where they came from. */
export interface BrandResolution {
  tokens: BrandTokens;
  /** Which source supplied the palette: `inline` | `config` | `design-system` | `default`. */
  source: 'inline' | 'config' | 'design-system' | 'default';
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Render options + result
// ---------------------------------------------------------------------------

/** Page margins in PDF points (1 pt = 1/72 inch). */
export interface Margins {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/** Options for {@link renderPdf} and every `generate*Pdf` wrapper. */
export interface PdfOptions {
  /** Inline brand override (highest priority). */
  brand?: BrandOverride;
  /** Path to a JSON brand-config file (second priority). */
  brandConfigPath?: string;
  /** Project root; `governance/DESIGN_SYSTEM.md` under it is parsed for brand colors. */
  projectPath?: string;
  /** Page size `[width, height]` in points. Default `PageSizes.Letter`. */
  pageSize?: [number, number];
  /** Page margins in points. Default 72 (1 inch) on all sides. */
  margins?: Partial<Margins>;
  /** Generate a table of contents from the headings. Default `false`. */
  tableOfContents?: boolean;
  /** Heading levels included in the TOC (1 = H1 only, 2 = H1+H2). Default 2. */
  tocDepth?: 1 | 2;
  /** Running header text. Default: the document title. */
  headerText?: string;
  /** Footer text (left side). Default: brand name. */
  footerText?: string;
  /** Draw "Page X of N" in the footer. Default `true`. */
  pageNumbers?: boolean;
  /** If set, the rendered bytes are written here (unless `write:false`). */
  outputPath?: string;
  /** Write to `outputPath`. Default `true` when `outputPath` is set. */
  write?: boolean;
  /** Progress logger. Defaults to the structured FORGE logger (tagged `pdf-generator`). */
  log?: (message: string) => void;
}

/** The result of rendering a PDF. Never thrown — failures surface in `warnings`. */
export interface PdfResult {
  /** The rendered PDF bytes (empty only on a catastrophic, guarded failure). */
  bytes: Uint8Array;
  /** Number of pages produced. */
  pageCount: number;
  /** Absolute path the bytes were written to, or `null` (not requested / write failed). */
  outputPath: string | null;
  /** Non-fatal observations (brand source fallback, write failure, truncation, …). */
  warnings: string[];
  /** ISO-8601 timestamp the document was generated. */
  generatedAt: string;
}

// ---------------------------------------------------------------------------
// Constants + defaults
// ---------------------------------------------------------------------------

const DEFAULT_MARGIN = 72; // 1 inch
const DEFAULT_TOC_DEPTH = 2;

/** Font sizes (points) by role. */
const SIZE = {
  title: 24,
  subtitle: 13,
  h1: 17,
  h2: 13.5,
  h3: 11.5,
  body: 10.5,
  small: 9,
  badge: 9,
  footer: 8.5,
} as const;

/** Vertical leading multiplier applied to a font size for line height. */
const LEADING = 1.32;

/** TOC layout metrics (points). */
const TOC_ROW_H = 18;
const TOC_TITLE_BLOCK_H = 44;

/** FORGE default palette (a calm slate + blue, with conventional status colors). */
function defaultTokens(): BrandTokens {
  return {
    brandName: 'FORGE 2.0',
    fontFamily: 'Helvetica',
    primary: rgb(0.13, 0.16, 0.22), // slate-900-ish
    secondary: rgb(0.15, 0.39, 0.92), // blue-600
    text: rgb(0.13, 0.15, 0.18),
    muted: rgb(0.45, 0.48, 0.53),
    onColor: rgb(1, 1, 1),
    success: rgb(0.13, 0.55, 0.29), // green-600
    warning: rgb(0.85, 0.6, 0.05), // amber-600
    danger: rgb(0.79, 0.18, 0.18), // red-600
    info: rgb(0.15, 0.39, 0.92), // blue-600
    neutral: rgb(0.5, 0.53, 0.57), // grey-500
  };
}

/** Map a font family to its [regular, bold, italic, boldItalic] Standard fonts. */
const FONT_SET: Record<BrandFontFamily, [StandardFonts, StandardFonts, StandardFonts, StandardFonts]> = {
  Helvetica: [
    StandardFonts.Helvetica,
    StandardFonts.HelveticaBold,
    StandardFonts.HelveticaOblique,
    StandardFonts.HelveticaBoldOblique,
  ],
  Times: [
    StandardFonts.TimesRoman,
    StandardFonts.TimesRomanBold,
    StandardFonts.TimesRomanItalic,
    StandardFonts.TimesRomanBoldItalic,
  ],
  Courier: [
    StandardFonts.Courier,
    StandardFonts.CourierBold,
    StandardFonts.CourierOblique,
    StandardFonts.CourierBoldOblique,
  ],
};

/** BuildStatus → status indicator color level. */
const BUILD_STATUS_LEVEL: Record<BuildStatus, StatusLevel> = {
  completed: 'success',
  running: 'info',
  queued: 'neutral',
  failed: 'danger',
  halted: 'warning',
};

// ---------------------------------------------------------------------------
// Small guarded helpers
// ---------------------------------------------------------------------------

/** Default progress logger. */
function defaultLog(message: string): void {
  logLine('pdf-generator')(message);
}

/** Clamp a number into [0, 1]. */
function unit(n: number): number {
  if (Number.isNaN(n)) return 0;
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

/**
 * Parse a `#rgb`/`#rrggbb` hex color into a pdf-lib `RGB`. Returns `null` for anything else,
 * so callers can fall back to a default. Whitespace and a leading `#` are tolerated.
 */
export function hexToRgb(hex: string): RGB | null {
  const h = hex.trim().replace(/^#/, '');
  let r: number;
  let g: number;
  let b: number;
  if (/^[0-9a-fA-F]{3}$/.test(h)) {
    r = parseInt(h[0]! + h[0]!, 16);
    g = parseInt(h[1]! + h[1]!, 16);
    b = parseInt(h[2]! + h[2]!, 16);
  } else if (/^[0-9a-fA-F]{6}$/.test(h)) {
    r = parseInt(h.slice(0, 2), 16);
    g = parseInt(h.slice(2, 4), 16);
    b = parseInt(h.slice(4, 6), 16);
  } else {
    return null;
  }
  return rgb(unit(r / 255), unit(g / 255), unit(b / 255));
}

/** Coerce a `string | RGB | undefined` brand color to `RGB`, falling back to `fallback`. */
function toRgb(value: string | RGB | undefined, fallback: RGB): RGB {
  if (value === undefined) return fallback;
  if (typeof value === 'string') return hexToRgb(value) ?? fallback;
  return value;
}

/** Read a UTF-8 text file, returning `null` if it cannot be read. */
async function readTextSafe(absPath: string): Promise<string | null> {
  try {
    return await readFile(absPath, 'utf8');
  } catch {
    return null;
  }
}

/** Sanitize text for the Standard-14 fonts (WinAnsi): drop characters they cannot encode. */
function sanitize(text: string): string {
  // Normalize common typographic characters, then strip anything outside Latin-1.
  const normalized = text
    .replace(/\r\n?/g, '\n')
    .replace(/[‘’‚′]/g, "'")
    .replace(/[“”„″]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/…/g, '...')
    .replace(/•/g, '-')
    .replace(/ /g, ' ')
    .replace(/[\t\f\v]/g, ' ');
  let out = '';
  for (const ch of normalized) {
    const code = ch.codePointAt(0) ?? 0;
    out += code === 0x0a || (code >= 0x20 && code <= 0xff) ? ch : '';
  }
  return out;
}

// ---------------------------------------------------------------------------
// Brand resolution
// ---------------------------------------------------------------------------

/** Apply a {@link BrandOverride} onto a base token set (any field may be hex or RGB). */
function applyOverride(base: BrandTokens, o: BrandOverride): BrandTokens {
  return {
    brandName: o.brandName?.trim() || base.brandName,
    fontFamily: o.fontFamily ?? base.fontFamily,
    primary: toRgb(o.primary, base.primary),
    secondary: toRgb(o.secondary, base.secondary),
    text: toRgb(o.text, base.text),
    muted: toRgb(o.muted, base.muted),
    onColor: base.onColor,
    success: toRgb(o.success, base.success),
    warning: toRgb(o.warning, base.warning),
    danger: toRgb(o.danger, base.danger),
    info: toRgb(o.info, base.info),
    neutral: toRgb(o.neutral, base.neutral),
  };
}

/**
 * Extract a brand override from a `DESIGN_SYSTEM.md` body. Looks for labelled hex colors
 * (e.g. `Primary: #2563EB`, `Secondary #10B981`, `Accent: #...`) first; if no labelled
 * colors are found, falls back to the first distinct hex codes in document order
 * (primary, then secondary). Returns `null` when no hex color is present at all.
 */
export function parseDesignSystemColors(markdown: string): BrandOverride | null {
  const override: BrandOverride = {};
  const labelled: Array<[(hex: string) => void, RegExp]> = [
    [(v) => (override.primary = v), /\bprimary\b[^#\n]{0,40}(#[0-9a-fA-F]{3,6})/i],
    [(v) => (override.secondary = v), /\b(?:secondary|accent)\b[^#\n]{0,40}(#[0-9a-fA-F]{3,6})/i],
    [(v) => (override.text = v), /\b(?:text|foreground|ink)\b[^#\n]{0,40}(#[0-9a-fA-F]{3,6})/i],
    [(v) => (override.muted = v), /\b(?:muted|subtle|caption)\b[^#\n]{0,40}(#[0-9a-fA-F]{3,6})/i],
    [(v) => (override.success = v), /\b(?:success|positive)\b[^#\n]{0,40}(#[0-9a-fA-F]{3,6})/i],
    [(v) => (override.warning = v), /\b(?:warning|caution)\b[^#\n]{0,40}(#[0-9a-fA-F]{3,6})/i],
    [(v) => (override.danger = v), /\b(?:danger|error|negative|destructive)\b[^#\n]{0,40}(#[0-9a-fA-F]{3,6})/i],
  ];
  let found = false;
  for (const [set, re] of labelled) {
    const m = re.exec(markdown);
    if (m && m[1] && hexToRgb(m[1])) {
      set(m[1]);
      found = true;
    }
  }
  if (!found) {
    const all = markdown.match(/#[0-9a-fA-F]{6}\b/g);
    if (!all || all.length === 0) return null;
    const distinct = [...new Set(all.map((h) => h.toLowerCase()))];
    if (distinct[0]) override.primary = distinct[0];
    if (distinct[1]) override.secondary = distinct[1];
  }
  // A brand name from the design system's H1, if present.
  const nameMatch = /^#\s+(.+?)(?:\s+[—-].*)?$/m.exec(markdown);
  if (nameMatch && nameMatch[1]) override.brandName = sanitize(nameMatch[1]).trim().slice(0, 60);
  return override;
}

/**
 * Resolve a {@link BrandTokens} palette for a project. Priority (high→low): inline
 * `options.brand` → `options.brandConfigPath` JSON → `<projectPath>/governance/DESIGN_SYSTEM.md`
 * → built-in defaults. Always resolves; sources that are missing/unreadable add a warning and
 * are skipped.
 */
export async function loadBrandTokens(options: PdfOptions = {}): Promise<BrandResolution> {
  const warnings: string[] = [];
  let tokens = defaultTokens();
  let source: BrandResolution['source'] = 'default';

  // Lowest priority that is present wins the base, then inline overrides on top.
  // We layer design-system → config → inline so inline always has the final say.
  if (options.projectPath) {
    const dsPath = join(options.projectPath, 'governance', 'DESIGN_SYSTEM.md');
    const md = await readTextSafe(dsPath);
    if (md === null) {
      warnings.push(`No DESIGN_SYSTEM.md at ${dsPath}; using default branding (unless overridden).`);
    } else {
      const ov = parseDesignSystemColors(md);
      if (ov) {
        tokens = applyOverride(tokens, ov);
        source = 'design-system';
      } else {
        warnings.push('DESIGN_SYSTEM.md contained no parseable hex colors; using default branding.');
      }
    }
  }

  if (options.brandConfigPath) {
    const raw = await readTextSafe(options.brandConfigPath);
    if (raw === null) {
      warnings.push(`Could not read brand config ${options.brandConfigPath}; skipping.`);
    } else {
      try {
        const parsed = JSON.parse(raw) as BrandOverride;
        tokens = applyOverride(tokens, parsed);
        source = 'config';
      } catch (error) {
        warnings.push(`Brand config ${options.brandConfigPath} is not valid JSON (${error instanceof Error ? error.message : String(error)}); skipping.`);
      }
    }
  }

  if (options.brand) {
    tokens = applyOverride(tokens, options.brand);
    source = 'inline';
  }

  return { tokens, source, warnings };
}

// ---------------------------------------------------------------------------
// Markdown → blocks (bounded subset, for governance documents)
// ---------------------------------------------------------------------------

/** Strip a bounded subset of inline markdown to plain text. */
function stripInline(text: string): string {
  return text
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '') // images
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // links → label
    .replace(/`([^`]+)`/g, '$1') // inline code
    .replace(/\*\*([^*]+)\*\*/g, '$1') // bold
    .replace(/(^|[^*])\*([^*]+)\*/g, '$1$2') // italic
    .replace(/__([^_]+)__/g, '$1')
    .trim();
}

/**
 * Convert a bounded subset of Markdown to {@link Block}s: ATX headings (`#`..`###`),
 * unordered lists (`-`/`*`/`+`), GitHub-style tables (`| a | b |`), horizontal rules
 * (`---`), and paragraphs. Anything fancier degrades to plain paragraph text. Best-effort
 * — never throws.
 */
export function markdownToBlocks(markdown: string): Block[] {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let para: string[] = [];
  let bullets: string[] = [];
  let tableRows: string[][] = [];

  const flushPara = (): void => {
    if (para.length > 0) {
      blocks.push({ kind: 'paragraph', text: stripInline(para.join(' ')) });
      para = [];
    }
  };
  const flushBullets = (): void => {
    if (bullets.length > 0) {
      blocks.push({ kind: 'bullets', items: bullets.map(stripInline) });
      bullets = [];
    }
  };
  const flushTable = (): void => {
    if (tableRows.length > 0) {
      const [header, ...rest] = tableRows;
      blocks.push({ kind: 'table', columns: header ?? [], rows: rest });
      tableRows = [];
    }
  };
  const flushAll = (): void => {
    flushPara();
    flushBullets();
    flushTable();
  };

  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+$/, '');
    const trimmed = line.trim();

    if (trimmed === '') {
      flushAll();
      continue;
    }

    // Table row: starts and ends with a pipe (or contains pipes consistently).
    if (/^\s*\|.*\|\s*$/.test(line)) {
      flushPara();
      flushBullets();
      const cells = line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => stripInline(c.trim()));
      // Skip the `|---|---|` separator row.
      if (!cells.every((c) => /^:?-{1,}:?$/.test(c) || c === '')) {
        tableRows.push(cells);
      }
      continue;
    }
    flushTable();

    const heading = /^(#{1,6})\s+(.*)$/.exec(trimmed);
    if (heading) {
      flushAll();
      const level = Math.min(3, heading[1]!.length) as 1 | 2 | 3;
      blocks.push({ kind: 'heading', level, text: stripInline(heading[2] ?? '') });
      continue;
    }

    if (/^---+$|^\*\*\*+$|^___+$/.test(trimmed)) {
      flushAll();
      blocks.push({ kind: 'divider' });
      continue;
    }

    const bullet = /^[-*+]\s+(.*)$/.exec(trimmed);
    if (bullet) {
      flushPara();
      bullets.push(bullet[1] ?? '');
      continue;
    }

    // Numbered list item → treat as a bullet for layout purposes.
    const numbered = /^\d+[.)]\s+(.*)$/.exec(trimmed);
    if (numbered) {
      flushPara();
      bullets.push(numbered[1] ?? '');
      continue;
    }

    flushBullets();
    para.push(trimmed);
  }

  flushAll();
  return blocks;
}

// ---------------------------------------------------------------------------
// Text wrapping (pure, exported for tests)
// ---------------------------------------------------------------------------

/**
 * Greedy word-wrap `text` to `maxWidth`, measuring with `measure(token, …)`. Words longer
 * than `maxWidth` are hard-broken character-by-character. Explicit `\n` forces a break.
 * Returns at least one line (possibly empty).
 */
export function wrapText(
  text: string,
  maxWidth: number,
  measure: (s: string) => number
): string[] {
  const out: string[] = [];
  const paragraphs = text.split('\n');
  for (const paragraph of paragraphs) {
    const words = paragraph.split(/\s+/).filter((w) => w !== '');
    if (words.length === 0) {
      out.push('');
      continue;
    }
    let current = '';
    for (const word of words) {
      const candidate = current === '' ? word : `${current} ${word}`;
      if (measure(candidate) <= maxWidth || current === '') {
        if (measure(candidate) <= maxWidth) {
          current = candidate;
          continue;
        }
        // Single word wider than the line — hard-break it.
        let chunk = '';
        for (const ch of word) {
          const next = chunk + ch;
          if (measure(next) > maxWidth && chunk !== '') {
            out.push(chunk);
            chunk = ch;
          } else {
            chunk = next;
          }
        }
        current = chunk;
      } else {
        out.push(current);
        current = word;
      }
    }
    out.push(current);
  }
  return out.length > 0 ? out : [''];
}

/** Truncate `text` to fit `maxWidth`, appending an ellipsis when clipped. */
function ellipsize(text: string, maxWidth: number, measure: (s: string) => number): string {
  if (measure(text) <= maxWidth) return text;
  const ell = '...';
  let out = '';
  for (const ch of text) {
    if (measure(out + ch + ell) > maxWidth) break;
    out += ch;
  }
  return `${out}${ell}`;
}

// ---------------------------------------------------------------------------
// Layout engine
// ---------------------------------------------------------------------------

interface Fonts {
  regular: PDFFont;
  bold: PDFFont;
  italic: PDFFont;
  boldItalic: PDFFont;
}

interface TocEntry {
  text: string;
  level: 1 | 2;
  page: number; // 1-based final page number, filled during body render
}

/**
 * The internal, stateful layout engine. One instance renders one document. Not exported —
 * callers go through {@link renderPdf}. Drawing helpers maintain a `y` cursor and break
 * pages automatically; header/footer/page-numbers are stamped in {@link finalize}.
 */
class PdfLayout {
  private readonly doc: PDFDocument;
  private readonly fonts: Fonts;
  private readonly tokens: BrandTokens;
  private readonly pageSize: [number, number];
  private readonly margins: Margins;
  private readonly headerText: string;
  private readonly footerText: string;
  private readonly pageNumbers: boolean;
  private readonly contentWidth: number;
  private readonly contentTop: number;
  private readonly contentBottom: number;

  private page!: PDFPage;
  private y = 0;
  private readonly tocEntries: TocEntry[] = [];
  private readonly tocDepth: 1 | 2;
  private readonly wantToc: boolean;
  private tocPages: PDFPage[] = [];

  constructor(doc: PDFDocument, fonts: Fonts, tokens: BrandTokens, spec: PdfDocumentSpec, opts: PdfOptions) {
    this.doc = doc;
    this.fonts = fonts;
    this.tokens = tokens;
    this.pageSize = opts.pageSize ?? (PageSizes.Letter as [number, number]);
    this.margins = {
      top: opts.margins?.top ?? DEFAULT_MARGIN,
      right: opts.margins?.right ?? DEFAULT_MARGIN,
      bottom: opts.margins?.bottom ?? DEFAULT_MARGIN,
      left: opts.margins?.left ?? DEFAULT_MARGIN,
    };
    this.headerText = sanitize(opts.headerText ?? spec.title);
    this.footerText = sanitize(opts.footerText ?? tokens.brandName);
    this.pageNumbers = opts.pageNumbers ?? true;
    this.tocDepth = opts.tocDepth ?? DEFAULT_TOC_DEPTH;
    this.wantToc = opts.tableOfContents ?? false;
    const [w, h] = this.pageSize;
    this.contentWidth = w - this.margins.left - this.margins.right;
    this.contentTop = h - this.margins.top;
    this.contentBottom = this.margins.bottom;
  }

  // --- font metrics ---------------------------------------------------------

  private widthOf(text: string, font: PDFFont, size: number): number {
    try {
      return font.widthOfTextAtSize(text, size);
    } catch {
      // Unencodable glyph slipped through — approximate so layout still progresses.
      return text.length * size * 0.5;
    }
  }

  // --- page management ------------------------------------------------------

  private addRawPage(): PDFPage {
    return this.doc.addPage(this.pageSize);
  }

  private newPage(): void {
    this.page = this.addRawPage();
    this.y = this.contentTop;
  }

  /** Ensure `needed` points of vertical space remain; break to a new page otherwise. */
  private ensure(needed: number): void {
    if (this.y - needed < this.contentBottom) this.newPage();
  }

  private get currentPageNumber(): number {
    // TOC pages are reserved first (front); body pages append after. So the count of pages
    // added so far IS the current page's final 1-based number.
    return this.doc.getPageCount();
  }

  // --- primitive drawing ----------------------------------------------------

  private drawLines(
    lines: string[],
    font: PDFFont,
    size: number,
    color: RGB,
    opts: { x?: number; gap?: number; indent?: number } = {}
  ): void {
    const lineH = size * LEADING;
    const x = (opts.x ?? this.margins.left) + (opts.indent ?? 0);
    for (const line of lines) {
      this.ensure(lineH);
      this.page.drawText(line, { x, y: this.y - size, size, font, color });
      this.y -= lineH;
    }
    if (opts.gap) this.y -= opts.gap;
  }

  private statusColor(level: StatusLevel): RGB {
    switch (level) {
      case 'success':
        return this.tokens.success;
      case 'warning':
        return this.tokens.warning;
      case 'danger':
        return this.tokens.danger;
      case 'info':
        return this.tokens.info;
      case 'neutral':
        return this.tokens.neutral;
      default:
        return this.tokens.neutral;
    }
  }

  /** Draw a filled, colored status badge with its label; returns the badge width. */
  private drawBadge(x: number, baselineY: number, label: string, level: StatusLevel): number {
    const text = sanitize(label).toUpperCase();
    const padX = 5;
    const padY = 3;
    const w = this.widthOf(text, this.fonts.bold, SIZE.badge) + padX * 2;
    const h = SIZE.badge + padY * 2;
    this.page.drawRectangle({
      x,
      y: baselineY - padY,
      width: w,
      height: h,
      color: this.statusColor(level),
    });
    this.page.drawText(text, {
      x: x + padX,
      y: baselineY + padY - 0.5,
      size: SIZE.badge,
      font: this.fonts.bold,
      color: this.tokens.onColor,
    });
    return w;
  }

  // --- block drawing --------------------------------------------------------

  private drawTitleBlock(spec: PdfDocumentSpec): void {
    this.newPage();
    const titleLines = wrapText(sanitize(spec.title), this.contentWidth, (s) =>
      this.widthOf(s, this.fonts.bold, SIZE.title)
    );
    this.drawLines(titleLines, this.fonts.bold, SIZE.title, this.tokens.primary, { gap: 4 });
    if (spec.subtitle) {
      const subLines = wrapText(sanitize(spec.subtitle), this.contentWidth, (s) =>
        this.widthOf(s, this.fonts.regular, SIZE.subtitle)
      );
      this.drawLines(subLines, this.fonts.regular, SIZE.subtitle, this.tokens.muted, { gap: 6 });
    }
    // Accent rule under the title block.
    this.ensure(10);
    this.page.drawRectangle({
      x: this.margins.left,
      y: this.y,
      width: this.contentWidth,
      height: 2,
      color: this.tokens.secondary,
    });
    this.y -= 14;
  }

  private headingSize(level: 1 | 2 | 3): number {
    return level === 1 ? SIZE.h1 : level === 2 ? SIZE.h2 : SIZE.h3;
  }

  private drawHeading(level: 1 | 2 | 3, text: string, toc: boolean): void {
    const size = this.headingSize(level);
    const lineH = size * LEADING;
    // Keep a heading with at least one following line.
    this.ensure(lineH + 6 + SIZE.body * LEADING);
    if (level === 1) this.y -= 6;
    const color = level === 1 ? this.tokens.primary : level === 2 ? this.tokens.secondary : this.tokens.text;
    const lines = wrapText(sanitize(text), this.contentWidth, (s) => this.widthOf(s, this.fonts.bold, size));
    // Record the TOC entry's final page number BEFORE drawing (the line lands on this page).
    if (toc && this.wantToc && level <= this.tocDepth) {
      this.tocEntries.push({ text: sanitize(text), level: level as 1 | 2, page: this.currentPageNumber });
    }
    this.drawLines(lines, this.fonts.bold, size, color, { gap: 4 });
  }

  private drawParagraph(text: string): void {
    const lines = wrapText(sanitize(text), this.contentWidth, (s) => this.widthOf(s, this.fonts.regular, SIZE.body));
    this.drawLines(lines, this.fonts.regular, SIZE.body, this.tokens.text, { gap: 6 });
  }

  private drawBullets(items: string[]): void {
    const bulletIndent = 14;
    const textWidth = this.contentWidth - bulletIndent;
    for (const item of items) {
      const lines = wrapText(sanitize(item), textWidth, (s) => this.widthOf(s, this.fonts.regular, SIZE.body));
      const lineH = SIZE.body * LEADING;
      this.ensure(lineH);
      // Bullet glyph aligned with the first line.
      this.page.drawText('-', {
        x: this.margins.left,
        y: this.y - SIZE.body,
        size: SIZE.body,
        font: this.fonts.bold,
        color: this.tokens.secondary,
      });
      this.drawLines(lines, this.fonts.regular, SIZE.body, this.tokens.text, { indent: bulletIndent });
    }
    this.y -= 6;
  }

  private drawKeyValues(rows: KeyValueRow[]): void {
    const labelWidth = Math.min(180, this.contentWidth * 0.42);
    const valueX = this.margins.left + labelWidth + 8;
    const valueWidth = this.margins.left + this.contentWidth - valueX;
    for (const row of rows) {
      const label = sanitize(row.label);
      const lineH = SIZE.body * LEADING;
      const valueLines = wrapText(sanitize(row.value), valueWidth, (s) =>
        this.widthOf(s, this.fonts.regular, SIZE.body)
      );
      this.ensure(lineH * Math.max(1, valueLines.length));
      const rowTop = this.y;
      // Label (bold, muted).
      this.page.drawText(ellipsize(label, labelWidth, (s) => this.widthOf(s, this.fonts.bold, SIZE.body)), {
        x: this.margins.left,
        y: rowTop - SIZE.body,
        size: SIZE.body,
        font: this.fonts.bold,
        color: this.tokens.muted,
      });
      // Value (optionally a status badge prefix).
      let vx = valueX;
      if (row.status) {
        const badgeW = this.drawBadge(valueX, rowTop - SIZE.body, row.value, row.status);
        vx = valueX + badgeW;
        this.y = rowTop - lineH;
      } else {
        for (let i = 0; i < valueLines.length; i += 1) {
          const ln = valueLines[i] ?? '';
          this.page.drawText(ln, {
            x: vx,
            y: rowTop - SIZE.body - i * lineH,
            size: SIZE.body,
            font: this.fonts.regular,
            color: this.tokens.text,
          });
        }
        this.y = rowTop - lineH * Math.max(1, valueLines.length);
      }
    }
    this.y -= 6;
  }

  private drawStatus(label: string, level: StatusLevel, detail?: string): void {
    const lineH = SIZE.body * LEADING;
    this.ensure(lineH + 4);
    const rowTop = this.y;
    const badgeW = this.drawBadge(this.margins.left, rowTop - SIZE.body, label, level);
    if (detail) {
      const detailX = this.margins.left + badgeW + 8;
      const detailWidth = this.margins.left + this.contentWidth - detailX;
      const line = ellipsize(sanitize(detail), detailWidth, (s) => this.widthOf(s, this.fonts.regular, SIZE.body));
      this.page.drawText(line, {
        x: detailX,
        y: rowTop - SIZE.body,
        size: SIZE.body,
        font: this.fonts.regular,
        color: this.tokens.text,
      });
    }
    this.y = rowTop - lineH - 4;
  }

  private drawTable(columns: string[], rows: string[][]): void {
    const cols = columns.length;
    if (cols === 0) return;
    const colWidth = this.contentWidth / cols;
    const cellPad = 4;
    const lineH = SIZE.small * LEADING;

    const drawRow = (cells: string[], font: PDFFont, bg?: RGB, color?: RGB): void => {
      // Wrap each cell, compute the row height as the tallest cell.
      const wrapped = Array.from({ length: cols }, (_, i) =>
        wrapText(sanitize(cells[i] ?? ''), colWidth - cellPad * 2, (s) => this.widthOf(s, font, SIZE.small))
      );
      const rowLines = wrapped.reduce((m, w) => Math.max(m, w.length), 1);
      const rowH = rowLines * lineH + cellPad;
      this.ensure(rowH);
      const top = this.y;
      if (bg) {
        this.page.drawRectangle({
          x: this.margins.left,
          y: top - rowH,
          width: this.contentWidth,
          height: rowH,
          color: bg,
        });
      }
      for (let c = 0; c < cols; c += 1) {
        const cellLines = wrapped[c] ?? [];
        const cx = this.margins.left + c * colWidth + cellPad;
        for (let i = 0; i < cellLines.length; i += 1) {
          this.page.drawText(cellLines[i] ?? '', {
            x: cx,
            y: top - cellPad - SIZE.small - i * lineH,
            size: SIZE.small,
            font,
            color: color ?? this.tokens.text,
          });
        }
      }
      // Bottom rule.
      this.page.drawLine({
        start: { x: this.margins.left, y: top - rowH },
        end: { x: this.margins.left + this.contentWidth, y: top - rowH },
        thickness: 0.5,
        color: this.tokens.muted,
      });
      this.y = top - rowH;
    };

    drawRow(columns, this.fonts.bold, this.tokens.primary, this.tokens.onColor);
    let striped = false;
    for (const r of rows) {
      drawRow(r, this.fonts.regular, striped ? rgb(0.96, 0.97, 0.98) : undefined);
      striped = !striped;
    }
    this.y -= 8;
  }

  private drawDivider(): void {
    this.ensure(12);
    this.y -= 4;
    this.page.drawLine({
      start: { x: this.margins.left, y: this.y },
      end: { x: this.margins.left + this.contentWidth, y: this.y },
      thickness: 0.75,
      color: this.tokens.muted,
    });
    this.y -= 10;
  }

  private drawBlock(block: Block): void {
    switch (block.kind) {
      case 'heading':
        this.drawHeading(block.level, block.text, block.toc ?? true);
        return;
      case 'paragraph':
        this.drawParagraph(block.text);
        return;
      case 'bullets':
        this.drawBullets(block.items);
        return;
      case 'keyValues':
        this.drawKeyValues(block.rows);
        return;
      case 'status':
        this.drawStatus(block.label, block.status, block.detail);
        return;
      case 'table':
        this.drawTable(block.columns, block.rows);
        return;
      case 'divider':
        this.drawDivider();
        return;
      case 'spacer':
        this.y -= block.size ?? 12;
        return;
      case 'pageBreak':
        this.newPage();
        return;
      default:
        return;
    }
  }

  // --- TOC reservation + rendering -----------------------------------------

  private tocCapacities(): { first: number; rest: number } {
    const avail = this.contentTop - this.contentBottom;
    return {
      first: Math.max(1, Math.floor((avail - TOC_TITLE_BLOCK_H) / TOC_ROW_H)),
      rest: Math.max(1, Math.floor(avail / TOC_ROW_H)),
    };
  }

  /** Deterministic per-page entry counts; used identically for reservation and rendering. */
  private tocPagination(entryCount: number): number[] {
    const cap = this.tocCapacities();
    const pages: number[] = [];
    let remaining = entryCount;
    let first = true;
    do {
      const c = first ? cap.first : cap.rest;
      pages.push(Math.min(c, Math.max(0, remaining)));
      remaining -= c;
      first = false;
    } while (remaining > 0);
    return pages;
  }

  /** Render the document. Returns when all body + TOC + header/footer are drawn. */
  render(spec: PdfDocumentSpec): void {
    // 1) Pre-scan headings to count TOC entries so we can reserve front pages.
    let tocEntryCount = 0;
    if (this.wantToc) {
      for (const b of spec.blocks) {
        if (b.kind === 'heading' && (b.toc ?? true) && b.level <= this.tocDepth) tocEntryCount += 1;
      }
    }
    // 2) Reserve TOC pages at the FRONT (blank for now) so body page numbers are final.
    if (this.wantToc && tocEntryCount > 0) {
      const counts = this.tocPagination(tocEntryCount);
      this.tocPages = counts.map(() => this.addRawPage());
    }
    // 3) Render the body (title block forces its own first page after any TOC pages).
    this.drawTitleBlock(spec);
    for (const block of spec.blocks) this.drawBlock(block);
    // 4) Fill the reserved TOC pages now that every entry's page number is known.
    if (this.tocPages.length > 0) this.renderToc();
    // 5) Stamp header + footer + page numbers across every page.
    this.finalize();
  }

  private renderToc(): void {
    const counts = this.tocPagination(this.tocEntries.length);
    let entryIdx = 0;
    for (let p = 0; p < this.tocPages.length; p += 1) {
      const page = this.tocPages[p];
      if (!page) break;
      let y = this.contentTop;
      if (p === 0) {
        page.drawText('Table of Contents', {
          x: this.margins.left,
          y: y - SIZE.h1,
          size: SIZE.h1,
          font: this.fonts.bold,
          color: this.tokens.primary,
        });
        page.drawRectangle({
          x: this.margins.left,
          y: y - SIZE.h1 - 8,
          width: this.contentWidth,
          height: 1.5,
          color: this.tokens.secondary,
        });
        y -= TOC_TITLE_BLOCK_H;
      }
      const onThisPage = counts[p] ?? 0;
      for (let k = 0; k < onThisPage && entryIdx < this.tocEntries.length; k += 1, entryIdx += 1) {
        const entry = this.tocEntries[entryIdx];
        if (!entry) break;
        const indent = entry.level === 1 ? 0 : 16;
        const font = entry.level === 1 ? this.fonts.bold : this.fonts.regular;
        const color = entry.level === 1 ? this.tokens.text : this.tokens.muted;
        const pageLabel = String(entry.page);
        const pageW = this.widthOf(pageLabel, font, SIZE.body);
        const titleX = this.margins.left + indent;
        const titleMax = this.contentWidth - indent - pageW - 12;
        const title = ellipsize(entry.text, titleMax, (s) => this.widthOf(s, font, SIZE.body));
        page.drawText(title, { x: titleX, y: y - SIZE.body, size: SIZE.body, font, color });
        page.drawText(pageLabel, {
          x: this.margins.left + this.contentWidth - pageW,
          y: y - SIZE.body,
          size: SIZE.body,
          font,
          color,
        });
        y -= TOC_ROW_H;
      }
    }
  }

  private finalize(): void {
    const pages = this.doc.getPages();
    const total = pages.length;
    const [pw] = this.pageSize;
    pages.forEach((page, i) => {
      const pageNum = i + 1;
      // Header: brand/title text + a hairline rule.
      const headerY = this.pageSize[1] - this.margins.top * 0.55;
      if (this.headerText) {
        const ht = ellipsize(this.headerText, this.contentWidth, (s) =>
          this.widthOf(s, this.fonts.regular, SIZE.footer)
        );
        page.drawText(ht, {
          x: this.margins.left,
          y: headerY,
          size: SIZE.footer,
          font: this.fonts.regular,
          color: this.tokens.muted,
        });
      }
      page.drawLine({
        start: { x: this.margins.left, y: headerY - 4 },
        end: { x: pw - this.margins.right, y: headerY - 4 },
        thickness: 0.5,
        color: this.tokens.muted,
      });
      // Footer: footer text (left) + page number (right) + a hairline rule above.
      const footerY = this.margins.bottom * 0.5;
      page.drawLine({
        start: { x: this.margins.left, y: footerY + SIZE.footer + 4 },
        end: { x: pw - this.margins.right, y: footerY + SIZE.footer + 4 },
        thickness: 0.5,
        color: this.tokens.muted,
      });
      if (this.footerText) {
        page.drawText(
          ellipsize(this.footerText, this.contentWidth * 0.6, (s) => this.widthOf(s, this.fonts.regular, SIZE.footer)),
          { x: this.margins.left, y: footerY, size: SIZE.footer, font: this.fonts.regular, color: this.tokens.muted }
        );
      }
      if (this.pageNumbers) {
        const label = `Page ${pageNum} of ${total}`;
        const w = this.widthOf(label, this.fonts.regular, SIZE.footer);
        page.drawText(label, {
          x: pw - this.margins.right - w,
          y: footerY,
          size: SIZE.footer,
          font: this.fonts.regular,
          color: this.tokens.muted,
        });
      }
    });
  }
}

// ---------------------------------------------------------------------------
// renderPdf — the public entry point over a PdfDocumentSpec
// ---------------------------------------------------------------------------

/**
 * Render a {@link PdfDocumentSpec} to PDF bytes (and optionally write them to
 * `options.outputPath`). Resolves branding via {@link loadBrandTokens}, lays out every block
 * with automatic wrapping + page breaks, optionally prepends a table of contents, and stamps
 * a header + footer with page numbers on every page.
 *
 * NEVER throws: a guarded failure returns empty `bytes` plus a `warnings` entry. Use the
 * higher-level `generate*Pdf` builders for FORGE's standard document types.
 */
export async function renderPdf(spec: PdfDocumentSpec, options: PdfOptions = {}): Promise<PdfResult> {
  const log = options.log ?? defaultLog;
  const generatedAt = nowIso();
  const { tokens, source, warnings } = await loadBrandTokens(options);
  log(`rendering "${spec.title}" (brand: ${tokens.brandName} via ${source}, ${spec.blocks.length} blocks)`);

  const base: PdfResult = { bytes: new Uint8Array(), pageCount: 0, outputPath: null, warnings, generatedAt };

  let doc: PDFDocument;
  try {
    doc = await PDFDocument.create();
  } catch (error) {
    warnings.push(`Failed to create the PDF document: ${error instanceof Error ? error.message : String(error)}.`);
    return base;
  }

  // Document metadata.
  try {
    doc.setTitle(sanitize(spec.title));
    doc.setProducer('FORGE 2.0 pdf-generator');
    doc.setCreator(tokens.brandName);
    if (spec.meta?.author) doc.setAuthor(sanitize(spec.meta.author));
    if (spec.meta?.subject) doc.setSubject(sanitize(spec.meta.subject));
  } catch {
    /* metadata is cosmetic; never fatal */
  }

  // Embed the Standard-14 font family for the chosen brand typeface.
  let fonts: Fonts;
  try {
    const [reg, bold, ital, boldItal] = FONT_SET[tokens.fontFamily];
    fonts = {
      regular: await doc.embedFont(reg),
      bold: await doc.embedFont(bold),
      italic: await doc.embedFont(ital),
      boldItalic: await doc.embedFont(boldItal),
    };
  } catch (error) {
    warnings.push(`Failed to embed fonts: ${error instanceof Error ? error.message : String(error)}.`);
    return base;
  }

  try {
    new PdfLayout(doc, fonts, tokens, spec, options).render(spec);
  } catch (error) {
    warnings.push(`Layout failed: ${error instanceof Error ? error.message : String(error)}.`);
    return base;
  }

  let bytes: Uint8Array;
  try {
    bytes = await doc.save();
  } catch (error) {
    warnings.push(`Failed to serialize the PDF: ${error instanceof Error ? error.message : String(error)}.`);
    return base;
  }

  const pageCount = doc.getPageCount();
  let outputPath: string | null = null;
  if (options.outputPath && options.write !== false) {
    try {
      await mkdir(dirname(options.outputPath), { recursive: true });
      await writeFile(options.outputPath, bytes);
      outputPath = options.outputPath;
      log(`wrote ${options.outputPath} (${bytes.length} bytes, ${pageCount} pages)`);
    } catch (error) {
      warnings.push(`Failed to write ${options.outputPath}: ${error instanceof Error ? error.message : String(error)}.`);
    }
  }

  return { bytes, pageCount, outputPath, warnings, generatedAt };
}

// ---------------------------------------------------------------------------
// Builder: FORGE build report
// ---------------------------------------------------------------------------

/** Result of one quality gate, for the build report. */
export interface GateResult {
  name: string;
  passed: boolean;
  detail?: string;
}

/** A per-prompt roll-up line for the build report. */
export interface PromptRollup {
  index: number;
  name: string;
  status: string;
}

/** The subset of a {@link BuildRun} the report renders (kept structural for tolerance). */
export type BuildReportBuild = Pick<
  BuildRun,
  | 'project_name'
  | 'status'
  | 'started_at'
  | 'completed_at'
  | 'total_prompts'
  | 'completed_prompts'
  | 'failed_prompts'
  | 'total_errors'
  | 'total_tokens'
  | 'total_cost_usd'
  | 'machine_id'
> & { id?: string };

/** Input to {@link buildBuildReportSpec} / {@link generateBuildReportPdf}. */
export interface BuildReportData {
  build: BuildReportBuild;
  gates?: GateResult[];
  prompts?: PromptRollup[];
  notes?: string;
}

/** Build a {@link PdfDocumentSpec} for a FORGE build report (colored status indicators). */
export function buildBuildReportSpec(data: BuildReportData): PdfDocumentSpec {
  const b = data.build;
  const blocks: Block[] = [];

  blocks.push({ kind: 'heading', level: 1, text: 'Build Summary' });
  blocks.push({
    kind: 'status',
    label: b.status,
    status: BUILD_STATUS_LEVEL[b.status] ?? 'neutral',
    detail: b.id ? `Build ${b.id}` : undefined,
  });
  blocks.push({
    kind: 'keyValues',
    rows: [
      { label: 'Project', value: b.project_name },
      { label: 'Machine', value: b.machine_id },
      { label: 'Started', value: b.started_at ?? '—' },
      { label: 'Completed', value: b.completed_at ?? '—' },
      { label: 'Prompts', value: `${b.completed_prompts}/${b.total_prompts} completed, ${b.failed_prompts} failed` },
      { label: 'Errors', value: String(b.total_errors), status: b.total_errors > 0 ? 'warning' : 'success' },
      { label: 'Tokens', value: b.total_tokens.toLocaleString('en-US') },
      { label: 'Cost', value: `$${Number(b.total_cost_usd).toFixed(4)}` },
    ],
  });

  if (data.gates && data.gates.length > 0) {
    blocks.push({ kind: 'heading', level: 1, text: 'Quality Gates' });
    for (const gate of data.gates) {
      blocks.push({
        kind: 'status',
        label: gate.passed ? 'PASS' : 'FAIL',
        status: gate.passed ? 'success' : 'danger',
        detail: gate.detail ? `${gate.name} — ${gate.detail}` : gate.name,
      });
    }
  }

  if (data.prompts && data.prompts.length > 0) {
    blocks.push({ kind: 'heading', level: 1, text: 'Prompt Execution' });
    blocks.push({
      kind: 'table',
      columns: ['#', 'Prompt', 'Status'],
      rows: data.prompts.map((p) => [String(p.index), p.name, p.status]),
    });
  }

  if (data.notes && data.notes.trim() !== '') {
    blocks.push({ kind: 'heading', level: 1, text: 'Notes' });
    blocks.push({ kind: 'paragraph', text: data.notes });
  }

  return {
    title: `FORGE Build Report — ${b.project_name}`,
    subtitle: `Status: ${b.status.toUpperCase()} · Generated ${nowIso()}`,
    blocks,
    meta: { subject: 'FORGE 2.0 autonomous build report', author: 'FORGE 2.0' },
  };
}

/** Render a FORGE build report PDF. */
export function generateBuildReportPdf(data: BuildReportData, options: PdfOptions = {}): Promise<PdfResult> {
  return renderPdf(buildBuildReportSpec(data), { tableOfContents: true, ...options });
}

// ---------------------------------------------------------------------------
// Builder: governance document → PDF
// ---------------------------------------------------------------------------

/**
 * Render a governance markdown document (BLUEPRINT / PRD / SCHEMA_REGISTRY / …) to PDF. The
 * document title defaults to the first H1, else `documentName`. A table of contents is
 * generated from the headings by default.
 */
export function generateGovernancePdf(
  documentName: string,
  markdown: string,
  options: PdfOptions = {}
): Promise<PdfResult> {
  const blocks = markdownToBlocks(markdown);
  // Prefer the first H1 as the title, and drop it from the body to avoid duplication.
  let title = documentName;
  const firstHeadingIdx = blocks.findIndex((b) => b.kind === 'heading');
  const firstHeading = firstHeadingIdx >= 0 ? blocks[firstHeadingIdx] : undefined;
  if (firstHeading && firstHeading.kind === 'heading' && firstHeading.level === 1) {
    title = firstHeading.text;
    blocks.splice(firstHeadingIdx, 1);
  }
  return renderPdf(
    {
      title,
      subtitle: `Governance Document · ${documentName}`,
      blocks,
      meta: { subject: 'FORGE 2.0 governance document', author: 'FORGE 2.0' },
    },
    { tableOfContents: true, ...options }
  );
}

// ---------------------------------------------------------------------------
// Builder: grant narrative (submission-ready)
// ---------------------------------------------------------------------------

/** One section of a grant narrative (e.g. "Statement of Need"). */
export interface GrantSection {
  heading: string;
  body: string;
}

/** Input to {@link buildGrantNarrativeSpec} / {@link generateGrantNarrativePdf}. */
export interface GrantNarrativeData {
  organization: string;
  projectTitle: string;
  funder?: string;
  amountRequested?: string;
  submissionDate?: string;
  contact?: { name?: string; email?: string; phone?: string };
  sections: GrantSection[];
}

/** Build a submission-ready grant narrative spec. */
export function buildGrantNarrativeSpec(data: GrantNarrativeData): PdfDocumentSpec {
  const blocks: Block[] = [];
  const cover: KeyValueRow[] = [{ label: 'Organization', value: data.organization }];
  if (data.funder) cover.push({ label: 'Funder', value: data.funder });
  if (data.amountRequested) cover.push({ label: 'Amount Requested', value: data.amountRequested });
  if (data.submissionDate) cover.push({ label: 'Submission Date', value: data.submissionDate });
  if (data.contact?.name) cover.push({ label: 'Contact', value: data.contact.name });
  if (data.contact?.email) cover.push({ label: 'Email', value: data.contact.email });
  if (data.contact?.phone) cover.push({ label: 'Phone', value: data.contact.phone });
  blocks.push({ kind: 'keyValues', rows: cover });
  blocks.push({ kind: 'divider' });

  for (const section of data.sections) {
    blocks.push({ kind: 'heading', level: 1, text: section.heading });
    blocks.push({ kind: 'paragraph', text: section.body });
  }

  return {
    title: data.projectTitle,
    subtitle: `Grant Narrative · ${data.organization}`,
    blocks,
    meta: { subject: `Grant proposal to ${data.funder ?? 'funder'}`, author: data.organization },
  };
}

/**
 * Render a submission-ready grant narrative PDF: 1-inch margins, a table of contents, a
 * running header, and "Page X of N" footers (overridable via `options`).
 */
export function generateGrantNarrativePdf(data: GrantNarrativeData, options: PdfOptions = {}): Promise<PdfResult> {
  return renderPdf(buildGrantNarrativeSpec(data), {
    tableOfContents: true,
    margins: { top: 72, right: 72, bottom: 72, left: 72 },
    headerText: `${data.organization} — ${data.projectTitle}`,
    ...options,
  });
}

// ---------------------------------------------------------------------------
// Builder: board report (embedded data)
// ---------------------------------------------------------------------------

/** A board metric row (label/value with an optional status indicator). */
export interface BoardMetric {
  label: string;
  value: string;
  status?: StatusLevel;
}

/** A board narrative section (body and/or bullets). */
export interface BoardSection {
  heading: string;
  body?: string;
  bullets?: string[];
}

/** Input to {@link buildBoardReportSpec} / {@link generateBoardReportPdf}. */
export interface BoardReportData {
  organization: string;
  period: string;
  preparedBy?: string;
  metrics?: BoardMetric[];
  sections?: BoardSection[];
}

/** Build a board report spec with an embedded metrics dashboard. */
export function buildBoardReportSpec(data: BoardReportData): PdfDocumentSpec {
  const blocks: Block[] = [];
  const meta: KeyValueRow[] = [{ label: 'Reporting Period', value: data.period }];
  if (data.preparedBy) meta.push({ label: 'Prepared By', value: data.preparedBy });
  blocks.push({ kind: 'keyValues', rows: meta });

  if (data.metrics && data.metrics.length > 0) {
    blocks.push({ kind: 'heading', level: 1, text: 'Key Metrics' });
    blocks.push({
      kind: 'keyValues',
      rows: data.metrics.map((m) => ({ label: m.label, value: m.value, status: m.status })),
    });
  }

  for (const section of data.sections ?? []) {
    blocks.push({ kind: 'heading', level: 1, text: section.heading });
    if (section.body) blocks.push({ kind: 'paragraph', text: section.body });
    if (section.bullets && section.bullets.length > 0) blocks.push({ kind: 'bullets', items: section.bullets });
  }

  return {
    title: `Board Report — ${data.organization}`,
    subtitle: `${data.period}`,
    blocks,
    meta: { subject: 'Board report', author: data.organization },
  };
}

/** Render a board report PDF (table of contents on by default). */
export function generateBoardReportPdf(data: BoardReportData, options: PdfOptions = {}): Promise<PdfResult> {
  return renderPdf(buildBoardReportSpec(data), { tableOfContents: true, ...options });
}

// ---------------------------------------------------------------------------
// Builder: audit report
// ---------------------------------------------------------------------------

/** A single audit finding with a severity level. */
export interface AuditFinding {
  id?: string;
  title: string;
  severity: StatusLevel;
  detail?: string;
  recommendation?: string;
}

/** Input to {@link buildAuditReportSpec} / {@link generateAuditReportPdf}. */
export interface AuditReportData {
  subject: string;
  auditor?: string;
  date?: string;
  scope?: string;
  summary?: string;
  findings: AuditFinding[];
}

/** Order findings most-severe first for the report. */
const SEVERITY_RANK: Record<StatusLevel, number> = { danger: 0, warning: 1, info: 2, neutral: 3, success: 4 };

/** Build an audit report spec (findings sorted by severity, each with a badge). */
export function buildAuditReportSpec(data: AuditReportData): PdfDocumentSpec {
  const blocks: Block[] = [];
  const meta: KeyValueRow[] = [{ label: 'Subject', value: data.subject }];
  if (data.auditor) meta.push({ label: 'Auditor', value: data.auditor });
  if (data.date) meta.push({ label: 'Date', value: data.date });
  if (data.scope) meta.push({ label: 'Scope', value: data.scope });
  blocks.push({ kind: 'keyValues', rows: meta });

  // Severity tally.
  const tally: Record<StatusLevel, number> = { danger: 0, warning: 0, info: 0, neutral: 0, success: 0 };
  for (const f of data.findings) tally[f.severity] += 1;
  blocks.push({ kind: 'heading', level: 1, text: 'Summary' });
  if (data.summary) blocks.push({ kind: 'paragraph', text: data.summary });
  blocks.push({
    kind: 'keyValues',
    rows: [
      { label: 'Critical', value: String(tally.danger), status: tally.danger > 0 ? 'danger' : 'success' },
      { label: 'Warning', value: String(tally.warning), status: tally.warning > 0 ? 'warning' : 'success' },
      { label: 'Informational', value: String(tally.info), status: 'info' },
      { label: 'Total Findings', value: String(data.findings.length) },
    ],
  });

  blocks.push({ kind: 'heading', level: 1, text: 'Findings' });
  const sorted = [...data.findings].sort((a, c) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[c.severity]);
  sorted.forEach((f, i) => {
    const heading = f.id ? `${f.id}: ${f.title}` : `${i + 1}. ${f.title}`;
    blocks.push({ kind: 'heading', level: 2, text: heading });
    blocks.push({ kind: 'status', label: f.severity, status: f.severity, detail: f.detail });
    if (f.recommendation) blocks.push({ kind: 'paragraph', text: `Recommendation: ${f.recommendation}` });
  });

  return {
    title: `Audit Report — ${data.subject}`,
    subtitle: data.date ? `As of ${data.date}` : undefined,
    blocks,
    meta: { subject: 'Audit report', author: data.auditor ?? 'FORGE 2.0' },
  };
}

/** Render an audit report PDF (table of contents on by default). */
export function generateAuditReportPdf(data: AuditReportData, options: PdfOptions = {}): Promise<PdfResult> {
  return renderPdf(buildAuditReportSpec(data), { tableOfContents: true, ...options });
}

export default renderPdf;
