import { existsSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CHROME, runBrowserProof, webProofShims } from '@/test/browserProof';

/**
 * Android's navigation bar covers the bottom safe-area inset and takes taps
 * there. The proof paints the real Workbench with a 48px inset and a bar over
 * it, scrolls to the last app row, and taps it.
 */
describe.skipIf(!existsSync(CHROME))('Workbench above the Android navigation bar', () => {
  it('scrolls its last app row fully above the bar, and a tap there opens that app', async () => {
    const mobile = process.cwd();
    const { result, status, stderr } = await runBrowserProof({
      entry: path.join(mobile, 'scripts/workbench-nav-inset-proof.tsx'),
      mobile,
      shims: {
        ...webProofShims(mobile),
        'react-native-safe-area-context':
          'export const useSafeAreaInsets = () => ({ top: 24, bottom: 48, left: 0, right: 0 });',
        'expo-router': `import React from 'react';
          export const router = { back: () => undefined, replace: () => undefined, push: (href) => window.__pushes.push(href) };
          export const useFocusEffect = (effect) => React.useEffect(effect, [effect]);
          export const useLocalSearchParams = () => ({ workspaceId: 'workspace-1', viewerId: 'human-dani' });`,
        '@/utils/responsive': 'export const useIsDesktop = () => false;',
        '@expo/vector-icons': 'export const Ionicons = () => null;',
        '@/buzz/runtime-config':
          "export const getBuzzRuntimeConfig = () => ({ monolithUrl: 'https://server.test', monolithEnabled: true });",
      },
      width: 390,
      height: 844,
    });
    console.log(result);
    expect(status, stderr).toBe(0);
    expect(result, result).toMatch(/^PASS /);
  }, 90_000);
});
