import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isChatListView, type ChatListItem, type ChatListView } from '@beeline/buzz-client';

const server = vi.hoisted(() => ({
  chats: (async () => { throw new Error('no read served'); }) as () => Promise<unknown>,
}));
const live = vi.hoisted(() => ({
  listeners: [] as Array<(event: unknown) => void>,
}));

vi.mock('react-native', () => ({ AppState: { currentState: 'active' } }));
// The real registry, over an in-memory disk.
vi.mock('./surface-storage', async () => {
  const { SurfaceResponseCache } = await import('@beeline/buzz-client');
  const { SurfaceRegistry } = await import('./surface-registry');
  const rows = new Map<string, string>();
  const durable = new SurfaceResponseCache({
    get: async (key) => rows.get(key) ?? null,
    set: async (key, value) => { rows.set(key, value); },
    remove: async (key) => { rows.delete(key); },
    keys: async () => [...rows.keys()],
  });
  return {
    rows,
    mobileSurfaceCache: new SurfaceRegistry(durable),
    surfaceAddress: (relayOrigin: string, viewerPubkey: string, endpoint: string, params?: object) =>
      ({ relayOrigin, viewerPubkey, endpoint, ...(params ? { params } : {}) }),
  };
});
vi.mock('./chat-list-read', () => ({ readChatListFromServer: () => server.chats() }));
vi.mock('@/sync/transport/live-connection', () => ({
  sharedLiveConnection: () => ({
    register: async (_filters: unknown, listener: (event: unknown) => void) => {
      live.listeners.push(listener);
      return () => {
        live.listeners = live.listeners.filter((held) => held !== listener);
      };
    },
    whenSubscribed: async () => undefined,
    isViewing: () => false,
    reconnect: () => undefined,
  }),
}));

import { acquireChatList, resetChatListStoresForTest } from './chat-list-store';
import { mobileSurfaceCache, surfaceAddress } from './surface-storage';

const WORKSPACE = '00000000-0000-4000-8000-000000000001';
const ROOM_A = '00000000-0000-4000-8000-00000000000a';
const ROOM_B = '00000000-0000-4000-8000-00000000000b';
const VIEWER = 'c'.repeat(64);
const M1 = '1'.repeat(64);
const M2 = '2'.repeat(64);
const B1 = 'b'.repeat(64);
const key = { relayUrl: 'https://relay.test', viewerPubkey: VIEWER, workspaceId: WORKSPACE };
const address = surfaceAddress(key.relayUrl, key.viewerPubkey, '/workspace/:id/chats', {
  workspaceId: key.workspaceId,
});
const agent = { pubkey: 'a'.repeat(64), kind: 'agent' as const, name: 'Greeter' };

function row(id: string, name: string, latest: { id: string; createdAt: number }): ChatListItem {
  return {
    room: { id, workspaceId: WORKSPACE, name, archived: false, createdAt: 1, updatedAt: 1 },
    latestMessage: { id: latest.id, text: latest.id, createdAt: latest.createdAt, author: agent },
    unread: false,
  };
}

function listOf(chats: ChatListItem[]): ChatListView {
  return {
    workspace: { id: WORKSPACE, name: 'Work', role: 'member', updatedAt: 1 },
    chats,
    viewer: { pubkey: VIEWER, kind: 'human', name: 'Captain' },
    truncated: false,
    watchFilters: [{ '#h': chats.map((item) => item.room.id) }],
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  resetChatListStoresForTest();
  live.listeners = [];
});

afterEach(() => {
  resetChatListStoresForTest();
  vi.useRealTimers();
});

describe('the Room list store over the real surface registry', () => {
  it('keeps the server read when a delta lands while it is in flight', async () => {
    const answers: Array<(value: ChatListView) => void> = [];
    server.chats = () => new Promise((resolve) => { answers.push(resolve); });
    const handle = acquireChatList(key, { visible: () => true });
    await vi.advanceTimersByTimeAsync(0);
    answers[0]!(listOf([row(ROOM_A, 'Alpha', { id: M1, createdAt: 10 })]));
    await vi.advanceTimersByTimeAsync(10);
    expect(handle.current()?.chats.map((item) => item.room.id)).toEqual([ROOM_A]);

    // A covering read starts, then a message lands before it answers.
    handle.force();
    await vi.advanceTimersByTimeAsync(0);
    expect(answers).toHaveLength(2);
    for (const listener of live.listeners)
      listener({
        monolithLive: {
          type: 'message-delta', roomId: ROOM_A,
          message: { id: M2, text: 'm2', createdAt: 20, author: agent, presentation: 'message' },
        },
      });
    // The server's answer predates m2, renames room-a and adds room-b.
    answers[1]!(listOf([
      row(ROOM_A, 'Renamed', { id: M1, createdAt: 10 }),
      row(ROOM_B, 'Beta', { id: B1, createdAt: 5 }),
    ]));
    await vi.advanceTimersByTimeAsync(10);

    const value = handle.current()!;
    expect(value.chats.map((item) => item.room.id).sort()).toEqual([ROOM_A, ROOM_B].sort());
    const roomA = value.chats.find((item) => item.room.id === ROOM_A)!;
    expect(roomA.room.name).toBe('Renamed');
    expect(roomA.latestMessage?.id).toBe(M2);
    // The registry holds the reconciled value, never the raw read.
    expect(mobileSurfaceCache.peek(address, isChatListView)).toBe(value);
    handle.release();
  });
});
