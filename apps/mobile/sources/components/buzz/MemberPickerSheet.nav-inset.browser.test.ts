import { existsSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CHROME, runBrowserProof, webProofShims } from '@/test/browserProof';

/**
 * The member picker spilled under Android's 3-button navigation bar and its
 * Add button only appeared once something was checked, below the screen: the
 * picker scrolled its own body, so the sheet never budgeted the bottom inset.
 * The proof paints the real picker with a 48px inset and a bar over it.
 */
describe.skipIf(!existsSync(CHROME))('Member picker above the Android navigation bar', () => {
  it('keeps Add on screen above the bar, tapping it adds the checked member, and the list ends above the bar', async () => {
    const mobile = process.cwd();
    const { result, status, stderr } = await runBrowserProof({
      entry: path.join(mobile, 'scripts/member-picker-nav-inset-proof.tsx'),
      mobile,
      shims: {
        ...webProofShims(mobile),
        'react-native-safe-area-context':
          'export const useSafeAreaInsets = () => ({ top: 24, bottom: 48, left: 0, right: 0 });',
      },
      width: 390,
      height: 844,
    });
    console.log(result);
    expect(status, stderr).toBe(0);
    expect(result, result).toMatch(/^PASS /);
  }, 90_000);
});
