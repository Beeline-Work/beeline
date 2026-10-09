import { existsSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CHROME, runBrowserProof, webProofShims } from '@/test/browserProof';

/**
 * Saved is filled from a gesture, and the gesture is not the same one on
 * both surfaces: a phone long-presses a message, a desktop pointer reveals the
 * message's action strip. The empty state used to name both at once, so
 * whichever reader was looking got one instruction that did not work.
 */
function dataShims(
  mobile: string,
  withBookmark = false,
  link: 'workspace' | 'active' | 'none' = 'workspace',
): Record<string, string> {
  return {
    ...webProofShims(mobile),
    'expo-router': `import React from 'react';
    export const useFocusEffect = (effect) => React.useEffect(effect, [effect]);
    export const useLocalSearchParams = () => (${link === 'workspace' ? "{ communityId: 'workspace-1' }" : '{}'});
    export const useRouter = () => ({
      back: () => undefined,
      push: () => undefined,
      replace: (href) => { window.__replaced = href; },
    });`,
    '@/sync/transport/monolith-operation': withBookmark
      ? `export const monolithPhoneOperation = async (name) => name === 'readNeedsYou' ? { items: [] } : ({ bookmarks: [{
          messageId: 'msg-1', workspaceId: 'workspace-1', roomId: 'corner-1',
          roomName: 'Fix fixture', roomKind: 'corner',
          messageCreatedAt: Math.floor(Date.now() / 1000) - 7200,
          bookmarkedAt: Math.floor(Date.now() / 1000) - 120,
          available: true, author: { name: 'Avery' }, text: 'The bookmarked line.'
        }] });`
      : `export const monolithPhoneOperation = async (name) =>
          name === 'readNeedsYou' ? { items: [] } : { bookmarks: [] };`,
    '@/sync/transport/room-view-client': `export class RoomViewClient {
      async workspaces() { return { workspaces: ${link === 'active' ? "[{ id: 'workspace-0' }, { id: 'workspace-1' }]" : '[]'} }; }
      async workspace() { return { workspace: { id: 'workspace-1', name: 'Clover Workspace' } }; }
    }`,
    '@/push/push-room-prefetch': 'export const prefetchPushRoom = () => undefined;',
    '@/buzz/community-storage': `export const loadActiveCommunityId = async () => ${link === 'active' ? "'workspace-1'" : 'null'};`,
    '@/auth/buzz-identity-storage': `export const getEffectiveRelayUrl = async () => 'https://relay.test';
    export const loadBuzzIdentity = async () => ${link === 'workspace' ? 'null' : "({ publicKey: 'viewer' })"};`,
    '@/components/DesktopRoomInspector': 'export const DesktopRoomInspector = () => null;',
    'react-native-gesture-handler': 'export const Swipeable = ({ children }) => children;',
    '@expo/vector-icons': `import React from 'react';
    export const Ionicons = (props) => React.createElement('span', { 'data-icon': props.name });`,
  };
}

describe.skipIf(!existsSync(CHROME))('tray empty states in a browser', () => {
  it.each([
    { surface: 'desktop', width: 1440, reads: 'Hover a message and press its bookmark mark.' },
    { surface: 'phone', width: 390, reads: 'Long press a message and pick Bookmark.' },
  ])(
    'tells a $surface reader: $reads',
    async ({ surface, width, reads }) => {
      const mobile = process.cwd();
      const { result, status, stderr } = await runBrowserProof({
        entry: path.join(mobile, 'scripts/tray-empty-proof.tsx'),
        mobile,
        shims: dataShims(mobile),
        width,
        query: `?surface=${surface}`,
      });
      expect(status, stderr).toBe(0);
      expect(result).toContain('PASS');
      expect(result).toContain(reads);
    },
    90_000,
  );
});

describe.skipIf(!existsSync(CHROME))('bookmark rows in a browser', () => {
  it.each([
    { surface: 'desktop', width: 1440 },
    { surface: 'phone', width: 390 },
  ])(
    'places one save age at the right on $surface',
    async ({ surface, width }) => {
      const mobile = process.cwd();
      const { result, status, stderr } = await runBrowserProof({
        entry: path.join(mobile, 'scripts/tray-empty-proof.tsx'),
        mobile,
        shims: dataShims(mobile, true),
        width,
        query: `?surface=${surface}&mode=row`,
      });
      expect(status, stderr).toBe(0);
      expect(result).toContain('PASS');
      expect(result).toContain('SAVED 2m');
    },
    90_000,
  );
});

describe.skipIf(!existsSync(CHROME))('Tray link without a communityId in a browser', () => {
  it.each([
    { link: 'active' as const, reads: 'Tray of workspace-1' },
    { link: 'none' as const, reads: 'No Workspace to show' },
  ])(
    'paints within 5 s: $reads',
    async ({ link, reads }) => {
      const mobile = process.cwd();
      const { result, status, stderr } = await runBrowserProof({
        entry: path.join(mobile, 'scripts/tray-empty-proof.tsx'),
        mobile,
        shims: dataShims(mobile, true, link),
        width: 390,
        query: `?surface=phone&mode=no-link`,
      });
      expect(status, stderr).toBe(0);
      expect(result).toContain('PASS');
      expect(result).toContain(reads);
    },
    90_000,
  );
});
