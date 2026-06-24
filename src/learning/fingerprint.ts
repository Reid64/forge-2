// FORGE 2.0 Learning Engine — Error Fingerprinting
import { createHash } from 'node:crypto';

/**
 * Known framework directory names that should NOT be wildcarded.
 * These are structural, not entity-specific.
 */
const FRAMEWORK_DIRS = new Set([
  'app', 'api', 'components', 'src', 'lib', 'utils', 'types',
  'hooks', 'middleware', 'pages', 'layouts', 'styles', 'public',
  'supabase', 'migrations', 'config', 'scripts', 'tests',
  'node_modules', '.next', 'dist', 'build'
]);

/**
 * Generalize a file path by replacing entity-specific directory segments with *.
 * Keeps framework directories and filenames intact.
 *
 * Examples:
 *   app/api/storms/route.ts → app/api/*/route.ts
 *   components/dashboard/StormMap.tsx → components/*/StormMap.tsx
 *   src/utils/helpers.ts → src/utils/helpers.ts (no dynamic segment)
 *   app/api/storms/[id]/route.ts → app/api/*/[id]/route.ts
 */
export function generalizeFilePath(filePath: string): string {
  // Normalize separators
  const normalized = filePath.replace(/\\/g, '/');
  const parts = normalized.split('/');

  if (parts.length <= 1) return normalized;

  // Last part is the filename — keep it
  const filename = parts[parts.length - 1];
  const dirs = parts.slice(0, -1);

  const generalizedDirs = dirs.map(dir => {
    // Keep framework directories
    if (FRAMEWORK_DIRS.has(dir.toLowerCase())) return dir;
    // Keep dynamic route segments like [id], [slug], etc.
    if (dir.startsWith('[') && dir.endsWith(']')) return dir;
    // Keep single-char dirs
    if (dir.length <= 2) return dir;
    // Everything else is potentially an entity name — wildcard it
    return '*';
  });

  return [...generalizedDirs, filename].join('/');
}

/**
 * Generalize an error message by replacing app-specific identifiers with *.
 * Keeps structural/grammatical words intact.
 *
 * Examples:
 *   "Module './StormMap' not found" → "Module '*' not found"
 *   "Property 'name' does not exist on type 'Storm'" → "Property '*' does not exist on type '*'"
 *   "Cannot find name 'fetchStorms'" → "Cannot find name '*'"
 *   "Argument of type 'string' is not assignable to parameter of type 'number'" → preserves type names
 */
export function generalizeErrorMessage(message: string): string {
  let result = message;

  // Replace single-quoted strings: 'anything' → '*'
  result = result.replace(/'[^']+'/g, "'*'");

  // Replace double-quoted strings: "anything" → "*"
  result = result.replace(/"[^"]+"/g, '"*"');

  // Replace backtick strings: `anything` → `*`
  result = result.replace(/`[^`]+`/g, '`*`');

  // Replace PascalCase identifiers (likely component/class names)
  // but NOT common TypeScript structural words
  const structuralWords = new Set([
    'Module', 'Property', 'Type', 'Cannot', 'Error', 'Warning',
    'Object', 'Array', 'String', 'Number', 'Boolean', 'Function',
    'Promise', 'Argument', 'Parameter', 'Return', 'Import', 'Export',
    'Default', 'Undefined', 'Null', 'Void', 'Never', 'Unknown', 'Any'
  ]);

  result = result.replace(/\b([A-Z][a-zA-Z0-9]{2,})\b/g, (match) => {
    return structuralWords.has(match) ? match : '*';
  });

  // Replace file paths in messages
  result = result.replace(/(?:\.\/|\.\.\/)[^\s'"`,)]+/g, '*');

  // Collapse multiple consecutive * into single *
  result = result.replace(/\*(\s*\*)+/g, '*');

  return result;
}

/**
 * Generate a deterministic fingerprint for an error pattern.
 *
 * SHA-256 hash of four pipe-separated components:
 * 1. Error code (lowercase, trimmed)
 * 2. Generalized file path
 * 3. Generalized error message
 * 4. Sorted tech stack tags
 *
 * Returns first 32 hex characters.
 */
export function getErrorFingerprint(error: {
  errorCode: string;
  filePath: string;
  errorMessage: string;
  techStack: string[];
}): string {
  const component1 = error.errorCode.toLowerCase().trim();
  const component2 = generalizeFilePath(error.filePath);
  const component3 = generalizeErrorMessage(error.errorMessage);
  const component4 = [...error.techStack].sort().join(',');

  const input = [component1, component2, component3, component4].join('|');
  const hash = createHash('sha256').update(input).digest('hex');

  return hash.substring(0, 32);
}
