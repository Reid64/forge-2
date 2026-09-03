/**
 * FORGE 2.0 — ShadcnInstaller (UI Engine).
 *
 * Auto-installs shadcn/ui components into a TARGET project before a component/page/feature
 * prompt executes, so Claude never has to stop mid-build to run `npx shadcn add <x>` itself
 * (and never silently hand-rolls a component shadcn/ui already ships). Scans the assembled
 * prompt text for UI keywords, maps them to known shadcn/ui component names, checks what is
 * already installed in the target project, and installs anything missing.
 *
 * House style, matching `src/skills/index.ts` and `src/engine/claude-runner.ts`: every export
 * here is guarded — a missing directory, an unreadable `components.json`, or a failed install
 * degrades to "skip it" / "log a warning" rather than throwing. Component auto-install is a
 * quality-of-life layer (Contract 4 posture), never a build blocker.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';

import { logLine } from '../tools/forge-logger.js';

/** One installable shadcn/ui component. */
export interface ShadcnComponent {
  /** The component's shadcn/ui registry name (e.g. `'button'`). */
  name: string;
  /** The exact CLI command used to install it. */
  command: string;
  /** Other shadcn/ui component names this one depends on and should be installed alongside. */
  dependencies: string[];
}

/** Build the standard `npx shadcn@latest add <name> --yes` command for a component. */
function addCommandFor(name: string): string {
  return `npx shadcn@latest add ${name} --yes`;
}

/**
 * Every shadcn/ui component FORGE knows how to auto-install, in the order the shadcn/ui docs
 * present them. `dependencies` captures the components whose installation the shadcn/ui CLI
 * itself pulls in for a composite component (e.g. `form` requires `label`); FORGE installs the
 * declared dependency set explicitly rather than relying solely on the CLI's own resolution, so
 * `detectInstalledComponents` has an accurate picture even if the CLI's internal behavior changes.
 */
export const SHADCN_COMPONENTS: ShadcnComponent[] = [
  { name: 'button', command: addCommandFor('button'), dependencies: [] },
  { name: 'input', command: addCommandFor('input'), dependencies: [] },
  { name: 'label', command: addCommandFor('label'), dependencies: [] },
  { name: 'select', command: addCommandFor('select'), dependencies: [] },
  { name: 'dialog', command: addCommandFor('dialog'), dependencies: [] },
  { name: 'sheet', command: addCommandFor('sheet'), dependencies: [] },
  { name: 'dropdown-menu', command: addCommandFor('dropdown-menu'), dependencies: [] },
  { name: 'table', command: addCommandFor('table'), dependencies: [] },
  { name: 'card', command: addCommandFor('card'), dependencies: [] },
  { name: 'badge', command: addCommandFor('badge'), dependencies: [] },
  { name: 'alert', command: addCommandFor('alert'), dependencies: [] },
  { name: 'toast', command: addCommandFor('toast'), dependencies: [] },
  { name: 'tabs', command: addCommandFor('tabs'), dependencies: [] },
  { name: 'accordion', command: addCommandFor('accordion'), dependencies: [] },
  { name: 'avatar', command: addCommandFor('avatar'), dependencies: [] },
  { name: 'checkbox', command: addCommandFor('checkbox'), dependencies: [] },
  { name: 'radio-group', command: addCommandFor('radio-group'), dependencies: [] },
  { name: 'switch', command: addCommandFor('switch'), dependencies: [] },
  { name: 'textarea', command: addCommandFor('textarea'), dependencies: [] },
  { name: 'form', command: addCommandFor('form'), dependencies: ['label', 'input'] },
  { name: 'calendar', command: addCommandFor('calendar'), dependencies: [] },
  { name: 'date-picker', command: addCommandFor('date-picker'), dependencies: ['calendar', 'popover', 'button'] },
  { name: 'command', command: addCommandFor('command'), dependencies: ['dialog'] },
  { name: 'combobox', command: addCommandFor('combobox'), dependencies: ['command', 'popover'] },
  { name: 'skeleton', command: addCommandFor('skeleton'), dependencies: [] },
  { name: 'separator', command: addCommandFor('separator'), dependencies: [] },
  { name: 'scroll-area', command: addCommandFor('scroll-area'), dependencies: [] },
  { name: 'popover', command: addCommandFor('popover'), dependencies: [] },
  { name: 'hover-card', command: addCommandFor('hover-card'), dependencies: [] },
  { name: 'tooltip', command: addCommandFor('tooltip'), dependencies: [] },
  { name: 'progress', command: addCommandFor('progress'), dependencies: [] },
  { name: 'slider', command: addCommandFor('slider'), dependencies: [] },
  { name: 'toggle', command: addCommandFor('toggle'), dependencies: [] },
  { name: 'navigation-menu', command: addCommandFor('navigation-menu'), dependencies: [] },
  { name: 'breadcrumb', command: addCommandFor('breadcrumb'), dependencies: [] },
  { name: 'pagination', command: addCommandFor('pagination'), dependencies: [] },
  { name: 'alert-dialog', command: addCommandFor('alert-dialog'), dependencies: [] },
  { name: 'context-menu', command: addCommandFor('context-menu'), dependencies: [] },
  { name: 'menubar', command: addCommandFor('menubar'), dependencies: [] },
  { name: 'collapsible', command: addCommandFor('collapsible'), dependencies: [] },
  { name: 'aspect-ratio', command: addCommandFor('aspect-ratio'), dependencies: [] },
  { name: 'resizable', command: addCommandFor('resizable'), dependencies: [] },
];

