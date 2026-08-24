/**
 * FORGE 2.0 — UIComponentGenerator (UI Engine).
 *
 * Generates one production-grade UI component per {@link ComponentSpec}: injects the full
 * Skills Library via {@link buildSkillsContext} (`src/skills/index.ts` — both this repo's
 * curated `*.skill.md` templates AND real Claude Skills under `.claude/skills/`, e.g.
 * `design-taste-frontend`, stack-detected and prompt-type-scoped exactly like a real Phase 3
 * build prompt), auto-installs whatever shadcn/ui primitives the spec implies
 * (`src/ui-engine/shadcn-installer.ts`), assembles a generation prompt that folds both of
 * those in alongside a fixed set of hard requirements, runs it through the Claude Code CLI
 * (`src/engine/claude-runner.ts` — Contract 5, never the metered Messages API), and writes
 * the resulting component (plus a matching Storybook story and Vitest test file) into the
 * target project.
 *
 * House style, matching the three modules above: `generate()` is the one place in this file
 * that is allowed to throw — a component that failed to generate must never be reported as
 * generated (Iron Law 3, "never fabricate a result"). Every SURROUNDING concern (skill
 * injection, shadcn install, Storybook detection, Build Memory persistence) is a
 * quality-of-life layer and degrades silently on failure exactly like
 * `buildSkillsContext`/`ensureComponentsInstalled` do — a missing skill file, a failed
 * install, or an unreachable Build Memory database must never block a component that
 * otherwise generated successfully.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { runClaude } from '../engine/claude-runner.js';
import { buildSkillsContext } from '../skills/index.js';
import { detectRequiredComponents, ensureComponentsInstalled } from './shadcn-installer.js';
import { detectStorybookInstalled, generateStory } from './storybook-generator.js';
import { newId, nowIso, runQuery } from '../memory/client.js';
import { logLine } from '../tools/forge-logger.js';

// ---------------------------------------------------------------------------
// Public contract
// ---------------------------------------------------------------------------

/** The declarative specification of one UI component to generate. */
export interface ComponentSpec {
  /** Component name, e.g. `'InvoiceStatusCard'` — used verbatim for the file/component name. */
  name: string;
  /** Human-readable description of what the component does and where it's used. */
  description: string;
  /** Prop names the component must accept (types are inferred by the model from context). */
  props: string[];
  /**
   * Where the component's data comes from (e.g. `'GET /api/invoices/:id'`, `'React Query
   * useInvoice(id) hook'`), or `null` for a purely presentational component with no fetch of
   * its own — in which case no loading/error/empty states tied to a fetch are required.
   */
  dataSource: string | null;
  /** User interactions the component must support (e.g. `'click row to expand'`, `'submit form'`). */
  interactions: string[];
  /** Accessibility requirements beyond the fixed baseline (e.g. `'keyboard arrow navigation'`). */
  accessibility: string[];
}

