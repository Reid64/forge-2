/**
 * FORGE 2.0 — Visual Regression tool (`src/tools/visual-regression.ts`).
 *
 * After every UI prompt execution, drive Playwright to SCREENSHOT every route of the built target
 * app and pixel-diff each capture against a stored BASELINE. Any page whose pixel difference exceeds
 * the threshold (default 5%) is flagged as a UI regression. This is the visual counterpart to the
 * Six Laws UI law — Law 3 proves a page *renders the right elements*; this proves a page *still looks
 * the same* as the last known-good capture, catching unintended layout/style drift a DOM check misses.
 *
 * LIFECYCLE (per the task contract):
 *   - Baselines live in `<projectPath>/.forge/baselines/<route-slug>.png`.
 *   - FIRST RUN for a route (no baseline on disk) → CAPTURE the baseline and report `baseline_created`
 *     (not a failure — there is nothing to compare against yet).
 *   - SUBSEQUENT RUNS → screenshot, decode both PNGs, pixel-diff, and compare the differing-pixel
 *     PERCENTAGE to `thresholdPercent`. `> threshold` ⇒ `fail` (regression); else `pass`.
 *   - A `<route-slug>.diff.png` (the differing pixels painted red over a dimmed baseline) and a
 *     `<route-slug>.current.png` are written under `<projectPath>/.forge/diffs/` for the operator.
 *   - `updateBaselines:true` force-recaptures every baseline (the "accept the new look" path).
 *
 * OUTPUT: a {@link VisualRegressionResult} `{ passed, firstRun, pages: PageVisualResult[], … }` where
 * each {@link PageVisualResult} carries per-page `status`, `diffPercentage`, and `diffImagePath`.
 * `passed` is false iff at least one page is a `fail` (a regression).
 *
 * ZERO NEW DEPENDENCY (BLUEPRINT TECH STACK is locked / Phase 4 flags un-manifested deps): the PNG
 * decode/encode and the pixel comparison are implemented HERE on top of Node's built-in `node:zlib`
 * (no `pngjs`, no `pixelmatch`). The decoder supports the 8-bit, non-interlaced PNGs Chromium emits
 * (colour types 0/2/4/6); the comparator ports pixelmatch's well-known YIQ perceptual colour-delta so
 * anti-aliasing/compression noise does not false-flag. Both are exported as pure helpers for testing.
 *
 * HOUSE STYLE (matches `schema-extractor`, `six-laws-verifier`, `phase4-sentinel`): NON-FATAL and
 * never throws. A precondition that cannot be evaluated — Playwright unavailable, the app not running,
 * a route that won't load, a baseline that won't decode — is reported as `skipped`/`error` on that
 * page with a note, NEVER a fabricated pass and NEVER a false regression (Iron Law 3). Every external
 * collaborator (the browser driver and the filesystem) is injectable, so the tool and its pure
 * helpers unit-test with no browser and no disk.
 *
 * BOUNDARY (Iron Law 1): writes ONLY inside `<projectPath>/.forge/` (baselines + diffs). It reads the
 * running app's rendered pixels — never its source, never a governance file, never a secret.
 */

import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { isAbsolute, dirname } from 'node:path';
import zlib from 'node:zlib';

import { nowIso } from '../memory/index.js';
import { logLine } from './forge-logger.js';

/**
 * Joins path segments with `/`, regardless of platform. `node:path`'s `join` uses the platform
 * separator, which on Windows turns a POSIX-style `projectPath` (e.g. one normalized elsewhere in
 * the codebase, or supplied from a WSL/git-bash context) into a backslash path — silently
 * mismatching every other consumer of these baseline/diff paths that expects `/`. Real Windows
 * filesystem APIs (and Node's `fs`) accept `/` interchangeably with `\`, so this is safe for
 * `defaultFs`'s real reads/writes too.
 */
function posixJoin(...parts: string[]): string {
  return parts
    .map((p, i) => (i === 0 ? p.replace(/\/+$/, '') : p.replace(/^\/+|\/+$/g, '')))
    .filter((p) => p !== '')
    .join('/');
}

// ---------------------------------------------------------------------------
// Public contract — what to verify
// ---------------------------------------------------------------------------

/** A single route to screenshot + diff. */
export interface VisualRouteSpec {
  /** Route path, e.g. `/dashboard` (joined onto `baseUrl`). */
  path: string;
  /** Friendly name (for the report). */
  name?: string;
  /** Capture the full scrollable page (default) or just the viewport. */
  fullPage?: boolean;
}

