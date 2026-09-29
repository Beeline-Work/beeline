import { afterEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  roomListener: null as null | ((event: unknown) => void),
  send: vi.fn(),
  permission: vi.fn(async () => true),
  identityChange: null as null | (() => void),
}));
vi.mock('@/utils/isTauri', () => ({ isTauri: () => true }));
vi.mock('@/auth/buzz-identity-storage', () => ({
  loadBuzzIdentity: async () => ({ publicKey: 'test-viewer', secretKey: new Uint8Array(32) }),
  getEffectiveRelayUrl: async () => 'https://test.invalid',
}));
vi.mock('@/auth/monolith-session', () => ({
  monolithSession: {
    subscribeIdentityChange: (listener: () => void) => {
      fixture.identityChange = listener;
      return () => {
        fixture.identityChange = null;
      };
    },
  },
}));
vi.mock('@/buzz/open-room-tracker', () => ({ getOpenBuzzChannelId: () => null }));
vi.mock('./buzz-push-registration', () => ({ getBuzzPushEnabled: async () => true }));
vi.mock('./push-level-storage', () => ({ loadStoredPushLevel: async () => 'mine' }));
vi.mock('@/sync/transport/monolith-operation', () => ({
  monolithPhoneOperation: async () => ({ pushLevel: 'mine' }),
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
  },
  RoomViewClient: class {
    workspaces() {
      return Promise.resolve({ workspaces: [{ id: 'workspace-1' }] });
    }
    chats() {
      return Promise.resolve({
        chats: [{ room: { id: 'room-1', name: 'Test room' }, directMessage: {}, unread: true }],
        watchFilters: [{ '#h': ['room-1'] }],
      });
    }
  },
}));
vi.mock('@tauri-apps/plugin-notification', () => ({
  isPermissionGranted: fixture.permission,
  requestPermission: vi.fn(async () => 'granted'),
  sendNotification: fixture.send,
}));

import { startDesktopNotifications } from './desktop-notifications';

afterEach(() => {
  fixture.roomListener = null;
  fixture.send.mockClear();
  vi.unstubAllGlobals();
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
      title: 'Test sender',
      body: 'Desktop test message',
    });
    stop();
    expect(fixture.roomListener).toBeNull();
  });
});
