import { existsSync } from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
import { CHROME, runBrowserProof, webProofShims } from '@/test/browserProof';

it.skipIf(!existsSync(CHROME))(
  'opens the real tool-output sheet wide, reports its size once, and paints every glyph without a DOM prop error',
  async () => {
    const mobile = process.cwd();
    const { result, status, stderr } = await runBrowserProof({
      entry: path.join(mobile, 'scripts/tool-output-sheet-proof.tsx'),
      mobile,
      shims: webProofShims(mobile),
      width: 1440,
      height: 500,
    });
    expect(status, stderr).toBe(0);
    expect(result).toBe('PASS');
  },
  90_000,
);