/** What to check — the running target app + its routes. */
export interface VisualRegressionInput {
  /** Target project root. Baselines/diffs are written under `<projectPath>/.forge/`. Default cwd. */
  projectPath?: string;
  /** Running app base URL. Default `http://localhost:3000`. */
  baseUrl?: string;
  /** Routes to screenshot. When empty, the run is a no-op (`pages: []`). */
  pages: VisualRouteSpec[];
  /** Baseline directory (absolute, or relative to `projectPath`). Default `.forge/baselines`. */
  baselineDir?: string;
  /** Diff/current-capture directory (absolute, or relative to `projectPath`). Default `.forge/diffs`. */
  diffDir?: string;
  /** Regression threshold as a PERCENTAGE of differing pixels. Default 5 (i.e. >5% ⇒ regression). */
  thresholdPercent?: number;
  /** Per-pixel YIQ colour tolerance in [0,1] (pixelmatch semantics). Default 0.1. Higher = laxer. */
  pixelMatchThreshold?: number;
  /** Capture full page by default (per-route `fullPage` overrides). Default true. */
  fullPage?: boolean;
  /** Force re-capture of every baseline ("accept the new look"). Default false. */
  updateBaselines?: boolean;
  /** Per-navigation timeout (ms). Default 15000. */
  navTimeoutMs?: number;
}

// ---------------------------------------------------------------------------
// Public contract — results
// ---------------------------------------------------------------------------

/** Per-page outcome. */
export type PageVisualStatus =
  | 'baseline_created' // no prior baseline — captured it this run (not a failure)
  | 'pass' //            diff ≤ threshold
  | 'fail' //            diff > threshold — a UI regression
  | 'error' //           captured but could not decode/compare (neither pass nor fail)
  | 'skipped'; //        could not capture (app unreachable / browser unavailable)

/** The result for one route. */
export interface PageVisualResult {
  path: string;
  name?: string;
  status: PageVisualStatus;
  /** True for `pass` and `baseline_created`; false otherwise. */
  passed: boolean;
  /** Differing-pixel percentage (0–100). `-1` when not computed (skip/error/first run). */
  diffPercentage: number;
  /** Absolute path of the baseline PNG for this route. */
  baselinePath: string;
  /** Absolute path of the current capture written for inspection, or null. */
  currentPath: string | null;
  /** Absolute path of the rendered diff image, or null. */
  diffImagePath: string | null;
  /** Decoded image width/height (of the compared images), or null. */
  width: number | null;
  height: number | null;
  /** Number of differing pixels, or 0. */
  diffPixels: number;
  /** Total pixels compared, or 0. */
  totalPixels: number;
  /** One-line human-readable detail. */
  detail: string;
}

/** The full visual-regression result (the tool's output contract). */
export interface VisualRegressionResult {
  /** False iff at least one page is a `fail` (a regression). Errors/skips do not fail the run. */
  passed: boolean;
  /** True when this run only CAPTURED baselines (nothing was compared). */
  firstRun: boolean;
  /** Whether a browser driver was available at all (false ⇒ every page skipped). */
  driverAvailable: boolean;
  /** Routes that exceeded the threshold (subset of `pages`). */
  regressions: PageVisualResult[];
  pages: PageVisualResult[];
  /** Count of baselines newly captured this run. */
  capturedBaselines: number;
  /** Count of pages actually compared against a baseline. */
  comparedPages: number;
  /** Count of routes that could not be captured (app unreachable / browser down). */
  unreachablePages: number;
  /** Count of routes captured but not decodable/comparable. */
  errorPages: number;
  /** Threshold used (percent). */
  thresholdPercent: number;
  baselineDir: string;
  diffDir: string;
  baseUrl: string;
  /** Full markdown report. */
  report: string;
  generatedAt: string;
}

// ---------------------------------------------------------------------------
// Public contract — injectable collaborators
// ---------------------------------------------------------------------------

/** A request to screenshot one URL. */
export interface ScreenshotRequest {
  url: string;
  fullPage: boolean;
  timeoutMs: number;
}

/** The outcome of one screenshot. */
export interface ScreenshotResult {
  /** True when the page navigated to a non-error status and a PNG was captured. */
  ok: boolean;
  /** HTTP status of the navigation, or null. */
  status: number | null;
  /** The PNG bytes, or null when capture failed. */
  png: Buffer | null;
  /** URL after redirects. */
  finalUrl: string;
  /** Set when the navigation/capture itself failed (unreachable, timeout, …). */
  error: string | null;
}

/** A screenshot driver. The default is Playwright/Chromium; tests inject a fake. */
export interface ScreenshotDriver {
  screenshot(req: ScreenshotRequest): Promise<ScreenshotResult>;
  close(): Promise<void>;
}

/** Minimal filesystem seam (injectable for tests). */
export interface VisualFs {
  readFile(path: string): Promise<Buffer | null>;
  writeFile(path: string, data: Buffer): Promise<boolean>;
  exists(path: string): Promise<boolean>;
}