/** Fast lookup of a known component's definition by name. */
const COMPONENT_BY_NAME: ReadonlyMap<string, ShadcnComponent> = new Map(
  SHADCN_COMPONENTS.map((c) => [c.name, c])
);

/**
 * Keyword → shadcn/ui component name mapping used by {@link detectRequiredComponents}. Ordered
 * so more specific phrases (`'date picker'`) are checked before the more general component name
 * alone (`'calendar'`) would otherwise also match on its own.
 */
const COMPONENT_KEYWORDS: ReadonlyArray<{ keywords: string[]; component: string }> = [
  { keywords: ['date picker', 'datepicker'], component: 'date-picker' },
  { keywords: ['dropdown menu', 'dropdown-menu', 'dropdown'], component: 'dropdown-menu' },
  { keywords: ['radio group', 'radio-group', 'radio button'], component: 'radio-group' },
  { keywords: ['navigation menu', 'nav menu', 'navbar'], component: 'navigation-menu' },
  { keywords: ['alert dialog', 'confirm dialog', 'confirmation dialog'], component: 'alert-dialog' },
  { keywords: ['context menu', 'right-click menu'], component: 'context-menu' },
  { keywords: ['scroll area', 'scrollable area'], component: 'scroll-area' },
  { keywords: ['hover card'], component: 'hover-card' },
  { keywords: ['aspect ratio'], component: 'aspect-ratio' },
  { keywords: ['button'], component: 'button' },
  { keywords: ['text input', 'input field', 'input box', ' input '], component: 'input' },
  { keywords: ['label'], component: 'label' },
  { keywords: ['select', 'dropdown select'], component: 'select' },
  { keywords: ['modal', 'dialog'], component: 'dialog' },
  { keywords: ['sheet', 'slide-over', 'side panel', 'drawer'], component: 'sheet' },
  { keywords: ['table', 'data table', 'grid view'], component: 'table' },
  { keywords: ['card'], component: 'card' },
  { keywords: ['badge', 'pill', 'tag chip'], component: 'badge' },
  { keywords: ['alert', 'banner'], component: 'alert' },
  { keywords: ['toast', 'notification popup', 'snackbar'], component: 'toast' },
  { keywords: ['tabs', 'tabbed'], component: 'tabs' },
  { keywords: ['accordion', 'expandable section', 'collapsible section'], component: 'accordion' },
  { keywords: ['avatar', 'profile picture', 'user icon'], component: 'avatar' },
  { keywords: ['checkbox'], component: 'checkbox' },
  { keywords: ['switch', 'toggle switch'], component: 'switch' },
  { keywords: ['textarea', 'multiline input', 'text area'], component: 'textarea' },
  { keywords: ['form'], component: 'form' },
  { keywords: ['calendar', 'date range'], component: 'calendar' },
  { keywords: ['command palette', 'command menu'], component: 'command' },
  { keywords: ['combobox', 'autocomplete', 'searchable select'], component: 'combobox' },
  { keywords: ['skeleton', 'loading placeholder', 'loading skeleton'], component: 'skeleton' },
  { keywords: ['separator', 'divider'], component: 'separator' },
  { keywords: ['popover'], component: 'popover' },
  { keywords: ['tooltip'], component: 'tooltip' },
  { keywords: ['progress bar', 'progress indicator'], component: 'progress' },
  { keywords: ['slider', 'range slider'], component: 'slider' },
  { keywords: ['toggle'], component: 'toggle' },
  { keywords: ['breadcrumb', 'breadcrumbs'], component: 'breadcrumb' },
  { keywords: ['pagination', 'page numbers'], component: 'pagination' },
  { keywords: ['menubar', 'menu bar'], component: 'menubar' },
  { keywords: ['collapsible'], component: 'collapsible' },
  { keywords: ['resizable panel', 'resizable panels'], component: 'resizable' },
];

