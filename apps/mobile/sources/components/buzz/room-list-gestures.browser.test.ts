import { existsSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CHROME, runBrowserProof, webProofShims } from '@/test/browserProof';

describe.skipIf(!existsSync(CHROME))('Room list gestures in a browser', () => {
  it.each([false, true])(
    'exercises the real recognizer (baseline=%s)',
    async (baseline) => {
      const mobile = process.cwd();
      const { result, status, stderr } = await runBrowserProof({
        entry: path.join(mobile, 'scripts/room-list-gestures-proof.tsx'),
        mobile,
        shims: webProofShims(mobile),
        width: 390,
        query: baseline ? '?baseline' : '',
      });
      console.log(result);
      expect(status, stderr).toBe(0);
      if (baseline) {
        expect(result).toContain('FAIL Reproduction room-list-diagonal');
        expect(result).toContain('FAIL Reproduction room-list-coast');
        expect(result).toContain('RESULT FAIL');
      } else {
        expect(result).toContain('RESULT PASS');
        expect(result).not.toContain('FAIL');
      }
    },
    90_000,
  );
});
