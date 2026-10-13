import { afterEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  roomListener: null as null | ((event: unknown) => void),
  connectedListener: null as null | (() => void),
  send: vi.fn(),
  permission: vi.fn(async () => true),
  identityChange: null as null | (() => void),
  workspacesCalls: 0,
  acquired: [] as string[],
  roomName: 'Test room',
  cornerId: 'corner-1',
  forced: 0,
  released: 0,
}));
vi.mock('@/utils/isTauri', () => ({ isTauri: () => true }));
vi.mock('@/auth/buzz-identity-storage', () => ({
  loadBuzzIdentity: async () => ({ publicKey: 'test-viewer', secretKey: new Uint8Array(32) }),
  getEffectiveRelayUrl: async () => 'https://test.invalid',
}));
vi.mock('@/sync/client-reset', () => ({
  subscribeClientReset: (listener: () => void) => {
    fixture.identityChange = listener;
    return () => {
      fixture.identityChange = null;
    };
  },
}));
vi.mock('@/buzz/open-room-tracker', () => ({ getOpenBuzzChannelId: () => null }));
vi.mock('@/buzz/managed-identity-surface', () => ({
  readManagedIdentity: async () => ({ pushLevel: 'default' }),
}));
vi.mock('./buzz-push-registration', () => ({ getBuzzPushEnabled: async () => true }));
vi.mock('./push-level-storage', () => ({ loadStoredPushLevel: async () => 'default' }));
vi.mock('@/sync/transport/monolith-operation', () => ({
  monolithPhoneOperation: async () => ({ pushLevel: 'default' }),
}));
vi.mock('@/sync/transport', () => ({
  BuzzRigTransport: class {
    ensureClient() {
      return Promise.resolve({
        surfaceSubscribe: async (filters: unknown[], listener: (event: unknown) => void) => {
          if (JSON.stringify(filters).includes('room-1')) fixture.roomListener = listener;
          return () => {
            if (fixture.roomListener === listener) fixture.roomListener = null;
          };
        },
      });
    }
    subscribeConnected(listener: () => void) {
      fixture.connectedListener = listener;
      return () => {
        if (fixture.connectedListener === listener) fixture.connectedListener = null;
      };
    }
  },
  RoomViewClient: class {
    workspaces() {
      fixture.workspacesCalls += 1;
      return Promise.resolve({ workspaces: [{ id: 'workspace-1' }] });
    }
    corners() {
      return Promise.resolve({ corners: [{ corner: { id: fixture.cornerId, name: 'Test corner' } }] });
    }
  },
}));
// The app-level Room list store hands the notifier each Workspace's Rooms,
// and the corner store their corner counts, as the real list store fills it.
vi.mock('@/buzz/chat-list-store', async () => {
  const { applyChatListCorners } = await import('@/buzz/room-corner-store');
  return {
    acquireChatList: (key: { workspaceId: string }) => {
      fixture.acquired.push(key.workspaceId);
      applyChatListCorners([{ room: { id: 'room-1' } as never, cornerCount: 1 }], -1);
      return {
        current: () => ({
          chats: [
            {
              room: { id: 'room-1', name: fixture.roomName },
              directMessage: {
                peer: { pubkey: 'other', name: 'Test sender', handle: 'tester@example.com' },
              },
              unread: true,
            },
          ],
          watchFilters: [{ '#h': ['room-1'] }],
        }),
        subscribe: () => () => undefined,
        force: () => {
          fixture.forced += 1;
        },
        release: () => {
          fixture.released += 1;
        },
      };
    },
  };
});
vi.mock('@tauri-apps/plugin-notification', () => ({
  isPermissionGranted: fixture.permission,
  requestPermission: vi.fn(async () => 'granted'),
  sendNotification: fixture.send,
}));

import { startDesktopNotifications } from './desktop-notifications';
import { acceptCornerStatusFrame, resetRoomCornerStore } from '@/buzz/room-corner-store';