/** Options — injectable collaborators + tuning (none required). */
export interface VisualRegressionOptions {
  /** Inject a ready screenshot driver. Default: a lazily-created Playwright driver. */
  driver?: ScreenshotDriver;
  /** Override how the default driver is created (tests). Returns null when unavailable. */
  createDriver?: (opts: { headless: boolean; viewport: { width: number; height: number }; log: (m: string) => void }) => Promise<ScreenshotDriver | null>;
  /** Run the browser headless. Default true. */
  headless?: boolean;
  /** Deterministic viewport for capture. Default 1280×800. */
  viewport?: { width: number; height: number };
  /** Override the filesystem (tests). Default: a guarded `node:fs/promises` wrapper. */
  fs?: VisualFs;
  /** Override the timestamp source (tests). Default: `nowIso`. */
  now?: () => string;
  /** Progress reporter. Default logs with a `[FORGE:visreg]` prefix. */
  log?: (message: string) => void;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_BASE_URL = 'http://localhost:3000';
const DEFAULT_THRESHOLD_PERCENT = 5;
const DEFAULT_PIXEL_THRESHOLD = 0.1;
const DEFAULT_NAV_TIMEOUT_MS = 15_000;
const DEFAULT_VIEWPORT = { width: 1280, height: 800 } as const;
/** pixelmatch's "max YIQ delta" constant — `35215 * t²` is the per-pixel difference cutoff. */
const MAX_YIQ_DELTA = 35215;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Render an unknown thrown value as a short string. */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Join a base URL and a path, tolerating leading/trailing slashes. */
function joinUrl(baseUrl: string, path: string): string {
  const b = baseUrl.replace(/\/+$/, '');
  const p = path.startsWith('/') ? path : `/${path}`;
  return `${b}${p}`;
}

/** Turn a route path into a filesystem-safe slug (`/dashboard/users` → `dashboard-users`). */
export function routeSlug(path: string): string {
  const noQuery = path.split('#')[0]?.split('?')[0] ?? path;
  const slug = noQuery
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug === '' ? 'root' : slug;
}

/** Resolve a directory option (absolute kept; relative joined onto projectPath; default fallback). */
function resolveDir(dir: string | undefined, projectPath: string, fallback: string[]): string {
  if (dir && dir.trim() !== '') return isAbsolute(dir) ? dir : posixJoin(projectPath, dir);
  return posixJoin(projectPath, ...fallback);
}

/** Default filesystem seam — guarded, never throws. */
const defaultFs: VisualFs = {
  async readFile(path) {
    try {
      return await readFile(path);
    } catch {
      return null;
    }
  },
  async writeFile(path, data) {
    try {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, data);
      return true;
    } catch {
      return false;
    }
  },
  async exists(path) {
    try {
      await access(path);
      return true;
    } catch {
      return false;
    }
  },
};

// ---------------------------------------------------------------------------
// PNG codec (self-contained, on node:zlib) — pure, exported for testing
// ---------------------------------------------------------------------------

