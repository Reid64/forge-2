/**
 * FORGE 2.0 — StorybookGenerator (UI Engine).
 *
 * Gives every generated component (`src/ui-engine/component-generator.ts`) and every
 * pre-existing component in a target project a real Storybook CSF3 story, and gives a target
 * project a working Storybook install to render them in. Four independent concerns, each usable
 * on its own:
 *
 *   - {@link detectStorybookInstalled}/{@link installStorybook} — detect/bootstrap Storybook
 *     itself in the target project (`.storybook/` + the `storybook`/`@storybook/*` packages).
 *   - {@link generateStory} — pure string generation: given one component's file + name + prop
 *     list, produce a complete CSF3 story with `Default` always, and `Loading`/`Empty`/`Error`
 *     stories added only when the component actually appears to need them (a `loading`/`error`
 *     prop, or empty-state rendering logic in the component's own source).
 *   - {@link generateStoriesForProject} — batch mode: scan `src/components/**\/*.tsx` for
 *     components with no story yet and generate one for each.
 *   - {@link generateStorybookIndex} — scaffold `.storybook/main.ts` + `.storybook/preview.ts`
 *     wired for Next.js + Tailwind.
 *
 * House style, matching `shadcn-installer.ts`/`component-generator.ts`: detection and install are
 * guarded quality-of-life layers (Contract 4 posture) — a missing `package.json`, a failed
 * `npx storybook init`, or an unreadable component file degrades to `false`/a skipped entry/a
 * logged warning, never a thrown error. Writing a requested story or config file is the one place
 * failure is NOT swallowed — an unwritten file must never be reported as written (Iron Law 3),
 * matching `component-generator.ts`'s `writeFileSafe` posture exactly.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { basename, dirname, join, posix as posixPath } from 'node:path';

import { logLine } from '../tools/forge-logger.js';

// ---------------------------------------------------------------------------
// Storybook detection + install
// ---------------------------------------------------------------------------

interface PackageJsonDeps {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

/** Read + JSON.parse a `package.json`, returning `null` on any read/parse failure. */
function readPackageJsonSafe(pkgPath: string): PackageJsonDeps | null {
  try {
    const text = readFileSync(pkgPath, 'utf8');
    return JSON.parse(text) as PackageJsonDeps;
  } catch {
    return null;
  }
}

/**
 * Detect whether `projectPath` already has Storybook configured — a `.storybook/` directory at
 * the project root, or a `storybook`/`@storybook/*` dependency in `package.json`. Degrades to
 * `false` on a missing/unparseable `package.json` (never throws) — the same posture as
 * `detectProjectStack` in `src/skills/index.ts` and `detectInstalledComponents` in
 * `shadcn-installer.ts`.
 */
export function detectStorybookInstalled(projectPath: string): boolean {
  try {
    if (existsSync(join(projectPath, '.storybook'))) return true;
    const pkgPath = join(projectPath, 'package.json');
    if (!existsSync(pkgPath)) return false;
    const pkg = readPackageJsonSafe(pkgPath);
    if (!pkg) return false;
    const allDeps = [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})];
    return allDeps.some((dep) => dep === 'storybook' || dep.startsWith('@storybook/'));
  } catch {
    return false;
  }
}

/**
 * Run `npx storybook@latest init --yes` in `projectPath`. Skips (resolves immediately, no process
 * spawned) when {@link detectStorybookInstalled} already reports Storybook present. Never rejects
 * — a spawn failure or non-zero exit is logged as a warning and the promise still resolves,
 * matching `installComponent`'s never-throw posture in `shadcn-installer.ts` (Storybook install is
 * a quality-of-life layer, never a build blocker).
 */
export function installStorybook(projectPath: string): Promise<void> {
  const log = logLine('storybook-generator');

  if (detectStorybookInstalled(projectPath)) {
    log('Storybook already installed — skipping init');
    return Promise.resolve();
  }

  return new Promise<void>((resolve) => {
    const useShell = process.platform === 'win32';
    const args = ['storybook@latest', 'init', '--yes'];
    log(`installing Storybook: npx ${args.join(' ')} (cwd=${projectPath})`);

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn('npx', args, {
        cwd: projectPath,
        shell: useShell,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`WARNING: failed to spawn Storybook init: ${message}`);
      resolve();
      return;
    }

    const stderrChunks: Buffer[] = [];
    // Drain stdout even though it isn't captured — an unread pipe can fill its OS buffer and
    // block the child process indefinitely.
    child.stdout?.on('data', () => {});
    child.stderr?.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

    child.on('error', (error: Error) => {
      log(`WARNING: Storybook init failed to spawn: ${error.message}`);
      resolve();
    });

    child.on('close', (code: number | null) => {
      if (code === 0) {
        log('Storybook init completed');
      } else {
        const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();
        log(`WARNING: Storybook init exited ${code ?? 'null'}${stderr ? ` — ${stderr}` : ''}`);
      }
      resolve();
    });
  });
}

