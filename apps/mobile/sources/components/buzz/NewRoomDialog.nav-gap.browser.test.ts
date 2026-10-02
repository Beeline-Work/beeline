import { existsSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CHROME, runBrowserProof, webProofShims } from '@/test/browserProof';

/**
 * New Room's Cancel / Create Room sat flush on Android's navigation bar at
 * every font size: the shared sheet padded its bottom by exactly the bar
 * height. The proof paints the real dialog over a bar and measures the gap.
 */
function sizedTheme(mobile: string, uiSize: 'small' | 'medium' | 'large') {
  return `import { beelineThemes } from '${path.join(mobile, 'sources/buzz/groknight')}';
    import { createSizedBeelineTheme } from '${path.join(mobile, 'sources/theme')}';
    const theme = createSizedBeelineTheme(beelineThemes.bone, '${uiSize}');
    export const StyleSheet = { create: factory => (typeof factory === 'function' ? factory(theme) : factory), hairlineWidth: 1,
      absoluteFillObject: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 } };
    export const useUnistyles = () => ({ theme });`;
}

function proof(uiSize: 'small' | 'medium' | 'large', bottomInset: number) {
  const mobile = process.cwd();
  const shims = webProofShims(mobile);
  return runBrowserProof({
    entry: path.join(mobile, 'scripts/new-room-nav-gap-proof.tsx'),
    mobile,
    shims: {
      ...shims,
      // RepoPicker reaches TranscriptCard, which needs two more reanimated names.
      'react-native-reanimated': `${shims['react-native-reanimated']}
    export const FadeOut = entering;
    export const interpolateColor = (_, __, colors) => colors[0];`,
      'react-native-unistyles': sizedTheme(mobile, uiSize),
      'react-native-safe-area-context': `export const useSafeAreaInsets = () => ({ top: 24, bottom: ${bottomInset}, left: 0, right: 0 });`,
    },
    width: 390,
    height: 844,
    query: `?inset=${bottomInset}`,
  });
}

describe.skipIf(!existsSync(CHROME))('New Room footer above the Android navigation bar', () => {
  for (const uiSize of ['small', 'medium', 'large'] as const) {
    it(`leaves at least 12px between the footer and the bar at ${uiSize} font size`, async () => {
      const { result, status, stderr } = await proof(uiSize, 48);
      console.log(uiSize, result);
      expect(status, stderr).toBe(0);
      expect(result, result).toMatch(/^PASS /);
    }, 90_000);
  }

  it('keeps at least 12px below the footer when there is no navigation bar', async () => {
    const { result, status, stderr } = await proof('medium', 0);
    console.log('no-inset', result);
    expect(status, stderr).toBe(0);
    expect(result, result).toMatch(/^PASS /);
  }, 90_000);
});