/** A decoded raster image: width × height, RGBA, 8-bit, row-major. */
export interface DecodedImage {
  width: number;
  height: number;
  /** `width * height * 4` bytes, RGBA. */
  data: Uint8Array;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Channels per pixel for a PNG colour type (0 grey, 2 RGB, 3 palette, 4 grey+α, 6 RGBA). */
function channelsForColorType(colorType: number): number {
  switch (colorType) {
    case 0:
      return 1;
    case 2:
      return 3;
    case 3:
      return 1; // palette index (expanded via PLTE)
    case 4:
      return 2;
    case 6:
      return 4;
    default:
      return 0;
  }
}

/** Paeth predictor (PNG filter type 4). */
function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/**
 * Decode a PNG buffer into a {@link DecodedImage} (8-bit, non-interlaced, colour types 0/2/3/4/6 —
 * the range Chromium emits). Throws on an unsupported/corrupt PNG; callers guard and report `error`.
 */
export function decodePng(buffer: Buffer): DecodedImage {
  if (buffer.length < 8 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error('not a PNG (bad signature)');
  }

  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  let palette: Buffer | null = null;
  let trns: Buffer | null = null;
  const idat: Buffer[] = [];

  let offset = 8;
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd > buffer.length) throw new Error(`truncated PNG chunk '${type}'`);
    const data = buffer.subarray(dataStart, dataEnd);

    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data.readUInt8(8);
      colorType = data.readUInt8(9);
      interlace = data.readUInt8(12);
    } else if (type === 'PLTE') {
      palette = Buffer.from(data);
    } else if (type === 'tRNS') {
      trns = Buffer.from(data);
    } else if (type === 'IDAT') {
      idat.push(Buffer.from(data));
    } else if (type === 'IEND') {
      break;
    }
    offset = dataEnd + 4; // skip the 4-byte CRC
  }

  if (width <= 0 || height <= 0) throw new Error('PNG has no dimensions (missing IHDR)');
  if (bitDepth !== 8) throw new Error(`unsupported PNG bit depth ${bitDepth} (only 8 supported)`);
  if (interlace !== 0) throw new Error('unsupported interlaced PNG');
  const channels = channelsForColorType(colorType);
  if (channels === 0) throw new Error(`unsupported PNG colour type ${colorType}`);
  if (colorType === 3 && !palette) throw new Error('palette PNG missing PLTE chunk');

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const bytesPerPixel = channels; // 8-bit ⇒ 1 byte/channel
  const stride = width * bytesPerPixel;
  const expected = (stride + 1) * height;
  if (raw.length < expected) throw new Error(`PNG data underflow (${raw.length} < ${expected})`);

  // Unfilter each scanline in place into `unfiltered` (width*height*channels).
  const unfiltered = new Uint8Array(stride * height);
  let prevRow: Uint8Array | null = null;
  let pos = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[pos] ?? 0;
    pos += 1;
    const row = unfiltered.subarray(y * stride, y * stride + stride);
    for (let x = 0; x < stride; x++) {
      const rawByte = raw[pos + x] ?? 0;
      const left = x >= bytesPerPixel ? (row[x - bytesPerPixel] ?? 0) : 0;
      const up = prevRow ? (prevRow[x] ?? 0) : 0;
      const upLeft = prevRow && x >= bytesPerPixel ? (prevRow[x - bytesPerPixel] ?? 0) : 0;
      let value: number;
      switch (filter) {
        case 0:
          value = rawByte;
          break;
        case 1:
          value = rawByte + left;
          break;
        case 2:
          value = rawByte + up;
          break;
        case 3:
          value = rawByte + ((left + up) >> 1);
          break;
        case 4:
          value = rawByte + paeth(left, up, upLeft);
          break;
        default:
          throw new Error(`unsupported PNG filter ${filter}`);
      }
      row[x] = value & 0xff;
    }
    prevRow = row;
    pos += stride;
  }

  // Expand to RGBA.
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const src = i * channels;
    const dst = i * 4;
    let r: number;
    let g: number;
    let b: number;
    let a = 255;
    if (colorType === 0) {
      r = g = b = unfiltered[src] ?? 0;
    } else if (colorType === 4) {
      r = g = b = unfiltered[src] ?? 0;
      a = unfiltered[src + 1] ?? 255;
    } else if (colorType === 2) {
      r = unfiltered[src] ?? 0;
      g = unfiltered[src + 1] ?? 0;
      b = unfiltered[src + 2] ?? 0;
    } else if (colorType === 6) {
      r = unfiltered[src] ?? 0;
      g = unfiltered[src + 1] ?? 0;
      b = unfiltered[src + 2] ?? 0;
      a = unfiltered[src + 3] ?? 255;
    } else {
      // Palette (colour type 3).
      const idx = (unfiltered[src] ?? 0) * 3;
      const pal = palette as Buffer;
      r = pal[idx] ?? 0;
      g = pal[idx + 1] ?? 0;
      b = pal[idx + 2] ?? 0;
      a = trns ? (trns[unfiltered[src] ?? 0] ?? 255) : 255;
    }
    rgba[dst] = r;
    rgba[dst + 1] = g;
    rgba[dst + 2] = b;
    rgba[dst + 3] = a;
  }

  return { width, height, data: rgba };
}

/** CRC-32 table (PNG/zlib polynomial), computed once. */
const CRC_TABLE: number[] = (() => {
  const table: number[] = new Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

/** CRC-32 over a buffer (PNG chunk checksum). */
function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    const idx = (c ^ (buf[i] ?? 0)) & 0xff;
    c = ((CRC_TABLE[idx] ?? 0) ^ (c >>> 8)) >>> 0;
  }
  return (c ^ 0xffffffff) >>> 0;
}

/** Build one PNG chunk (length + type + data + CRC). */
function pngChunk(type: string, data: Buffer): Buffer {
  const typeBuf = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([length, typeBuf, data, crcBuf]);
}