// ---------------------------------------------------------------------------
// Story generation (CSF3)
// ---------------------------------------------------------------------------

/** Prop names matching this are treated as the component's "is loading" signal. */
const LOADING_PROP_PATTERN = /loading/i;
/** Prop names matching this are treated as the component's "has an error" signal. */
const ERROR_PROP_PATTERN = /error/i;
/** Prop names matching this are treated as the collection the component renders (for an Empty story). */
const COLLECTION_PROP_PATTERN = /^(items|data|list|results|rows|entries)$/i;
/** Source-text signals that a component renders a distinct empty state. */
const EMPTY_STATE_SOURCE_PATTERNS: readonly RegExp[] = [
  /empty[-\s]?state/i,
  /no\s+(results|data|items)\s+(found|to\s+display|available)/i,
  /\.length\s*===\s*0/,
  /\.length\s*<\s*1/,
];

/** Return the first prop name matching `pattern`, or `undefined` when none match. */
function findPropMatching(props: string[], pattern: RegExp): string | undefined {
  return props.find((prop) => pattern.test(prop));
}

/** Read a component's source for state-detection purposes. Degrades to `''` — never throws. */
function readComponentSourceSafe(componentPath: string): string {
  try {
    if (!existsSync(componentPath)) return '';
    return readFileSync(componentPath, 'utf8');
  } catch {
    return '';
  }
}

/**
 * Whether `source`/`props` indicate the component renders a distinct empty state: either the
 * source contains a recognizable empty-state pattern, or the props declare a collection
 * (`items`/`data`/`list`/`results`/`rows`/`entries`) that plausibly renders one.
 */
function detectsEmptyState(source: string, props: string[]): boolean {
  if (EMPTY_STATE_SOURCE_PATTERNS.some((pattern) => pattern.test(source))) return true;
  return props.some((prop) => COLLECTION_PROP_PATTERN.test(prop));
}

/** The project-relative directory every generated story is written into. */
const STORIES_DIR_POSIX = posixPath.join('src', 'stories');

/**
 * Reduce an arbitrary (possibly absolute, possibly Windows-separated) component path down to its
 * `src/...`-relative form, purely lexically — no filesystem access. Falls back to the path as
 * given (leading `./` stripped) when no `src/` anchor is found.
 */
function toProjectRelativePosixPath(componentPath: string): string {
  const normalized = componentPath.replace(/\\/g, '/');
  const withoutExt = normalized.replace(/\.(tsx|ts)$/i, '');
  const anchorIndex = withoutExt.lastIndexOf('/src/');
  if (anchorIndex >= 0) return withoutExt.slice(anchorIndex + 1);
  if (withoutExt.startsWith('src/')) return withoutExt;
  return withoutExt.replace(/^\.?\/+/, '');
}

/**
 * Compute the story's import specifier for a component, assuming the story is written to
 * `src/stories/` (the fixed convention `generateStoriesForProject`/`component-generator.ts` both
 * write to). E.g. `src/components/Foo.tsx` → `../components/Foo`.
 */
function computeStoryImportPath(componentPath: string): string {
  const projectRelative = toProjectRelativePosixPath(componentPath);
  const importPath = posixPath.relative(STORIES_DIR_POSIX, projectRelative);
  return importPath.startsWith('.') ? importPath : `./${importPath}`;
}

/** Render a prop name as a safe JS object-key identifier for a story's `args` block. */
function toSafeIdentifier(prop: string): string {
  const trimmed = prop.trim();
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(trimmed) ? trimmed : JSON.stringify(trimmed);
}

/**
 * Render one story's `args` object body: every declared prop gets a placeholder sample value,
 * except props named in `overrides`, which get that (already-formatted, e.g. `'true'`, `'[]'`)
 * raw expression string instead — used to make `Loading`/`Empty`/`Error` stories actually
 * exercise the state they claim to demonstrate.
 */
function renderArgsBlock(props: string[], overrides: Readonly<Record<string, string>>): string {
  if (props.length === 0) return '';
  return props
    .map((prop) => {
      const key = toSafeIdentifier(prop);
      const value = overrides[prop] ?? JSON.stringify(`sample-${prop}`);
      return `    ${key}: ${value},`;
    })
    .join('\n');
}

