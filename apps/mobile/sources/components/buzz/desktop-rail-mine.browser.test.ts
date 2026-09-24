import { existsSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CHROME, runBrowserProof, webProofShims } from '@/test/browserProof';

/**
 * The desktop rail lists only the viewer's open corners under each Room,
 * every one of them, waiting first, with no toggle, switch, or count.
 */
describe.skipIf(!existsSync(CHROME))('desktop rail in a browser', () => {
  it("lists only the viewer's corners from the chat list", async () => {
    const mobile = process.cwd();
    const { result, status, stderr } = await runBrowserProof({
      entry: path.join(mobile, 'scripts/desktop-rail-mine-proof.tsx'),
      mobile,
      shims: webProofShims(mobile),
      width: 1280,
    });
    expect(status, stderr).toBe(0);
    expect(result).toContain('PASS');
  }, 90_000);
});
