import { existsSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CHROME, runBrowserProof, webProofShims } from '@/test/browserProof';
describe.skipIf(!existsSync(CHROME))('Room member sheets', () => {
  it('renders populated sheets and preserves manager, viewer and empty Room paths', async () => {
    const mobile = process.cwd();
    const { result, status, stderr } = await runBrowserProof({
      mobile,
      entry: path.join(mobile, 'scripts/member-sheets-browser-proof.tsx'),
      shims: webProofShims(mobile),
      width: 390,
      height: 844,
    });
    console.log(result);
    expect(status, stderr).toBe(0);
    expect(result).toMatch(/^PASS /);
  }, 90_000);
});