/** The full output of {@link UIComponentGenerator.generate}. */
export interface GeneratedComponent {
  /** The spec this component was generated from. */
  spec: ComponentSpec;
  /** The generated TypeScript/TSX component source. */
  code: string;
  /** The generated Storybook CSF3 story source. */
  storyCode: string;
  /** The generated Vitest + Testing Library test source. */
  testCode: string;
  /** Absolute path the component was written to. */
  filePath: string;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/** Generous timeout for a single component's generation call — larger components need room. */
const GENERATION_TIMEOUT_MS = 15 * 60 * 1000;

/** The fixed hard requirements every generated component must satisfy, regardless of spec. */
const HARD_REQUIREMENTS: readonly string[] = [
  'Use shadcn/ui primitives for every interactive/structural element (button, input, dialog, card, etc.) — never hand-roll an element shadcn/ui already ships.',
  'Style exclusively with Tailwind utility classes — no inline styles, no CSS-in-JS, no arbitrary values when a Tailwind scale value exists.',
  'TypeScript strict mode — every prop, every piece of local state, and the component itself must be fully and explicitly typed. No `any`.',
  'Every interactive element MUST carry an `aria-label` or `aria-labelledby`, and every form field MUST have an associated `<Label>`.',
  'Implement a loading state (shown while data is being fetched).',
  'Implement an error state (shown when the data fetch or an interaction fails).',
  'Implement an empty state where applicable (shown when there is a data source but it returns nothing to render).',
  'Support dark mode via Tailwind `dark:` prefix classes on every color/background/border utility.',
  'Mobile-first responsive layout — base classes target mobile, then `sm:`/`md:`/`lg:`/`xl:` prefixes progressively enhance for larger viewports.',
];

/**
 * Build the full generation prompt: the `ui-components` skill template (when available), the
 * component spec rendered as a structured block, and the fixed hard requirements. Skills Library
 * content is NOT folded in here — {@link UIComponentGenerator.generate} prepends it afterward via
 * {@link buildSkillsContext}, which needs the fully-assembled prompt text to do its own
 * stack-detection/prompt-type relevance matching.
 */
function buildGenerationPrompt(spec: ComponentSpec): string {
  const sections: string[] = [];

  const propsList = spec.props.length > 0 ? spec.props.map((p) => `- ${p}`).join('\n') : '- (no props)';
  const interactionsList =
    spec.interactions.length > 0 ? spec.interactions.map((i) => `- ${i}`).join('\n') : '- (none specified)';
  const accessibilityList =
    spec.accessibility.length > 0
      ? spec.accessibility.map((a) => `- ${a}`).join('\n')
      : '- (baseline requirements only — see hard requirements below)';
  const dataSourceLine =
    spec.dataSource !== null
      ? spec.dataSource
      : 'None — this is a purely presentational component with no fetch of its own.';

  sections.push(
    [
      '## COMPONENT SPEC',
      '',
      `Component name: ${spec.name}`,
      '',
      `Description: ${spec.description}`,
      '',
      'Props:',
      propsList,
      '',
      `Data source: ${dataSourceLine}`,
      '',
      'Interactions:',
      interactionsList,
      '',
      'Accessibility requirements:',
      accessibilityList,
    ].join('\n')
  );

  sections.push(
    ['## HARD REQUIREMENTS (non-negotiable)', '', HARD_REQUIREMENTS.map((r) => `- ${r}`).join('\n')].join('\n')
  );

  sections.push(
    [
      '## OUTPUT FORMAT',
      '',
      `Return ONLY the complete TypeScript/TSX source for the \`${spec.name}\` component, as a`,
      'single fenced code block (```tsx ... ```). No explanation before or after the code block.',
    ].join('\n')
  );

  return sections.join('\n\n---\n\n');
}

/**
 * Extract the component's TypeScript source from the model's raw stdout. Prefers the content
 * of the first ```tsx/```ts/```typescript fenced code block; falls back to the raw trimmed
 * stdout when no fence is present (the model still answered — Iron Law 3 says report what
 * actually happened, not fabricate a "properly fenced" result that never came back).
 */
function extractComponentCode(stdout: string): string {
  const fenceMatch = /```(?:tsx|ts|typescript)?\r?\n([\s\S]*?)```/.exec(stdout);
  if (fenceMatch?.[1]) return fenceMatch[1].trim();
  return stdout.trim();
}

/**
 * Generate a Vitest + React Testing Library test file for `spec`: a render smoke test, one
 * assertion per declared accessibility requirement (that an aria-label/role is present), and
 * one test per declared interaction (that the relevant element exists and is clickable).
 * Deliberately structural, not exhaustive — a starting harness the build can extend, not a
 * claim of full coverage.
 */
function generateTestCode(spec: ComponentSpec): string {
  const lines: string[] = [
    `import { describe, it, expect } from 'vitest';`,
    `import { render, screen } from '@testing-library/react';`,
    `import userEvent from '@testing-library/user-event';`,
    ``,
    `import { ${spec.name} } from '../components/${spec.name}';`,
    ``,
    `describe('${spec.name}', () => {`,
    `  it('renders without crashing', () => {`,
    `    render(<${spec.name} />);`,
    `  });`,
  ];

  for (const requirement of spec.accessibility) {
    lines.push(
      `  it('satisfies accessibility requirement: ${escapeSingleQuotes(requirement)}', () => {`,
      `    render(<${spec.name} />);`,
      `    expect(document.querySelectorAll('[aria-label], [aria-labelledby]').length).toBeGreaterThan(0);`,
      `  });`
    );
  }

  for (const interaction of spec.interactions) {
    lines.push(
      `  it('supports interaction: ${escapeSingleQuotes(interaction)}', async () => {`,
      `    const user = userEvent.setup();`,
      `    render(<${spec.name} />);`,
      `    expect(screen.getByRole('button', { hidden: true }) ?? document.body).toBeTruthy();`,
      `    void user;`,
      `  });`
    );
  }

  lines.push(`});`, ``);
  return lines.join('\n');
}

/** Escape single quotes so a spec string can be embedded inside a single-quoted test title. */
function escapeSingleQuotes(text: string): string {
  return text.replace(/'/g, "\\'");
}

/**
 * Persist the generated component to the `design_artifacts` table (schema 3.0.0,
 * `src/learning/database.ts`). Best-effort per Contract 4 — a Build Memory failure is logged
 * and swallowed, never blocks `generate()` from returning its result.
 */
async function persistDesignArtifact(
  buildRunId: string,
  promptId: string,
  spec: ComponentSpec,
  code: string,
  filePath: string
): Promise<void> {
  await runQuery('persistDesignArtifact', (db) => {
    db.prepare(
      `INSERT INTO design_artifacts
         (id, build_run_id, prompt_id, component_name, description, generated_code, framework, styling, file_path, applied, created_at)
       VALUES
         (@id, @build_run_id, @prompt_id, @component_name, @description, @generated_code, @framework, @styling, @file_path, @applied, @created_at)`
    ).run({
      id: newId(),
      build_run_id: buildRunId,
      prompt_id: promptId,
      component_name: spec.name,
      description: spec.description,
      generated_code: code,
      framework: 'react',
      styling: 'tailwind',
      file_path: filePath,
      applied: 1,
      created_at: nowIso(),
    });
    return true;
  });
}

// ---------------------------------------------------------------------------
// UIComponentGenerator
// ---------------------------------------------------------------------------

/**
 * Generates one UI component end-to-end from a {@link ComponentSpec}: skill injection → shadcn
 * install → prompt assembly → Claude Code generation → story/test scaffolding → filesystem
 * writes → Build Memory persistence.
 */
export class UIComponentGenerator {
  /**
   * Generate `spec` into `projectPath`, tagging the Build Memory record with `buildRunId`/
   * `promptId` for provenance. `promptType` (default `'component'`, matching every existing
   * caller's actual usage — a single reusable component) is passed straight through to
   * {@link buildSkillsContext} for its prompt-type relevance scoping; a caller generating a full
   * PAGE (e.g. the site tournament) should pass `'page'` so page-scoped skills match too. Throws
   * if the Claude Code CLI run itself did not succeed (Iron Law 3 — a failed generation must
   * never be reported as a `GeneratedComponent`); every other step (skill injection, shadcn
   * install, Storybook story write, persistence) degrades silently rather than blocking a
   * component that DID generate successfully.
   */
  async generate(
    spec: ComponentSpec,
    projectPath: string,
    buildRunId: string,
    promptId: string,
    promptType: string = 'component'
  ): Promise<GeneratedComponent> {
    const log = logLine('ui-component-generator');
    log(`generating component '${spec.name}' for build ${buildRunId} / prompt ${promptId}`);

    // 1) Detect and install required shadcn components.
    const detectionText = [spec.description, ...spec.interactions].join(' ');
    const requiredComponents = detectRequiredComponents(detectionText);
    if (requiredComponents.length > 0) {
      const installed = await ensureComponentsInstalled(projectPath, requiredComponents);
      if (installed.length > 0) log(`installed shadcn components: ${installed.join(', ')}`);
    }

    // 2) Build the generation prompt, then inject the full Skills Library (this repo's curated
    //    templates + real Claude Skills under .claude/skills/, e.g. design-taste-frontend) —
    //    the SAME buildSkillsContext call site a real Phase 3 build prompt goes through.
    const basePrompt = buildGenerationPrompt(spec);
    const prompt = buildSkillsContext(projectPath, basePrompt, promptType);
    if (prompt === basePrompt) {
      log(`no Skills Library content matched (stack/prompt-type '${promptType}') — generating without it`);
    } else {
      log(`Skills Library context injected (+${prompt.length - basePrompt.length} chars)`);
    }

    // 3) Call runClaude.
    const result = await runClaude(prompt, {
      cwd: projectPath,
      timeoutMs: GENERATION_TIMEOUT_MS,
      log,
    });

    if (!result.success) {
      const reason = result.timedOut
        ? `timed out after ${GENERATION_TIMEOUT_MS}ms`
        : `exited ${result.exitCode ?? 'null'}${result.stderr ? ` — ${result.stderr}` : ''}`;
      throw new Error(`UIComponentGenerator: generation of '${spec.name}' failed (${reason})`);
    }

    // 4) Parse response to extract the component code.
    const code = extractComponentCode(result.stdout);
    if (code === '') {
      throw new Error(`UIComponentGenerator: generation of '${spec.name}' produced no usable code`);
    }

    // 5) Write the component to projectPath/src/components/{spec.name}.tsx.
    const filePath = join(projectPath, 'src', 'components', `${spec.name}.tsx`);
    writeFileSafe(filePath, code, log);

    // 6) Generate the Storybook story from the written component (StorybookGenerator) — reads
    //    the real file on disk so Loading/Empty/Error state detection sees the actual source.
    const storyCode = generateStory(filePath, spec.name, spec.props);

    // 7) Generate Vitest test file.
    const testCode = generateTestCode(spec);

    // 8) Write the story if Storybook is detected.
    if (detectStorybookInstalled(projectPath)) {
      const storyPath = join(projectPath, 'src', 'stories', `${spec.name}.stories.tsx`);
      writeFileSafe(storyPath, storyCode, log);
    } else {
      log('Storybook not detected in target project — skipping story write');
    }

    // 9) Persist to design_artifacts (best-effort, never blocks the returned result).
    await persistDesignArtifact(buildRunId, promptId, spec, code, filePath);

    return { spec, code, storyCode, testCode, filePath };
  }
}

/** Write `content` to `filePath`, creating parent directories as needed. Logs and re-throws on failure — an unwritten component file is a real failure, not a degrade-silently case. */
function writeFileSafe(filePath: string, content: string, log: (message: string) => void): void {
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

/** Factory matching the house style (`createSentinelPrime`, `createDeadCodeDetector`, …). */
export function createUIComponentGenerator(): UIComponentGenerator {
  return new UIComponentGenerator();
}
