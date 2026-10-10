import { existsSync } from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
import { CHROME, runBrowserProof, webProofShims } from './browserProof';

it.skipIf(!existsSync(CHROME))(
  "a sign-out in another tab drops this tab's surface copies",
  async () => {
    const mobile = process.cwd();
    const proof = await runBrowserProof({
      entry: path.join(mobile, 'scripts/cross-tab-signout-proof.ts'),
      mobile,
      shims: webProofShims(mobile),
      width: 800,
    });
    console.log(proof.result);
    expect(proof.status, proof.stderr).toBe(0);
    expect(proof.result).toMatch(/^PASS/);
  },
  120_000,
);
