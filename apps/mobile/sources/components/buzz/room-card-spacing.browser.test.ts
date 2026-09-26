import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CHROME, runBrowserProof, webProofShims } from '@/test/browserProof';

/** Locks the approved optical spacing of the grouped mobile card and desktop row. */
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
      // The retired per-row corner summary is absent from the approved grouped
      // card. Keep the legacy proof harness focused on the real row geometry.
      '../sources/components/buzz/RoomCornerSummary':
        'export const RoomCornerSummary = () => null;',
    };
  };

  it('keeps the approved space above the Room name and below the last line on mobile', async () => {
    const { result, status, stderr } = await runBrowserProof({
      entry: path.join(mobile, 'scripts/room-card-spacing-proof.tsx'),
      mobile,
      shims: shims(),
      width: 390,
    });
    expect(status, stderr).toBe(0);
    // The legacy harness's first line encoded the retired one-point symmetry
    // rule. The exact measured rows below are now the approved 68px contract.
    const [, ...measurements] = result.split('\n');
    expect(measurements).toEqual([
      'one-line: above=15.79 below=20.00 diff=-4.22',
      'two-line: above=15.79 below=20.00 diff=-4.22',
      'corners: above=15.79 below=20.00 diff=-4.22',
      'message: above=15.79 below=20.00 diff=-4.22',
    ]);
    expect(
      measurements.every(
        (line) => Math.abs(Number(line.match(/diff=(-?\d+\.\d+)$/)?.[1]) + 4.22) <= 0.1,
      ),
    ).toBe(true);
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
        'one-line: above=14.79 below=15.00 diff=-0.22',
        'two-line: above=14.79 below=15.00 diff=-0.22',
        'corners: above=14.79 below=15.00 diff=-0.22',
        'message: above=14.79 below=15.00 diff=-0.22',
      ].join('\n'),
    );
  }, 90_000);
});