/**
 * Generate a complete Storybook CSF3 story for one component. `componentPath` is used only to
 * derive the import specifier ({@link computeStoryImportPath}) and, when the file exists on disk,
 * to inspect its source for empty-state rendering logic — it is never required to exist.
 *
 * Always emits `Default`. Additionally emits:
 *   - `Loading`, when `props` contains a prop matching {@link LOADING_PROP_PATTERN} (e.g.
 *     `loading`, `isLoading`) — that prop is set to `true`.
 *   - `Empty`, when {@link detectsEmptyState} finds empty-state signals in the source or props —
 *     a matching collection prop (`items`/`data`/etc.) is set to `[]` when one is declared.
 *   - `Error`, when `props` contains a prop matching {@link ERROR_PROP_PATTERN} (e.g. `error`,
 *     `hasError`) — that prop is set to a sample error message.
 */
export function generateStory(componentPath: string, componentName: string, props: string[]): string {
  const source = readComponentSourceSafe(componentPath);
  const importPath = computeStoryImportPath(componentPath);

  const loadingProp = findPropMatching(props, LOADING_PROP_PATTERN);
  const errorProp = findPropMatching(props, ERROR_PROP_PATTERN);
  const hasEmptyState = detectsEmptyState(source, props);
  const emptyCollectionProp = findPropMatching(props, COLLECTION_PROP_PATTERN);

  const lines: string[] = [
    `import type { Meta, StoryObj } from '@storybook/react';`,
    ``,
    `import { ${componentName} } from '${importPath}';`,
    ``,
    `const meta: Meta<typeof ${componentName}> = {`,
    `  title: 'Components/${componentName}',`,
    `  component: ${componentName},`,
    `  tags: ['autodocs'],`,
    `};`,
    ``,
    `export default meta;`,
    `type Story = StoryObj<typeof ${componentName}>;`,
    ``,
    `export const Default: Story = {`,
    `  args: {`,
    renderArgsBlock(props, {}),
    `  },`,
    `};`,
  ];

  if (loadingProp) {
    lines.push(
      ``,
      `export const Loading: Story = {`,
      `  args: {`,
      renderArgsBlock(props, { [loadingProp]: 'true' }),
      `  },`,
      `};`
    );
  }

  if (hasEmptyState) {
    lines.push(
      ``,
      `export const Empty: Story = {`,
      `  args: {`,
      renderArgsBlock(props, emptyCollectionProp ? { [emptyCollectionProp]: '[]' } : {}),
      `  },`,
      `};`
    );
  }

  if (errorProp) {
    lines.push(
      ``,
      `export const Error: Story = {`,
      `  args: {`,
      renderArgsBlock(props, { [errorProp]: JSON.stringify('Something went wrong.') }),
      `  },`,
      `};`
    );
  }

  lines.push(``);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Batch generation across a project
// ---------------------------------------------------------------------------

/** Story/test file suffixes excluded when scanning for component files. */
const STORY_OR_TEST_SUFFIX = /\.(stories|test|spec)\.tsx$/i;

/**
 * Recursively list every `.tsx` component file under `componentsDir`, excluding files already
 * matching {@link STORY_OR_TEST_SUFFIX}. Returns `[]` when `componentsDir` doesn't exist or can't
 * be read (never throws) — a project with no `src/components/` directory has nothing to scan.
 */
function findComponentFiles(componentsDir: string): string[] {
  if (!existsSync(componentsDir)) return [];
  try {
    const entries = readdirSync(componentsDir, { recursive: true }) as string[];
    return entries
      .filter((entry) => entry.toLowerCase().endsWith('.tsx') && !STORY_OR_TEST_SUFFIX.test(entry))
      .map((entry) => join(componentsDir, entry))
      .sort();
  } catch {
    return [];
  }
}

/**
 * Extract prop names from a component's `<ComponentName>Props` interface/type declaration via a
 * regex scan (deliberately not an AST parse — matches the regex-based scope `src/retrofit/`'s
 * detectors already document for this class of tool). Returns `[]` when no such declaration is
 * found — a component with no matching `Props` type simply gets a story with no `args`.
 */
function extractPropsFromSource(source: string, componentName: string): string[] {
  const interfacePattern = new RegExp(`(?:interface|type)\\s+${componentName}Props\\s*(?:=\\s*)?\\{([\\s\\S]*?)\\}`);
  const match = interfacePattern.exec(source);
  if (!match?.[1]) return [];

  const body = match[1];
  const propNames: string[] = [];
  const propLineRegex = /^\s*([A-Za-z_$][A-Za-z0-9_$]*)\??\s*:/gm;
  let lineMatch: RegExpExecArray | null;
  while ((lineMatch = propLineRegex.exec(body)) !== null) {
    const name = lineMatch[1];
    if (name) propNames.push(name);
  }
  return propNames;
}

/**
 * Scan `<projectPath>/src/components/**\/*.tsx` for components with no story yet under
 * `<projectPath>/src/stories/`, generate one per component (props inferred via
 * {@link extractPropsFromSource}), and write it. A component whose story already exists is
 * recorded in `skipped`, not regenerated — this function never overwrites a hand-edited story. A
 * per-component write failure is logged and that component is added to `skipped` rather than
 * aborting the whole scan (Contract 4 posture — one bad file must not block every other story).
 */
export async function generateStoriesForProject(
  projectPath: string
): Promise<{ generated: string[]; skipped: string[] }> {
  const log = logLine('storybook-generator');
  const componentsDir = join(projectPath, 'src', 'components');
  const storiesDir = join(projectPath, 'src', 'stories');

  const componentFiles = findComponentFiles(componentsDir);
  const generated: string[] = [];
  const skipped: string[] = [];

  for (const componentFile of componentFiles) {
    const componentName = basename(componentFile).replace(/\.tsx$/i, '');
    const storyPath = join(storiesDir, `${componentName}.stories.tsx`);

    if (existsSync(storyPath)) {
      log(`story already exists for '${componentName}' — skipping`);
      skipped.push(storyPath);
      continue;
    }

    try {
      const source = readComponentSourceSafe(componentFile);
      const props = extractPropsFromSource(source, componentName);
      const storyCode = generateStory(componentFile, componentName, props);
      mkdirSync(dirname(storyPath), { recursive: true });
      writeFileSync(storyPath, storyCode, 'utf8');
      log(`generated story: ${storyPath}`);
      generated.push(storyPath);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`WARNING: failed to generate story for '${componentName}': ${message}`);
      skipped.push(componentFile);
    }
  }

  return { generated, skipped };
}

