import { existsSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CHROME, runBrowserProof } from '@/test/browserProof';
import { identitySettingsProofShims } from '@/test/identitySettingsProofShims';

/**
 * The Settings identity tile is the same picture-in-a-frame geometry as the
 * Workspace settings tile, measured on painted pixels. Person photos stay
 * out of the product, so the proof paints
 * a loud square through a shimmed IdentityMark — a generated creature plate
 * hides the corners this seat exists to round.
 */

const PICTURE =
  'data:image/svg+xml;base64,' +
  Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96">' +
      '<rect width="96" height="96" fill="#ffffff"/>' +
      '<rect x="0" y="0" width="28" height="28" fill="#000000"/>' +
      '<rect x="68" y="0" width="28" height="28" fill="#000000"/>' +
      '<rect x="0" y="68" width="28" height="28" fill="#000000"/>' +
      '<rect x="68" y="68" width="28" height="28" fill="#000000"/>' +
      '</svg>',
  ).toString('base64');

describe.skipIf(!existsSync(CHROME))('Settings identity picture seat', () => {
    it('seats the person identity tile at the derived inner radius', async () => {
    const mobile = process.cwd();
    const { result, status, stderr } = await runBrowserProof({
      entry: path.join(mobile, 'scripts/identity-picture-seat-proof.tsx'),
      mobile,
      shims: identitySettingsProofShims(mobile),
      width: 390,
      height: 844,
      query: `?picture=${encodeURIComponent(PICTURE)}`,
    });
    expect(status, stderr).toBe(0);
    expect(result).toContain('settings-identity: ');
    expect(result).not.toContain('NOT RENDERED');
    expect(result).not.toContain('NOT SEATED');
    expect(result.startsWith('PASS'), result).toBe(true);
  }, 120_000);
});
