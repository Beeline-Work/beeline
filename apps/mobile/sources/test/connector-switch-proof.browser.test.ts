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
        // RoomMessageVariants' imports read Node's `process` at module scope.
        head: `<style>${fontsCss(mobile)}</style><script>window.process={env:{NODE_ENV:'development'}};</script>`,
        screenshotPath: path.resolve(out!, `connector-switch-${theme}.png`),
        shims: {
          ...base,
          'react-native-unistyles': base['react-native-unistyles'].replace(
            'beelineThemes.obsidian',
            `beelineThemes.${theme}`,
          ),
          'react-native-reanimated': `${base['react-native-reanimated']}
          const builder = new Proxy({}, { get: () => () => builder });
          export const FadeOut = builder; export const FadeIn = builder; export const Layout = builder;
          export const FadeOutDown = builder; export const FadeInUp = builder; export const FadeOutUp = builder;
          export const LinearTransition = builder; export const withSpring = identity;
          export const interpolateColor = (_value, _input, output) => output[output.length - 1];`,
          // RoomMessageVariants' device-facing imports; the card under test stays real.
          'expo-router': `export const useLocalSearchParams = () => ({});
          export const router = { push() {}, back() {}, replace() {} };
          export const useRouter = () => router; export const usePathname = () => '/';`,
          '@/modal': 'export const Modal = { alert: () => undefined, confirm: async () => false };',
          '@/modal/ModalManager': 'export const Modal = { alert: () => undefined, confirm: async () => false };',
          '@/sync/storage': `const state = { settings: {}, localSettings: {} };
          export const storage = Object.assign((select) => select(state), { getState: () => state, subscribe: () => () => undefined });`,
          '@/sync/persistence': `export const loadLocalSettings = () => ({}); export const saveLocalSettings = () => {};
          export const loadSettings = () => ({ settings: {}, version: null });`,
          'react-native-view-shot': `export const captureRef = async () => ''; export default {};`,
          '@expo/vector-icons': `import React from 'react';
          export const Ionicons = (props) => React.createElement('span', { 'data-icon': props.name });`,
        },
      });
      expect(status, stderr).toBe(0);
      // The approved frames' words, read off the real card.
      expect(result).toContain('PASS');
      expect(result).toContain('action ✓ Switch account');
      expect(result).toMatch(/waiting waiting for @zeke/i);
      expect(result).toMatch(/connecting switching for @zeke/i);
      expect(result).toMatch(/outcome switched by @zeke · \d\d:\d\d/i);
      expect(result).toContain('add ✓ Add Trusty Squire');
    }
  },
  180_000,
);
