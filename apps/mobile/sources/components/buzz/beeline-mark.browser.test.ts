import { existsSync } from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
import { CHROME, runBrowserProof, webProofShims } from '@/test/browserProof';

it.skipIf(!existsSync(CHROME))(
  'paints the Beeline logo as one named image with no non-boolean DOM prop',
  async () => {
    const mobile = process.cwd();
    const { result, status, stderr } = await runBrowserProof({
      entry: path.join(mobile, 'scripts/beeline-mark-proof.tsx'),
      mobile,
      shims: webProofShims(mobile),
      width: 320,
      height: 200,
    });
    expect(status, stderr).toBe(0);
    expect(result).toBe('PASS');
  },
  90_000,
);
