import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getErrorFingerprint, generalizeFilePath, generalizeErrorMessage } from '../src/learning/fingerprint.js';

describe('Learning Engine — Error Fingerprinting', () => {
  describe('getErrorFingerprint', () => {
    it('should produce same fingerprint for same error pattern in different files', () => {
      const f1 = getErrorFingerprint({
        errorCode: 'TS2307', filePath: 'app/api/storms/route.ts',
        errorMessage: "Module './StormMap' not found", techStack: ['typescript', 'nextjs']
      });
      const f2 = getErrorFingerprint({
        errorCode: 'TS2307', filePath: 'app/api/alerts/route.ts',
        errorMessage: "Module './AlertMap' not found", techStack: ['typescript', 'nextjs']
      });
      assert.equal(f1, f2, 'Same error pattern should produce same fingerprint');
    });

    it('should produce different fingerprints for different error codes', () => {
      const f1 = getErrorFingerprint({
        errorCode: 'TS2307', filePath: 'app/api/storms/route.ts',
        errorMessage: "Module not found", techStack: ['typescript']
      });
      const f2 = getErrorFingerprint({
        errorCode: 'TS2339', filePath: 'app/api/storms/route.ts',
        errorMessage: "Property 'name' does not exist", techStack: ['typescript']
      });
      assert.notEqual(f1, f2, 'Different errors should have different fingerprints');
    });

    it('should return exactly 32 lowercase hex characters', () => {
      const fp = getErrorFingerprint({
        errorCode: 'TS2307', filePath: 'test.ts',
        errorMessage: 'Module not found', techStack: ['typescript']
      });
      assert.equal(fp.length, 32);
      assert.match(fp, /^[0-9a-f]{32}$/);
    });

    it('should be order-independent for tech stack tags', () => {
      const f1 = getErrorFingerprint({
        errorCode: 'TS2307', filePath: 'test.ts',
        errorMessage: 'test', techStack: ['nextjs', 'typescript']
      });
      const f2 = getErrorFingerprint({
        errorCode: 'TS2307', filePath: 'test.ts',
        errorMessage: 'test', techStack: ['typescript', 'nextjs']
      });
      assert.equal(f1, f2, 'Tech stack order should not matter');
    });
  });

  describe('generalizeFilePath', () => {
    it('should wildcard entity-name directory segments', () => {
      const result = generalizeFilePath('app/api/storms/route.ts');
      assert.ok(result.includes('*'), 'Should contain wildcard');
      assert.ok(result.includes('route.ts'), 'Should keep filename');
      assert.ok(result.includes('app'), 'Should keep framework dir');
      assert.ok(result.includes('api'), 'Should keep framework dir');
    });

    it('should keep framework directories intact', () => {
      const result = generalizeFilePath('src/utils/helpers.ts');
      assert.ok(!result.includes('*'), 'All segments are framework dirs — no wildcards');
      assert.equal(result, 'src/utils/helpers.ts');
    });

    it('should handle Windows backslashes', () => {
      const result = generalizeFilePath('app\\api\\storms\\route.ts');
      assert.ok(!result.includes('\\'), 'Should normalize to forward slashes');
    });
  });

  describe('generalizeErrorMessage', () => {
    it('should replace quoted strings with *', () => {
      const result = generalizeErrorMessage("Module './StormMap' not found");
      assert.ok(!result.includes('StormMap'), 'Should remove specific names');
      assert.ok(result.includes('Module'), 'Should keep structural words');
    });

    it('should replace double-quoted strings', () => {
      const result = generalizeErrorMessage('Cannot find module "react-query"');
      assert.ok(!result.includes('react-query'));
    });

    it('should keep structural TypeScript keywords', () => {
      const result = generalizeErrorMessage("Property 'name' does not exist on type 'Storm'");
      assert.ok(result.includes('Property'), 'Should keep Property');
      assert.ok(result.includes('does not exist'), 'Should keep structural phrase');
    });
  });
});