/**
 * Read `<projectPath>/components.json` (the shadcn/ui project manifest) and
 * `<projectPath>/src/components/ui/` (the default install directory) to determine which
 * components are already present, by filename (each installed component is one `<name>.tsx`
 * file). Returns `[]` when neither `components.json` nor the ui directory exists — a project
 * that has never run `shadcn init` has nothing installed yet, never an error.
 */
export function detectInstalledComponents(projectPath: string): string[] {
  const installed = new Set<string>();

  const componentsJsonPath = join(projectPath, 'components.json');
  if (existsSync(componentsJsonPath)) {
    try {
      // components.json itself does not list installed components (it only holds aliases/paths),
      // but its presence confirms the project has been initialized for shadcn/ui — read it so a
      // malformed file is surfaced via the catch below rather than silently ignored.
      JSON.parse(readFileSync(componentsJsonPath, 'utf8'));
    } catch {
      /* malformed components.json — fall through to the directory scan below */
    }
  }

  const uiDirCandidates = [
    join(projectPath, 'src', 'components', 'ui'),
    join(projectPath, 'components', 'ui'),
  ];
  for (const uiDir of uiDirCandidates) {
    if (!existsSync(uiDir)) continue;
    try {
      const files = readdirSync(uiDir);
      for (const file of files) {
        const match = /^([a-z0-9-]+)\.tsx?$/i.exec(file);
        if (match?.[1]) installed.add(match[1].toLowerCase());
      }
    } catch {
      /* unreadable directory — best effort, keep whatever was found before the failure */
    }
  }

  return Array.from(installed);
}

/**
 * Run `npx shadcn@latest add <componentName> --yes` in `projectPath`. Skips (resolves
 * immediately, no process spawned) when {@link detectInstalledComponents} already reports the
 * component present. Never rejects — a spawn failure or non-zero exit is logged as a warning and
 * the promise still resolves, matching the never-throw posture of `runClaude`/`buildSkillsContext`
 * (component install is a quality-of-life layer, never a build blocker).
 */