/** Encode a {@link DecodedImage} (RGBA) into a PNG buffer (colour type 6, filter 0). */
export function encodePng(img: DecodedImage): Buffer {
  const { width, height, data } = img;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.writeUInt8(8, 8); // bit depth
  ihdr.writeUInt8(6, 9); // colour type RGBA
  ihdr.writeUInt8(0, 10); // compression
  ihdr.writeUInt8(0, 11); // filter
  ihdr.writeUInt8(0, 12); // interlace

  const stride = width * 4;
  const rawRows = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    rawRows[y * (stride + 1)] = 0; // filter type: none
    for (let x = 0; x < stride; x++) {
      rawRows[y * (stride + 1) + 1 + x] = data[y * stride + x] ?? 0;
    }
  }
  const idat = zlib.deflateSync(rawRows, { level: 9 });

  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------
// Pixel comparison (pixelmatch YIQ delta) — pure, exported for testing
// ---------------------------------------------------------------------------

function rgb2y(r: number, g: number, b: number): number {
  return r * 0.29889531 + g * 0.58662247 + b * 0.11448223;
}
function rgb2i(r: number, g: number, b: number): number {
  return r * 0.59597799 - g * 0.2741761 - b * 0.32180189;
}
function rgb2q(r: number, g: number, b: number): number {
  return r * 0.21147017 - g * 0.52261711 + b * 0.31114694;
}

/** Blend a (possibly translucent) channel value over a white background. */
function blendWhite(c: number, a: number): number {
  return 255 + (c - 255) * a;
}

/** Perceptual (YIQ) squared colour delta between two RGBA pixels, ≥ 0. */
function colorDelta(img: Uint8Array, j: Uint8Array, posA: number, posB: number): number {
  let r1 = img[posA] ?? 0;
  let g1 = img[posA + 1] ?? 0;
  let b1 = img[posA + 2] ?? 0;
  const a1 = img[posA + 3] ?? 255;
  let r2 = j[posB] ?? 0;
  let g2 = j[posB + 1] ?? 0;
  let b2 = j[posB + 2] ?? 0;
  const a2 = j[posB + 3] ?? 255;

  if (a1 < 255) {
    const a = a1 / 255;
    r1 = blendWhite(r1, a);
    g1 = blendWhite(g1, a);
    b1 = blendWhite(b1, a);
  }
  if (a2 < 255) {
    const a = a2 / 255;
    r2 = blendWhite(r2, a);
    g2 = blendWhite(g2, a);
    b2 = blendWhite(b2, a);
  }

  const y = rgb2y(r1, g1, b1) - rgb2y(r2, g2, b2);
  const i = rgb2i(r1, g1, b1) - rgb2i(r2, g2, b2);
  const q = rgb2q(r1, g1, b1) - rgb2q(r2, g2, b2);
  return 0.5053 * y * y + 0.299 * i * i + 0.1957 * q * q;
}

/** The result of comparing two images. */
export interface PixelComparison {
  diffPixels: number;
  totalPixels: number;
  /** True when the two images had different dimensions (treated as a full mismatch). */
  dimensionMismatch: boolean;
  /** The rendered diff image (differing pixels painted red over a dimmed baseline). */
  diffImage: DecodedImage;
}

/**
 * Compare two decoded images. When dimensions differ, the whole frame is a mismatch (every pixel
 * counted). Otherwise each pixel whose YIQ delta exceeds `threshold` (pixelmatch semantics) is
 * counted and painted red in the diff image; unchanged pixels are dimmed to grey.
 */
export function compareImages(
  baseline: DecodedImage,
  current: DecodedImage,
  threshold = DEFAULT_PIXEL_THRESHOLD
): PixelComparison {
  const dimensionMismatch = baseline.width !== current.width || baseline.height !== current.height;
  // The diff image takes the CURRENT capture's geometry so the operator sees the new state.
  const width = current.width;
  const height = current.height;
  const diff = new Uint8Array(width * height * 4);
  const totalPixels = width * height;

  if (dimensionMismatch) {
    // Paint the entire current frame as changed; every pixel counts.
    for (let i = 0; i < totalPixels; i++) {
      const d = i * 4;
      diff[d] = 255;
      diff[d + 1] = 0;
      diff[d + 2] = 0;
      diff[d + 3] = 255;
    }
    return { diffPixels: totalPixels, totalPixels, dimensionMismatch: true, diffImage: { width, height, data: diff } };
  }

  const maxDelta = MAX_YIQ_DELTA * threshold * threshold;
  let diffPixels = 0;
  for (let i = 0; i < totalPixels; i++) {
    const pos = i * 4;
    const delta = colorDelta(baseline.data, current.data, pos, pos);
    if (delta > maxDelta) {
      diff[pos] = 255;
      diff[pos + 1] = 0;
      diff[pos + 2] = 0;
      diff[pos + 3] = 255;
      diffPixels += 1;
    } else {
      // Dimmed grey of the baseline so context is visible behind the red.
      const r = baseline.data[pos] ?? 0;
      const g = baseline.data[pos + 1] ?? 0;
      const b = baseline.data[pos + 2] ?? 0;
      const gray = Math.round(255 - (255 - rgb2y(r, g, b)) * 0.25);
      diff[pos] = gray;
      diff[pos + 1] = gray;
      diff[pos + 2] = gray;
      diff[pos + 3] = 255;
    }
  }

  return { diffPixels, totalPixels, dimensionMismatch: false, diffImage: { width, height, data: diff } };
}

