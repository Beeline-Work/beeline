import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
import { CHROME, runBrowserProof, webProofShims } from '@/test/browserProof';

/**
 * Paints `scripts/agent-command-card-proof.tsx`: the real AgentCommandCard
 * from a server-shaped row. Set AGENT_COMMAND_CARD_SHOTS to a directory to
 * keep collapsed.png and expanded.png.
 */
function fontsCss(mobile: string) {
  return [
    'SpaceGrotesk-Regular',
    'SpaceGrotesk-Medium',
    'SpaceGrotesk-SemiBold',
    'IBMPlexMono-Regular',
    'IBMPlexMono-SemiBold',
  ]
    .map((font) => path.join(mobile, 'sources/assets/fonts', `${font}.ttf`))
    .filter(existsSync)
    .map(
      (file) =>
        `@font-face{font-family:'${path.basename(file, '.ttf')}';src:url(data:font/ttf;base64,${readFileSync(file).toString('base64')})}`,
    )
    .join('');
}

it.skipIf(!existsSync(CHROME)).each(['', '?expanded'])(
  'paints an agent report record card collapsed and expands it on a header tap (%s)',
  async (query) => {
    const mobile = process.cwd();
    const base = webProofShims(mobile);
    const shots = process.env.AGENT_COMMAND_CARD_SHOTS;
    const { result, status, stderr } = await runBrowserProof({
      entry: path.join(mobile, 'scripts/agent-command-card-proof.tsx'),
      mobile,
      width: 400,
      height: 280,
      query,
      // RoomMessageVariants' imports read Node's `process` at module scope.
      head: `<style>${fontsCss(mobile)}</style><script>window.process={env:{NODE_ENV:'development'}};</script>`,
      ...(shots
        ? { screenshotPath: path.resolve(shots, `${query ? 'expanded' : 'collapsed'}.png`) }
        : {}),
      shims: {
        ...base,
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
        '@/modal/ModalManager':
          'export const Modal = { alert: () => undefined, confirm: async () => false };',
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
    expect(result).toBe('PASS');
  },
  90_000,
);
