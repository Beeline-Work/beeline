import { existsSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CHROME, runBrowserProof, webProofShims } from '@/test/browserProof';

/**
 * Tray, Workbench and Corners are sibling section pages, so their top headers
 * must read as one: the back chevron at the same inset, the same eyebrow over
 * the same title, and the same divider under it. Workspace settings and
 * What's New carry no eyebrow but share the rest. Each page is painted for
 * real in a phone-width browser and measured.
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
    '@/sync/transport/monolith-operation': `export const monolithPhoneOperation = async (name) =>
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
  it('draws Tray, Workbench and Corners headers the same way', async () => {
    const tray = await measure('tray');
    const workbench = await measure('workbench');
    const corners = await measure('corners');
    const { page: _tray, ...trayHeader } = tray;
    for (const other of [workbench, corners]) {
      const { page, ...header } = other;
      expect(header, `${String(page)} header differs from Tray`).toEqual(trayHeader);
    }
    expect(trayHeader.eyebrowAboveTitle).toBe(true);
    expect(trayHeader.divider).toBe('1px solid');
    const { eyebrowFont: _font, eyebrowAboveTitle: _above, ...shared } = trayHeader;
    for (const page of ['workspace', 'changelog']) {
      const { page: _page, ...header } = await measure(page);
      expect(header, `${page} header differs from Tray`).toEqual(shared);
    }
  }, 300_000);
});