// ---------------------------------------------------------------------------
// Storybook config scaffolding
// ---------------------------------------------------------------------------

const MAIN_TS_TEMPLATE = `import type { StorybookConfig } from '@storybook/nextjs';

const config: StorybookConfig = {
  stories: ['../src/stories/**/*.stories.@(ts|tsx)', '../src/components/**/*.stories.@(ts|tsx)'],
  addons: [
    '@storybook/addon-essentials',
    '@storybook/addon-interactions',
    '@storybook/addon-a11y',
  ],
  framework: {
    name: '@storybook/nextjs',
    options: {},
  },
  staticDirs: ['../public'],
  docs: {
    autodocs: 'tag',
  },
};

export default config;
`;

const PREVIEW_TS_TEMPLATE = `import type { Preview } from '@storybook/react';

import '../src/app/globals.css';

const preview: Preview = {
  parameters: {
    controls: {
      matchers: {
        color: /(background|color)$/i,
        date: /Date$/i,
      },
    },
    backgrounds: {
      default: 'light',
      values: [
        { name: 'light', value: '#ffffff' },
        { name: 'dark', value: '#0a0a0a' },
      ],
    },
    layout: 'centered',
  },
  tags: ['autodocs'],
};

export default preview;
`;

/** Write `content` to `filePath`, creating parent directories as needed. Logs and re-throws on failure — an unwritten config file is a real failure, not a degrade-silently case (matches `component-generator.ts`'s `writeFileSafe`). */
function writeConfigFile(filePath: string, content: string, log: (message: string) => void): void {
  try {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, content, 'utf8');
    log(`wrote ${filePath}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`ERROR: failed to write ${filePath}: ${message}`);
    throw error;
  }
}

/**
 * Create `<projectPath>/.storybook/main.ts` and `<projectPath>/.storybook/preview.ts`, configured
 * for a Next.js + Tailwind project (`@storybook/nextjs` framework, Tailwind's global stylesheet
 * imported in `preview.ts`). Overwrites any existing config at those two paths — this function is
 * "create/reset the config," not a merge.
 */
export async function generateStorybookIndex(projectPath: string): Promise<void> {
  const log = logLine('storybook-generator');
  const storybookDir = join(projectPath, '.storybook');
  writeConfigFile(join(storybookDir, 'main.ts'), MAIN_TS_TEMPLATE, log);
  writeConfigFile(join(storybookDir, 'preview.ts'), PREVIEW_TS_TEMPLATE, log);
}
