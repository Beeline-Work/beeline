import { existsSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CHROME, runBrowserProof, webProofShims } from '@/test/browserProof';

/**
 * The last app on Connect an app sat under Android's navigation bar, which
 * took the tap: the scroll content never reserved the bottom safe-area inset.
 * The proof paints the real screen with a 48px inset and a bar over it.
 */
describe.skipIf(!existsSync(CHROME))('Connect an app above the Android navigation bar', () => {
  it('scrolls its last app fully above the bar, and tapping Connect there starts the connection', async () => {
    const mobile = process.cwd();
    const { result, status, stderr } = await runBrowserProof({
      entry: path.join(mobile, 'scripts/connect-app-nav-inset-proof.tsx'),
      mobile,
      shims: {
        ...webProofShims(mobile),
        'react-native-safe-area-context':
          'export const useSafeAreaInsets = () => ({ top: 24, bottom: 48, left: 0, right: 0 });',
        'expo-router': `export const router = { back: () => undefined, replace: () => undefined, push: () => undefined };
          export const useLocalSearchParams = () => ({ workspaceId: 'workspace-1', viewerId: 'human-dani' });`,
        '@/buzz/app-sign-in': 'export const openAppSignIn = async () => undefined;',
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
