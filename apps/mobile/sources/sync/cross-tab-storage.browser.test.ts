import { existsSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CHROME, runBrowserProof, webProofShims } from '@/test/browserProof';

/**
 * J36 in Chrome: another tab's write to one stored surface or to the settings
 * reaches this tab's hot surface and Zustand settings; its removal drops only
 * that surface.
 */
describe.skipIf(!existsSync(CHROME))('another tab\'s storage writes in a browser', () => {
  it('reach this tab\'s hot surface and settings, one key at a time', async () => {
    const mobile = process.cwd();
    const { result, status, stderr } = await runBrowserProof({
      entry: path.join(mobile, 'scripts/cross-tab-storage-proof.tsx'),
      mobile,
      shims: webProofShims(mobile),
      width: 800,
      budgetMs: 10_000,
    });
    expect(status, stderr).toBe(0);
    console.log(`Demonstrated: ${result}`);
    expect(result).toMatch(/^PASS /);
  }, 120_000);
});
