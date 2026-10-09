import { existsSync, readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { expect, it } from 'vitest';
import { CHROME, runBrowserProof, webProofShims } from './browserProof';

/**
 * Captures `scripts/connector-switch-proof.tsx` — the "switch Trusty Squire
 * account" card at phone width — in Obsidian and Bone. It writes files, so it
 * runs only when asked:
 *
 *   SWITCH_PROOF_OUT=../../.verification/connector-switch \
 *     npx vitest run sources/test/connector-switch-proof.browser
 */
const out = process.env.SWITCH_PROOF_OUT;

function fontsCss(mobile: string) {
  return ['SpaceGrotesk-Regular', 'SpaceGrotesk-Medium', 'SpaceGrotesk-SemiBold', 'IBMPlexMono-Regular', 'IBMPlexMono-SemiBold']
    .map((font) => path.join(mobile, 'sources/assets/fonts', `${font}.ttf`))
    .filter(existsSync)
    .map((file) => `@font-face{font-family:'${path.basename(file, '.ttf')}';src:url(data:font/ttf;base64,${readFileSync(file).toString('base64')})}`)
    .join('');
}

it.skipIf(!out || !existsSync(CHROME))(
  'captures the switch-account card in Obsidian and Bone',
  async () => {
    const mobile = process.cwd();
    await mkdir(out!, { recursive: true });
    for (const theme of ['obsidian', 'bone'] as const) {
      const base = webProofShims(mobile);
      const { result, status, stderr } = await runBrowserProof({
        entry: path.join(mobile, 'scripts/connector-switch-proof.tsx'),
        mobile,
        width: 390,
        height: 1500,
        headCss: fontsCss(mobile),
        screenshotPath: path.resolve(out!, `connector-switch-${theme}.png`),
        shims: {
          ...base,
          'react-native-unistyles': base['react-native-unistyles'].replace(
            'beelineThemes.obsidian',
            `beelineThemes.${theme}`,
          ),
          'react-native-reanimated': `${base['react-native-reanimated']}
          export const FadeOut = entering;
          export const interpolateColor = (_value, _input, output) => output[output.length - 1];`,
        },
      });
      expect(status, stderr).toBe(0);
      expect(result).toContain('PASS');
    }
  },
  180_000,
);
