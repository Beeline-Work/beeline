import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CHROME, runBrowserProof, webProofShims } from '@/test/browserProof';

/**
 * On a phone, a Room list card's space above the Room name matches the space
 * below its last line within one point; the desktop row keeps its spacing.
 */
describe.skipIf(!existsSync(CHROME))('Room list card spacing in a browser', () => {
  const mobile = process.cwd();
  const shims = () => {
    const fonts = Object.fromEntries(
      ['SpaceGrotesk-Regular', 'SpaceGrotesk-Medium', 'SpaceGrotesk-SemiBold'].map((font) => [
        font,
        readFileSync(path.join(mobile, 'sources/assets/fonts', `${font}.ttf`)).toString('base64'),
      ]),
    );
    return {
      ...webProofShims(mobile),
      'room-card-fonts': `export default ${JSON.stringify(fonts)};`,
    };
  };

  it('balances the space above the Room name and below the last line on mobile', async () => {
    const { result, status, stderr } = await runBrowserProof({
      entry: path.join(mobile, 'scripts/room-card-spacing-proof.tsx'),
      mobile,
      shims: shims(),
      width: 390,
    });
    expect(status, stderr).toBe(0);
    expect(result).toMatch(/^PASS\n/);
  }, 90_000);

  it('leaves the desktop row spacing unchanged', async () => {
    const { result, status, stderr } = await runBrowserProof({
      entry: path.join(mobile, 'scripts/room-card-spacing-proof.tsx'),
      mobile,
      shims: shims(),
      width: 1280,
    });
    expect(status, stderr).toBe(0);
    expect(result).toBe(
      [
        'DESKTOP',
        'one-line: above=23.79 below=34.50 diff=-10.72',
        'two-line: above=23.79 below=23.50 diff=0.28',
        'corners: above=23.79 below=30.50 diff=-6.72',
        'message: above=26.29 below=29.50 diff=-3.22',
      ].join('\n'),
    );
  }, 90_000);
});