// ---------------------------------------------------------------------------
// Default Playwright screenshot driver
// ---------------------------------------------------------------------------

/**
 * Create the default Playwright screenshot driver. Lazily imports `playwright`, launches Chromium
 * with a deterministic viewport, and captures animation-disabled / caret-hidden screenshots so a
 * capture is stable across runs. Returns `null` (the run then skips every page) when Playwright is
 * unavailable or Chromium cannot launch — never throws. Mirrors the Six Laws verifier's driver.
 */
export async function createPlaywrightScreenshotDriver(options: {
  headless?: boolean;
  viewport?: { width: number; height: number };
  log?: (m: string) => void;
}): Promise<ScreenshotDriver | null> {
  const log = options.log ?? (() => {});
  const viewport = options.viewport ?? DEFAULT_VIEWPORT;
  let pw: typeof import('playwright');
  try {
    pw = await import('playwright');
  } catch (error) {
    log(`Playwright unavailable (${describe(error)})`);
    return null;
  }

  let browser: import('playwright').Browser;
  try {
    browser = await pw.chromium.launch({ headless: options.headless ?? true });
  } catch (error) {
    log(`Chromium failed to launch (${describe(error)})`);
    return null;
  }

  const screenshot = async (req: ScreenshotRequest): Promise<ScreenshotResult> => {
    const result: ScreenshotResult = { ok: false, status: null, png: null, finalUrl: req.url, error: null };
    let context: import('playwright').BrowserContext | null = null;
    try {
      context = await browser.newContext({ viewport, deviceScaleFactor: 1, reducedMotion: 'reduce' });
      const page = await context.newPage();
      const resp = await page.goto(req.url, { waitUntil: 'load', timeout: req.timeoutMs });
      await page.waitForLoadState('networkidle', { timeout: Math.min(5000, req.timeoutMs) }).catch(() => {});
      result.status = resp ? resp.status() : null;
      result.finalUrl = page.url();
      result.ok = resp ? resp.status() < 400 : false;
      if (result.ok) {
        const png = await page.screenshot({ fullPage: req.fullPage, animations: 'disabled', caret: 'hide', type: 'png' });
        result.png = Buffer.from(png);
      }
    } catch (error) {
      result.error = describe(error);
    } finally {
      if (context) await context.close().catch(() => {});
    }
    return result;
  };

  const close = async (): Promise<void> => {
    await browser.close().catch(() => {});
  };

  return { screenshot, close };
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

function statusIcon(s: PageVisualStatus): string {
  switch (s) {
    case 'pass':
      return '✅ PASS';
    case 'fail':
      return '❌ FAIL';
    case 'baseline_created':
      return '🆕 BASELINE';
    case 'error':
      return '⚠️ ERROR';
    default:
      return '⊘ SKIP';
  }
}

/** Render the full markdown report. */
function renderReport(result: Omit<VisualRegressionResult, 'report'>): string {
  const lines: string[] = [];
  lines.push('# FORGE — Visual Regression');
  lines.push('');
  lines.push(`- **Target:** ${result.baseUrl}`);
  lines.push(
    `- **Overall:** ${result.firstRun ? '🆕 BASELINES CAPTURED (first run)' : result.passed ? 'PASS ✅' : 'FAIL ❌'}`
  );
  lines.push(`- **Threshold:** ${result.thresholdPercent}% differing pixels`);
  lines.push(`- **Baselines:** ${result.baselineDir}`);
  lines.push(`- **Generated:** ${result.generatedAt}`);
  lines.push('');
  lines.push('| Route | Result | Diff % | Detail |');
  lines.push('|-------|--------|--------|--------|');
  for (const p of result.pages) {
    const pct = p.diffPercentage < 0 ? '—' : `${p.diffPercentage.toFixed(2)}%`;
    lines.push(`| ${p.path} | ${statusIcon(p.status)} | ${pct} | ${p.detail.replace(/\|/g, '\\|')} |`);
  }
  lines.push('');
  if (result.regressions.length > 0) {
    lines.push('## Regressions');
    lines.push('');
    for (const p of result.regressions) {
      lines.push(`- ❌ **${p.path}** — ${p.diffPercentage.toFixed(2)}% > ${result.thresholdPercent}%` + (p.diffImagePath ? ` — diff: ${p.diffImagePath}` : ''));
    }
    lines.push('');
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Screenshot every route and pixel-diff it against its baseline (capturing baselines on first run).
 * Always resolves — never throws, never fabricates a pass; un-capturable pages SKIP/ERROR with a note.
 */
export async function runVisualRegression(
  input: VisualRegressionInput,
  options: VisualRegressionOptions = {}
): Promise<VisualRegressionResult> {
  const log = options.log ?? logLine('visreg');
  const fs = options.fs ?? defaultFs;
  const now = options.now ?? nowIso;
  const projectPath = input.projectPath ?? process.cwd();
  const baseUrl = (input.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  const thresholdPercent = input.thresholdPercent ?? DEFAULT_THRESHOLD_PERCENT;
  const pixelThreshold = input.pixelMatchThreshold ?? DEFAULT_PIXEL_THRESHOLD;
  const navTimeoutMs = input.navTimeoutMs ?? DEFAULT_NAV_TIMEOUT_MS;
  const defaultFullPage = input.fullPage ?? true;
  const baselineDir = resolveDir(input.baselineDir, projectPath, ['.forge', 'baselines']);
  const diffDir = resolveDir(input.diffDir, projectPath, ['.forge', 'diffs']);
  const pages = input.pages ?? [];

  const base = (): Omit<VisualRegressionResult, 'report'> => ({
    passed: true,
    firstRun: false,
    driverAvailable: true,
    regressions: [],
    pages: [],
    capturedBaselines: 0,
    comparedPages: 0,
    unreachablePages: 0,
    errorPages: 0,
    thresholdPercent,
    baselineDir,
    diffDir,
    baseUrl,
    generatedAt: now(),
  });

  if (pages.length === 0) {
    const partial = base();
    return { ...partial, report: renderReport(partial) };
  }

  // Acquire a driver (injected, else lazily-created Playwright). Null ⇒ every page skips.
  let driver: ScreenshotDriver | null = options.driver ?? null;
  let ownsDriver = false;
  if (!driver) {
    const defaultCreate: NonNullable<VisualRegressionOptions['createDriver']> = (o) =>
      createPlaywrightScreenshotDriver(o);
    const create = options.createDriver ?? defaultCreate;
    try {
      driver = await create({
        headless: options.headless ?? true,
        viewport: options.viewport ?? DEFAULT_VIEWPORT,
        log,
      });
    } catch (error) {
      log(`WARNING: driver creation failed (${describe(error)})`);
      driver = null;
    }
    ownsDriver = driver !== null;
  }

  if (!driver) {
    const results: PageVisualResult[] = pages.map((p) => ({
      path: p.path,
      ...(p.name !== undefined ? { name: p.name } : {}),
      status: 'skipped',
      passed: false,
      diffPercentage: -1,
      baselinePath: posixJoin(baselineDir, `${routeSlug(p.path)}.png`),
      currentPath: null,
      diffImagePath: null,
      width: null,
      height: null,
      diffPixels: 0,
      totalPixels: 0,
      detail: 'browser driver unavailable (Playwright not installed / failed to launch)',
    }));
    const partial: Omit<VisualRegressionResult, 'report'> = {
      ...base(),
      driverAvailable: false,
      pages: results,
      unreachablePages: results.length,
    };
    log('visual regression: browser unavailable — all pages skipped');
    return { ...partial, report: renderReport(partial) };
  }

  const results: PageVisualResult[] = [];
  try {
    for (const page of pages) {
      results.push(
        await processPage(page, {
          driver,
          fs,
          baseUrl,
          baselineDir,
          diffDir,
          thresholdPercent,
          pixelThreshold,
          navTimeoutMs,
          defaultFullPage,
          updateBaselines: input.updateBaselines ?? false,
          log,
        })
      );
    }
  } finally {
    if (ownsDriver) await driver.close().catch(() => {});
  }

  const capturedBaselines = results.filter((r) => r.status === 'baseline_created').length;
  const comparedPages = results.filter((r) => r.status === 'pass' || r.status === 'fail').length;
  const unreachablePages = results.filter((r) => r.status === 'skipped').length;
  const errorPages = results.filter((r) => r.status === 'error').length;
  const regressions = results.filter((r) => r.status === 'fail');
  const firstRun = comparedPages === 0 && capturedBaselines > 0;
  const passed = regressions.length === 0;

  const partial: Omit<VisualRegressionResult, 'report'> = {
    ...base(),
    passed,
    firstRun,
    regressions,
    pages: results,
    capturedBaselines,
    comparedPages,
    unreachablePages,
    errorPages,
  };
  log(
    passed
      ? `visual regression: ${firstRun ? `${capturedBaselines} baseline(s) captured` : 'PASS'} (${comparedPages} compared, ${capturedBaselines} new)`
      : `visual regression: FAIL — ${regressions.length} regression(s)`
  );
  return { ...partial, report: renderReport(partial) };
}

/** Per-page parameters threaded into {@link processPage}. */
interface ProcessPageDeps {
  driver: ScreenshotDriver;
  fs: VisualFs;
  baseUrl: string;
  baselineDir: string;
  diffDir: string;
  thresholdPercent: number;
  pixelThreshold: number;
  navTimeoutMs: number;
  defaultFullPage: boolean;
  updateBaselines: boolean;
  log: (m: string) => void;
}

/** Screenshot + diff a single route, capturing the baseline on first run. Never throws. */
async function processPage(page: VisualRouteSpec, deps: ProcessPageDeps): Promise<PageVisualResult> {
  const slug = routeSlug(page.path);
  const baselinePath = posixJoin(deps.baselineDir, `${slug}.png`);
  const currentPath = posixJoin(deps.diffDir, `${slug}.current.png`);
  const diffImagePath = posixJoin(deps.diffDir, `${slug}.diff.png`);
  const url = joinUrl(deps.baseUrl, page.path);
  const fullPage = page.fullPage ?? deps.defaultFullPage;

  const result: PageVisualResult = {
    path: page.path,
    ...(page.name !== undefined ? { name: page.name } : {}),
    status: 'skipped',
    passed: false,
    diffPercentage: -1,
    baselinePath,
    currentPath: null,
    diffImagePath: null,
    width: null,
    height: null,
    diffPixels: 0,
    totalPixels: 0,
    detail: '',
  };

  // 1. Capture.
  const shot = await deps.driver.screenshot({ url, fullPage, timeoutMs: deps.navTimeoutMs });
  if (!shot.ok || !shot.png) {
    result.status = 'skipped';
    result.detail = shot.error
      ? `could not capture (${shot.error})`
      : `page did not render (status ${shot.status ?? 'none'}) — capture skipped`;
    return result;
  }

  const hasBaseline = !deps.updateBaselines && (await deps.fs.exists(baselinePath));

  // 2a. First run (or forced update) — store the baseline, nothing to compare.
  if (!hasBaseline) {
    const wrote = await deps.fs.writeFile(baselinePath, shot.png);
    if (!wrote) {
      result.status = 'error';
      result.detail = `failed to write baseline ${baselinePath}`;
      return result;
    }
    result.status = 'baseline_created';
    result.passed = true;
    result.detail = deps.updateBaselines ? 'baseline updated (forced)' : 'baseline captured (first run)';
    return result;
  }

  // 2b. Compare against the baseline.
  const baselineBuf = await deps.fs.readFile(baselinePath);
  if (!baselineBuf) {
    result.status = 'error';
    result.detail = `baseline ${baselinePath} could not be read`;
    return result;
  }

  let comparison: PixelComparison;
  try {
    const baselineImg = decodePng(baselineBuf);
    const currentImg = decodePng(shot.png);
    comparison = compareImages(baselineImg, currentImg, deps.pixelThreshold);
    result.width = currentImg.width;
    result.height = currentImg.height;
  } catch (error) {
    result.status = 'error';
    result.detail = `could not decode/compare PNG (${describe(error)})`;
    return result;
  }

  // Persist the current capture + the rendered diff for the operator (best-effort).
  await deps.fs.writeFile(currentPath, shot.png);
  const diffWritten = await deps.fs.writeFile(diffImagePath, encodePng(comparison.diffImage));
  result.currentPath = currentPath;
  result.diffImagePath = diffWritten ? diffImagePath : null;

  const pct = comparison.totalPixels === 0 ? 0 : (comparison.diffPixels / comparison.totalPixels) * 100;
  result.diffPixels = comparison.diffPixels;
  result.totalPixels = comparison.totalPixels;
  result.diffPercentage = Math.round(pct * 100) / 100;

  if (comparison.dimensionMismatch) {
    result.status = 'fail';
    result.detail = `dimensions changed (baseline vs current) — ${result.diffPercentage.toFixed(2)}% (treated as full mismatch)`;
    return result;
  }
  if (result.diffPercentage > deps.thresholdPercent) {
    result.status = 'fail';
    result.detail = `${result.diffPercentage.toFixed(2)}% differing pixels exceeds ${deps.thresholdPercent}% threshold`;
    return result;
  }
  result.status = 'pass';
  result.passed = true;
  result.detail = `${result.diffPercentage.toFixed(2)}% differing pixels (≤ ${deps.thresholdPercent}%)`;
  return result;
}

export default runVisualRegression;
