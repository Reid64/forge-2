/**
 * FORGE 2.0 — UI Engine (barrel export).
 *
 * Re-exports every `src/ui-engine/*` module's public surface so callers (the `forge design` CLI
 * command tree, and any future Phase 3 wiring) import from one place — matching the barrel-export
 * house style of `src/skills/index.ts` / `src/retrofit/index.ts` / `src/orchestrator/index.ts`.
 */

export {
  UIComponentGenerator,
  createUIComponentGenerator,
  type ComponentSpec,
  type GeneratedComponent,
} from './component-generator.js';

export {
  SHADCN_COMPONENTS,
  detectInstalledComponents,
  installComponent,
  ensureComponentsInstalled,
  detectRequiredComponents,
  type ShadcnComponent,
} from './shadcn-installer.js';

export {
  DEFAULT_DESIGN_TOKENS,
  detectProjectTokens,
  generateTailwindConfig,
  generateGlobalsCss,
  ensureDesignTokens,
  type DesignTokens,
} from './design-token-manager.js';

export {
  detectStorybookInstalled,
  installStorybook,
  generateStory,
  generateStoriesForProject,
  generateStorybookIndex,
} from './storybook-generator.js';

export {
  checkComponentAccessibility,
  checkProjectAccessibility,
  type AccessibilityIssue,
  type AccessibilityReport,
} from './accessibility-checker.js';