export function installComponent(projectPath: string, componentName: string): Promise<void> {
  const log = logLine('shadcn-installer');
  const definition = COMPONENT_BY_NAME.get(componentName);
  const command = definition?.command ?? addCommandFor(componentName);

  if (detectInstalledComponents(projectPath).includes(componentName)) {
    log(`'${componentName}' already installed — skipping`);
    return Promise.resolve();
  }

  return new Promise<void>((resolve) => {
    const useShell = process.platform === 'win32';
    const args = ['shadcn@latest', 'add', componentName, '--yes'];
    log(`installing '${componentName}': npx ${args.join(' ')} (cwd=${projectPath})`);

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
      log(`WARNING: failed to spawn install for '${componentName}' (${command}): ${message}`);
      resolve();
      return;
    }

    const stderrChunks: Buffer[] = [];
    // Drain stdout even though it isn't captured — an unread pipe can fill its OS buffer and
    // block the child process indefinitely.
    child.stdout?.on('data', () => {});
    child.stderr?.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

    child.on('error', (error: Error) => {
      log(`WARNING: install failed for '${componentName}': ${error.message}`);
      resolve();
    });

    child.on('close', (code: number | null) => {
      if (code === 0) {
        // Finding K-4: a zero exit code alone is not proof of a real install — the deprecated
        // `shadcn-ui@latest` package name was observed to exit 0 and write nothing. Re-check the
        // filesystem before reporting success.
        if (detectInstalledComponents(projectPath).includes(componentName)) {
          log(`installed '${componentName}'`);
        } else {
          log(
            `WARNING: install for '${componentName}' exited 0 but no matching file was found in ` +
              `components/ui/ afterward — treating as a failed install, not a success`,
          );
        }
      } else {
        const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();
        log(`WARNING: install for '${componentName}' exited ${code ?? 'null'}${stderr ? ` — ${stderr}` : ''}`);
      }
      resolve();
    });
  });
}

/**
 * Install every component in `requiredComponents` that {@link detectInstalledComponents} does not
 * already report present (each component's own `dependencies` are installed alongside it, since
 * `installComponent` is called per-name and re-checks installed state before each call, so an
 * already-satisfied dependency is skipped automatically). Installs run sequentially — the shadcn/ui
 * CLI mutates shared files (`components.json`, `tailwind.config`) and is not safe to run
 * concurrently against the same project. Returns the names actually newly installed (skips
 * components that were already present are not included).
 */
export async function ensureComponentsInstalled(
  projectPath: string,
  requiredComponents: string[]
): Promise<string[]> {
  const alreadyInstalled = new Set(detectInstalledComponents(projectPath));
  const withDependencies = new Set<string>();
  for (const name of requiredComponents) {
    withDependencies.add(name);
    for (const dep of COMPONENT_BY_NAME.get(name)?.dependencies ?? []) {
      withDependencies.add(dep);
    }
  }

  const toInstall = Array.from(withDependencies).filter((name) => !alreadyInstalled.has(name));
  const newlyInstalled: string[] = [];
  for (const name of toInstall) {
    await installComponent(projectPath, name);
    // Re-check rather than assume success (install may have failed and logged a warning) — only
    // report a component as newly installed if it is genuinely present afterward.
    if (detectInstalledComponents(projectPath).includes(name)) newlyInstalled.push(name);
  }
  return newlyInstalled;
}

/**
 * Scan `promptText` (case-insensitive) for UI component keywords and return the matching
 * shadcn/ui component names, deduplicated, in {@link SHADCN_COMPONENTS} order. Returns `[]` when
 * nothing matches — a prompt with no detected UI keywords is not an error, just not UI work.
 */
export function detectRequiredComponents(promptText: string): string[] {
  const haystack = ` ${promptText.toLowerCase()} `;
  const found = new Set<string>();
  for (const { keywords, component } of COMPONENT_KEYWORDS) {
    if (keywords.some((kw) => haystack.includes(kw.toLowerCase()))) {
      found.add(component);
    }
  }
  // Return in SHADCN_COMPONENTS' canonical order for stable, predictable output.
  return SHADCN_COMPONENTS.map((c) => c.name).filter((name) => found.has(name));
}
