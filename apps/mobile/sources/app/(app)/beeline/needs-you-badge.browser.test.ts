import { existsSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CHROME, runBrowserProof, webProofShims } from '@/test/browserProof';

/**
 * The tray badge and the Tray list read one store. In Chrome, the badge and
 * the list are read back after a clear, a failed clear, a gap reload and an
 * account switch; they must agree at every step.
 */
function shims(mobile: string): Record<string, string> {
  return {
    ...webProofShims(mobile),
    'expo-router': `import React from 'react';
    export const useFocusEffect = (effect) => React.useEffect(effect, [effect]);
    export const useLocalSearchParams = () => ({ communityId: 'workspace-1' });
    export const useRouter = () => ({ back: () => undefined, push: () => undefined, replace: () => undefined });`,
    '@/sync/transport/monolith-operation': `const now = Math.floor(Date.now() / 1000);
    const item = (id, text, age) => ({ messageId: id, workspaceId: 'workspace-1', roomId: 'room-' + id,
      roomName: 'release', roomKind: 'room', text, createdAt: now - age });
    const server = window.__server = {
      viewer: 'alice', failClear: false, countDelayMs: 0,
      items: {
        alice: [item('item-a1', 'Ship tonight?', 300), item('item-a2', 'Review the copy?', 200),
          item('item-a3', 'Which relay?', 100)],
        bob: [item('item-b1', 'Bob, sign the release?', 50)],
      },
    };
    const mine = () => server.items[server.viewer];
    export const monolithPhoneOperation = async (name, input) => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      if (name === 'readNeedsYou') return { items: mine().map((entry) => ({ ...entry })) };
      if (name === 'readTray') return { needs: { items: mine().map((entry) => ({ ...entry })) },
        saved: { bookmarks: [] } };
      if (name === 'countNeedsYou') {
        const viewer = server.viewer;
        await new Promise((resolve) => setTimeout(resolve, server.countDelayMs));
        return { count: server.items[viewer].length };
      }
      if (name === 'clearNeedsYou') {
        if (server.failClear) throw new Error('Clear failed');
        server.items[server.viewer] = mine().filter((entry) => entry.messageId !== input.messageId);
        return {};
      }
      if (name === 'listMessageBookmarks') return { bookmarks: [] };
      throw new Error('unexpected ' + name);
    };`,
    '@/sync/transport/live-connection': `const listeners = new Set();
    window.__emit = (live) => { for (const listener of [...listeners]) listener({ monolithLive: live }); };
    export const sharedLiveConnection = () => ({
      register: async (_rooms, listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    });`,
    // The session's identity listener calls resetClientState on a switch; this does the same.
    '@/auth/buzz-identity-storage': `import { resetClientState } from '@/sync/client-reset';
    window.__switchViewer = (viewer) => { window.__server.viewer = viewer; resetClientState(); };
    export const getEffectiveRelayUrl = async () => 'https://relay.test';
    export const loadBuzzIdentity = async () => ({ publicKey: window.__server.viewer });`,
    '@/sync/transport/room-view-client': `export class RoomViewClient {
      async workspaces() { return { workspaces: [] }; }
      async workspace() { return { workspace: { id: 'workspace-1', name: 'Clover Workspace' } }; }
    }`,
    '@/push/push-room-prefetch': 'export const prefetchPushRoom = () => undefined;',
    '@/buzz/community-storage': `export const loadActiveCommunityId = async () => null;
    export const watchActiveCommunityId = (_pubkey, listener) => {
      void Promise.resolve(null).then(listener);
      return () => undefined;
    };`,
    '@/components/DesktopRoomInspector': 'export const DesktopRoomInspector = () => null;',
    'react-native-gesture-handler': 'export const Swipeable = ({ children }) => children;',
    '@expo/vector-icons': `import React from 'react';
    export const Ionicons = (props) => React.createElement('span', { 'data-icon': props.name });`,
  };
}

describe.skipIf(!existsSync(CHROME))('needs-you badge beside the Tray in a browser', () => {
  it('matches the list after a clear, a failed clear, a gap and an account switch', async () => {
    const mobile = process.cwd();
    const { result, status, stderr } = await runBrowserProof({
      entry: path.join(mobile, 'scripts/needs-you-badge-proof.tsx'),
      mobile,
      shims: shims(mobile),
      width: 1440,
      budgetMs: 20_000,
      ...(process.env.BEELINE_DESIGN_PROOF_DIR
        ? { screenshotPath: path.join(process.env.BEELINE_DESIGN_PROOF_DIR, 'needs-you-badge.png') }
        : {}),
    });
    expect(status, stderr).toBe(0);
    console.log(`Demonstrated: ${result}`);
    expect(result).toMatch(/^PASS /);
  }, 120_000);
});
