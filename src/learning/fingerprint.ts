// FORGE 2.0 Learning Engine — Error Fingerprinting
import { createHash } from 'node:crypto';

export const FP_VERSION = '1.0.0';

export function getErrorFingerprint(error: {
  errorCode: string;
  filePath: string;
  errorMessage: string;
  errorCategory: string;
  techStack: string[];
}): string {
  // Normalize path: strip line:col suffix and machine-specific prefixes
  const normalizedPath = error.filePath
    .replace(/\\/g, '/')
    .replace(/:\d+:\d+$/, '')
    .replace(/^.*?(src\/|lib\/|dist\/)/, '$1');

  // Template message: replace numbers and quoted tokens with placeholders
  const normalizedMessage = error.errorMessage
    .replace(/\d+/g, '<N>')
    .replace(/'[^']*'/g, "'<TOKEN>'")
    .replace(/"[^"]*"/g, '"<TOKEN>"')
    .replace(/`[^`]*`/g, '`<TOKEN>`');

  const raw = [
    error.errorCategory,
    error.errorCode || '<NO_CODE>',
    normalizedPath,
    normalizedMessage,
  ].join('|');

  return createHash('sha256').update(raw).digest('hex').substring(0, 32);
}
