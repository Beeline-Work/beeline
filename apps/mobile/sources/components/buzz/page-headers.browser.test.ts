import { existsSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CHROME, runBrowserProof, webProofShims } from '@/test/browserProof';

/**
 * The Corners header is the reference for every ordinary section page,
 * Workbench included. Each page is painted in a phone-width browser and
 * measured.
 */
function shims(mobile: string): Record<string, string> {
  return {
    ...webProofShims(mobile),
    'expo-router': `import React from 'react';
    export const useFocusEffect = (effect) => React.useEffect(effect, [effect]);
    export const useLocalSearchParams = () => ({ communityId: 'workspace-1',
      roomId: '11111111-1111-4111-8111-111111111111' });
    export const useRouter = () => ({ back: () => undefined, push: () => undefined });
    export const router = { push: () => undefined, replace: () => undefined, back: () => undefined };`,
    '@/sync/transport/monolith-operation': `export class MonolithPhoneOperationError extends Error {}
    export const monolithPhoneOperation = async (name) =>
      name === 'readNeedsYou' ? { items: [] } : { bookmarks: [] };
    export const phoneOperationFailureReason = (reason) => String(reason);`,
    '@/sync/transport/room-view-client': `export class RoomViewClient {
      async corners(_id, options) { return globalThis.cornerSectionsView(options); }
    }`,
    '@/sync/transport': `export class BuzzRigTransport {
      async ensureClient() { return { surfaceSubscribe: async () => () => undefined }; }
    }`,
    '@/auth/buzz-identity-storage': `export const getEffectiveRelayUrl = async () => 'https://relay.test';
    export const loadBuzzIdentity = async () => ({ publicKey: '${'a'.repeat(64)}' });`,
    '@/buzz/surface-storage': `export const surfaceAddress = () => 'address';
    export const mobileSurfaceCache = { read: async () => null, write: async () => undefined };`,
    '@/buzz/workbench-source': `export const getWorkbenchSource = () => ({
      readWorkbench: () => new Promise(() => undefined) });`,
    '@/buzz/wallet-source': 'export const getWalletSource = () => ({});',
    '@/buzz/wallet-workspace': 'export const resolveWalletWorkspaceId = () => undefined;',
    '@/buzz/runtime-config': `export const getBuzzRuntimeConfig = () => ({ monolithUrl: 'https://relay.test' });`,
    '@/components/buzz/CommunityRail': `export const BuzzCommunityShell = ({ children }) => children;`,
    '@/components/buzz/NewCornerDialog': 'export const NewCornerDialog = () => null;',
    '@/components/DesktopRoomInspector': 'export const DesktopRoomInspector = () => null;',
    'react-native-gesture-handler': 'export const Swipeable = ({ children }) => children;',
    '@/buzz/avatar-upload': 'export const pickAndUploadAvatar = async () => undefined;',
    '@/modal': 'export const Modal = { alert: () => undefined, confirm: async () => false };',
    '@/changelog': `export const getChangelogEntries = () => [];
    export const getLatestTitle = () => undefined;
    export const setLastViewedTitle = () => undefined;`,
    '@/text': `const copy = { 'navigation.whatsNew': "What's New", 'common.back': 'Back' };
    export const t = (key) => copy[key] ?? key;`,
    '@expo/vector-icons': `import React from 'react';
    export const Ionicons = (props) => React.createElement('span', { 'data-icon': props.name });`,
  };
}

async function measure(page: string): Promise<Record<string, unknown>> {
  const mobile = process.cwd();
  const { result, status, stderr } = await runBrowserProof({
    entry: path.join(mobile, 'scripts/page-headers-proof.tsx'),
    mobile,
    shims: shims(mobile),
    width: 390,
    query: `?page=${page}`,
  });
  expect(status, stderr).toBe(0);
  if (process.env.PRINT_PROOF) console.log(result);
  expect(result.startsWith('{'), result).toBe(true);
  return JSON.parse(result) as Record<string, unknown>;
}

describe.skipIf(!existsSync(CHROME))('section page headers in a browser', () => {
  it('aligns ordinary section page headers with Corners', async () => {
    const { page: _corners, headerText, ...corners } = await measure('corners');
    // No corner count beside the add button: the header says only where you are.
    expect(headerText).toEqual(['#alpha', 'Corners']);
    // The Corners header as it stood before the pages were aligned to it.
    expect(corners).toMatchObject({
      backLeft: 8,
      backSize: 44,
      titleLeft: 52,
      headerMinHeight: '66px',
      divider: '1px solid',
      titleFont: '22px SpaceGrotesk-Medium',
      eyebrowFont: '13px SpaceGrotesk-Regular',
      eyebrowAboveTitle: true,
    });
    const { eyebrowFont: _font, eyebrowAboveTitle: _above, ...frame } = corners;
    for (const page of ['tray', 'workbench', 'workspace', 'changelog']) {
      const { page: _page, ...header } = await measure(page);
      // Pages without an eyebrow or trailing text share everything else.
      const expected = {
        ...frame,
        ...('eyebrowFont' in header
          ? { eyebrowFont: corners.eyebrowFont, eyebrowAboveTitle: true }
          : {}),
        ...('trailingFont' in header ? { trailingFont: '13px rgb(131, 131, 141) right' } : {}),
      };
      expect(header, `${page} header differs from Corners`).toEqual(expected);
    }
  }, 300_000);
});