afterEach(() => {
  resetRoomCornerStore();
  fixture.roomListener = null;
  fixture.connectedListener = null;
  fixture.send.mockClear();
  fixture.workspacesCalls = 0;
  fixture.acquired = [];
  fixture.roomName = 'Test room';
  fixture.cornerId = 'corner-1';
  fixture.forced = 0;
  fixture.released = 0;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('signed-in desktop native notification delivery', () => {
  it('displays one OS notification for a new DM while the app runs in background', async () => {
    vi.stubGlobal('document', { hasFocus: () => false });
    const stop = startDesktopNotifications();
    await vi.waitFor(() => expect(fixture.roomListener).toBeTypeOf('function'));
    const event = {
      monolithLive: {
        type: 'message-delta',
        roomId: 'room-1',
        message: {
          id: 'safe-test-message',
          text: 'Desktop test message',
          createdAt: Date.now() / 1000,
          author: { pubkey: 'other', name: 'Test sender' },
          presentation: 'message',
        },
      },
    };
    fixture.roomListener?.(event);
    fixture.roomListener?.(event);
    await vi.waitFor(() => expect(fixture.send).toHaveBeenCalledTimes(1));
    expect(fixture.send).toHaveBeenCalledWith({
      // The in-app DM title: `@` and the peer's handle local part.
      title: '@tester',
      body: 'Desktop test message',
    });
    stop();
    expect(fixture.roomListener).toBeNull();
  });

  it('fans the parent Room subscription into a corner and notifies an exact tag', async () => {
    vi.stubGlobal('document', { hasFocus: () => false });
    const stop = startDesktopNotifications();
    await vi.waitFor(() => expect(fixture.roomListener).toBeTypeOf('function'));
    fixture.roomListener?.({
      monolithLive: {
        type: 'message-delta',
        roomId: 'corner-1',
        message: {
          id: 'safe-corner-message',
          text: 'Review this',
          createdAt: Date.now() / 1000,
          author: { pubkey: 'other', name: 'Test sender' },
          presentation: 'message',
          mentionPubkeys: ['test-viewer'],
        },
      },
    });
    await vi.waitFor(() =>
      expect(fixture.send).toHaveBeenCalledWith({
        // The in-app corner title, composed with its parent Room.
        title: '#Test room/Test corner',
        body: 'Test sender: Review this',
      }),
    );
    stop();
  });

  it('titles a corner with its parent Room name as the store holds it now', async () => {
    vi.stubGlobal('document', { hasFocus: () => false });
    const stop = startDesktopNotifications();
    await vi.waitFor(() => expect(fixture.roomListener).toBeTypeOf('function'));
    // The parent is renamed; its corner count is unchanged, so no corner read follows.
    fixture.roomName = 'Renamed room';
    fixture.roomListener?.({
      monolithLive: {
        type: 'message-delta',
        roomId: 'corner-1',
        message: {
          id: 'safe-renamed-parent-message',
          text: 'Review this',
          createdAt: Date.now() / 1000,
          author: { pubkey: 'other', name: 'Test sender' },
          presentation: 'message',
          mentionPubkeys: ['test-viewer'],
        },
      },
    });
    await vi.waitFor(() =>
      expect(fixture.send).toHaveBeenCalledWith({
        title: '#Renamed room/Test corner',
        body: 'Test sender: Review this',
      }),
    );
    stop();
  });

  it('follows a new corner from the shared Room record', async () => {
    vi.stubGlobal('document', { hasFocus: () => false });
    const stop = startDesktopNotifications();
    await vi.waitFor(() => expect(fixture.roomListener).toBeTypeOf('function'));
    fixture.cornerId = 'corner-2';
    acceptCornerStatusFrame({
      roomId: 'room-1', cornerCount: 1,
      openCorners: [{ id: 'corner-2', name: 'Test corner', state: 'working' }],
      corners: [{ corner: { id: 'corner-2', name: 'Test corner' }, state: 'working' } as never],
    });
    await vi.waitFor(() => expect(fixture.roomListener).toBeTypeOf('function'));
    fixture.roomListener?.({
      monolithLive: {
        type: 'message-delta', roomId: 'corner-2',
        message: {
          id: 'new-corner-message', text: 'Review this', createdAt: Date.now() / 1000,
          author: { pubkey: 'other', name: 'Test sender' }, presentation: 'message',
          mentionPubkeys: ['test-viewer'],
        },
      },
    });
    await vi.waitFor(() => expect(fixture.send).toHaveBeenCalledWith({
      title: '#Test room/Test corner', body: 'Test sender: Review this',
    }));
    stop();
  });

  it('never sets a recurring timer to re-read the server', async () => {
    vi.stubGlobal('document', { hasFocus: () => false });
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    const stop = startDesktopNotifications();
    await vi.waitFor(() => expect(fixture.roomListener).toBeTypeOf('function'));
    // Let any pending microtasks from the initial reconcile settle too.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(setIntervalSpy).not.toHaveBeenCalled();
    stop();
  });

  it('reconciles exactly once when the live socket reconnects, never on a timer', async () => {
    vi.stubGlobal('document', { hasFocus: () => false });
    const stop = startDesktopNotifications();
    await vi.waitFor(() => expect(fixture.roomListener).toBeTypeOf('function'));
    await vi.waitFor(() => expect(fixture.connectedListener).toBeTypeOf('function'));
    // Flush the initial reconcile fully before treating the reconnect hook as armed.
    await new Promise((resolve) => setTimeout(resolve, 0));
    const readsAfterStart = fixture.workspacesCalls;
    expect(readsAfterStart).toBeGreaterThan(0);

    fixture.connectedListener?.();
    await vi.waitFor(() => expect(fixture.workspacesCalls).toBe(readsAfterStart + 1));
    // No burst: a reconnect signal read exactly once, not once per registration.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fixture.workspacesCalls).toBe(readsAfterStart + 1);
    // The Workspace's Room list is the shared store, held once and read again.
    expect(fixture.acquired).toEqual(['workspace-1']);
    expect(fixture.forced).toBe(1);

    stop();
    expect(fixture.released).toBe(1);
  });
});
