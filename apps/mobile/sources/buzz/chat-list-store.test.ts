import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatListItem, ChatListView } from '@beeline/buzz-client';

const disk = vi.hoisted(() => ({
  rows: new Map<string, unknown>(),
  writes: [] as unknown[],
}));
const live = vi.hoisted(() => ({
  registrations: [] as Array<{ filters: unknown; listener: (event: unknown) => void; closed: boolean }>,
  reconnects: 0,
  viewing: new Set<string>(),
}));

vi.mock('react-native', () => ({ AppState: { currentState: 'active' } }));
vi.mock('./surface-storage', () => ({
  surfaceAddress: (_relay: string, _viewer: string, endpoint: string, params?: { workspaceId?: string }) =>
    `${endpoint}:${params?.workspaceId ?? ''}`,
  mobileSurfaceCache: {
    peek: () => null,
    read: async (key: string) => disk.rows.get(key) ?? null,
    publish: (_key: string, value: unknown) => value,
    write: async (key: string, value: unknown) => {
      disk.rows.set(key, value);
      disk.writes.push(value);
    },
    remove: async (key: string) => {
      disk.rows.delete(key);
    },
    fetch: async (key: string, _guard: unknown, request: () => Promise<unknown>) => {
      const value = await request();
      disk.rows.set(key, value);
      return value;
    },
  },
}));
vi.mock('@/sync/transport/live-connection', () => ({
  sharedLiveConnection: () => ({
    register: async (filters: unknown, listener: (event: unknown) => void) => {
      const registration = { filters, listener, closed: false };
      live.registrations.push(registration);
      return () => {
        registration.closed = true;
      };
    },
    whenSubscribed: async () => undefined,
    isViewing: (roomId: string) => live.viewing.has(roomId),
    reconnect: () => {
      live.reconnects += 1;
    },
  }),
}));

import { acquireChatList, liveChatList, resetChatListStoresForTest } from './chat-list-store';

const key = { relayUrl: 'https://relay.test', viewerPubkey: 'viewer', workspaceId: 'workspace' };
const agent = { pubkey: 'agent', kind: 'agent' as const, name: 'Greeter' };

function row(id: string, latestAt: number, extra: Partial<ChatListItem> = {}): ChatListItem {
  return {
    room: { id, workspaceId: 'workspace', name: id, archived: false, createdAt: 1, updatedAt: 1 },
    latestMessage: { id: `${id}-latest`, text: 'hello', createdAt: latestAt, author: agent },
    unread: false,
    ...extra,
  };
}

function listOf(chats: ChatListItem[]): ChatListView {
  return {
    workspace: { id: 'workspace', name: 'Work', role: 'member', updatedAt: 1 },
    chats,
    viewer: { pubkey: 'viewer', kind: 'human', name: 'Captain' },
    truncated: false,
    watchFilters: [{ '#h': chats.map((item) => item.room.id) }],
  };
}

function emit(event: unknown): void {
  for (const registration of live.registrations)
    if (!registration.closed) registration.listener(event);
}

function openWatches(): number {
  return live.registrations.filter((registration) => !registration.closed).length;
}

const visible = { visible: () => true };

beforeEach(() => {
  vi.useFakeTimers();
  resetChatListStoresForTest();
  disk.rows.clear();
  disk.writes = [];
  live.registrations = [];
  live.reconnects = 0;
  live.viewing.clear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('app-level Room list store', () => {
  it('keeps one live copy for every screen, with or without the deck', async () => {
    const server = listOf([row('room-a', 10), row('room-b', 5)]);
    const chats = vi.fn(async () => server);
    // The Sidebar opens the list on its own: no deck is mounted.
    const sidebar = acquireChatList(key, { chats }, visible);
    await vi.advanceTimersByTimeAsync(10);
    expect(sidebar.current()?.chats.map((item) => item.room.id)).toEqual(['room-a', 'room-b']);
    expect(openWatches()).toBe(1);

    // The Room screen joins the same store: no second read, no second watch.
    const roomScreen = acquireChatList(key, { chats }, visible);
    expect(roomScreen.current()).toBe(sidebar.current());
    expect(chats).toHaveBeenCalledTimes(1);
    expect(openWatches()).toBe(1);

    const seen = vi.fn();
    roomScreen.subscribe(seen);
    emit({
      monolithLive: {
        type: 'message-delta',
        roomId: 'room-b',
        message: {
          id: 'm-new', text: 'fresh', createdAt: 20, author: agent, presentation: 'message',
        },
      },
    });
    expect(seen).toHaveBeenCalled();
    expect(sidebar.current()?.chats[0]).toMatchObject({ room: { id: 'room-b' }, unread: true });
    expect(roomScreen.current()).toBe(sidebar.current());
    expect(liveChatList(key)).toBe(sidebar.current());

    emit({
      monolithLive: {
        type: 'corner-status', roomId: 'room-a', cornerCount: 1, waitingCornerCount: 0,
        openCorners: [], agentState: 'working',
      },
    });
    expect(roomScreen.current()?.chats.find((item) => item.room.id === 'room-a'))
      .toMatchObject({ cornerCount: 1, agentState: 'working' });
    expect(chats).toHaveBeenCalledTimes(1);

    sidebar.release();
    expect(openWatches()).toBe(1);
    roomScreen.release();
    expect(openWatches()).toBe(0);
    expect(liveChatList(key)).toBeNull();
  });

  it('makes one covering read on open even when every Room resumes its lane', async () => {
    const address = '/workspace/:id/chats:workspace';
    disk.rows.set(address, listOf([row('room-a', 10, { unread: false }), row('room-b', 5)]));
    const server = listOf([row('room-a', 30, { unread: true }), row('room-b', 5)]);
    const chats = vi.fn(async () => server);
    const handle = acquireChatList(key, { chats }, visible);
    await vi.advanceTimersByTimeAsync(0);
    // Every Room reports a resumed lane before the read lands.
    emit({ monolithLive: { type: 'subscribed', roomId: 'room-a', resumed: true } });
    emit({ monolithLive: { type: 'subscribed', roomId: 'room-b', resumed: true } });
    await vi.advanceTimersByTimeAsync(10);
    expect(chats).toHaveBeenCalledTimes(1);
    expect(handle.current()?.chats[0]).toMatchObject({ room: { id: 'room-a' }, unread: true });

    // A later resumed lane replays what the live list already folded.
    emit({ monolithLive: { type: 'subscribed', roomId: 'room-a', resumed: true } });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(chats).toHaveBeenCalledTimes(1);
    handle.release();
  });

  it('writes live deltas through to disk, so a reopened list starts current', async () => {
    const chats = vi.fn(async () => listOf([row('room-a', 10)]));
    const first = acquireChatList(key, { chats }, visible);
    await vi.advanceTimersByTimeAsync(10);
    const writesAfterRead = disk.writes.length;
    emit({
      monolithLive: {
        type: 'message-delta',
        roomId: 'room-a',
        message: { id: 'm-late', text: 'late', createdAt: 40, author: agent, presentation: 'message' },
      },
    });
    await vi.advanceTimersByTimeAsync(1_100);
    expect(disk.writes.length).toBe(writesAfterRead + 1);
    first.release();

    // The next open paints the delta from disk before its covering read lands.
    let answer!: (value: ChatListView) => void;
    const second = acquireChatList(key, { chats: () => new Promise((resolve) => { answer = resolve; }) }, visible);
    await vi.advanceTimersByTimeAsync(0);
    expect(second.current()?.chats[0]?.latestMessage?.text).toBe('late');
    answer(listOf([row('room-a', 10)]));
    second.release();
  });

  it('reads nothing while no screen is on view, then catches up once', async () => {
    let onView = true;
    const chats = vi.fn(async () => listOf([row('room-a', 10)]));
    const handle = acquireChatList(key, { chats }, { visible: () => onView });
    await vi.advanceTimersByTimeAsync(10);
    onView = false;
    emit({ monolithLive: { type: 'invalidate', roomId: 'room-a', reason: 'activity' } });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(chats).toHaveBeenCalledTimes(1);
    onView = true;
    handle.catchUp();
    await vi.advanceTimersByTimeAsync(10);
    expect(chats).toHaveBeenCalledTimes(2);
    handle.catchUp();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(chats).toHaveBeenCalledTimes(2);
    handle.release();
  });

  it('never offers a stored copy as the live list a dismissed Room is checked against', async () => {
    // Disk still shows the Room open; the reader dismissed it since.
    disk.rows.set('/workspace/:id/chats:workspace', listOf([row('room-a', 10)]));
    let answer!: (value: ChatListView) => void;
    const handle = acquireChatList(
      key,
      { chats: () => new Promise((resolve) => { answer = resolve; }) },
      visible,
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(handle.current()?.chats[0]?.closed).toBeUndefined();
    expect(liveChatList(key)).toBeNull();
    answer(listOf([row('room-a', 10, { closed: true })]));
    await vi.advanceTimersByTimeAsync(10);
    expect(liveChatList(key)?.chats[0]?.closed).toBe(true);
    handle.release();
  });
});

function agentMessage(roomId: string, id: string, createdAt: number) {
  return {
    monolithLive: {
      type: 'message-delta', roomId,
      message: { id, text: id, createdAt, author: agent, presentation: 'message' },
    },
  };
}

const readMark = (roomId: string) => ({ monolithLive: { type: 'invalidate', roomId, reason: 'read-mark' } });

describe('unread follows the server read cursor in every arrival order', () => {
  it('delta then read mark: lights once, then the read clears it', async () => {
    let server = listOf([row('room-a', 10)]);
    const chats = vi.fn(async () => server);
    const handle = acquireChatList(key, { chats }, visible);
    await vi.advanceTimersByTimeAsync(10);
    const seen: boolean[] = [];
    handle.subscribe(() => seen.push(handle.current()!.chats[0]!.unread));

    emit(agentMessage('room-a', 'm2', 20));
    expect(handle.current()?.chats[0]?.unread).toBe(true);
    // Another device reads m2.
    server = listOf([row('room-a', 20, { latestMessage: {
      id: 'm2', text: 'm2', createdAt: 20, author: agent } })]);
    emit(readMark('room-a'));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(handle.current()?.chats[0]?.unread).toBe(false);
    expect(seen).toEqual([true, false]);
    handle.release();
  });

  it('read mark then late delta: the delta for a covered message leaves the dot off', async () => {
    let server = listOf([row('room-a', 10)]);
    const chats = vi.fn(async () => server);
    const handle = acquireChatList(key, { chats }, visible);
    await vi.advanceTimersByTimeAsync(10);
    // The read already shows m2, read on another device.
    server = listOf([row('room-a', 20, { latestMessage: {
      id: 'm2', text: 'm2', createdAt: 20, author: agent } })]);
    emit(readMark('room-a'));
    await vi.advanceTimersByTimeAsync(2_000);
    const seen: boolean[] = [];
    handle.subscribe(() => seen.push(handle.current()!.chats[0]!.unread));
    emit(agentMessage('room-a', 'm2', 20));
    expect(handle.current()?.chats[0]?.unread).toBe(false);
    expect(seen.every((unread) => !unread)).toBe(true);
    handle.release();
  });

  it('delta during a read in flight: the read that covers it decides', async () => {
    const answers: Array<(value: ChatListView) => void> = [];
    const chats = vi.fn(() => new Promise<ChatListView>((resolve) => { answers.push(resolve); }));
    const handle = acquireChatList(key, { chats }, visible);
    await vi.advanceTimersByTimeAsync(0);
    // The opening read is in flight when m2 lands and another device reads it.
    emit(agentMessage('room-a', 'm2', 20));
    emit(readMark('room-a'));
    answers[0]!(listOf([row('room-a', 20, { latestMessage: {
      id: 'm2', text: 'm2', createdAt: 20, author: agent } })]));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(handle.current()?.chats[0]).toMatchObject({ unread: false, latestMessage: { id: 'm2' } });

    // A read that predates the delta keeps it lit until a read covers it.
    emit(readMark('room-a'));
    await vi.advanceTimersByTimeAsync(0);
    const pending = answers.length - 1;
    emit(agentMessage('room-a', 'm3', 30));
    answers[pending]!(listOf([row('room-a', 20, { latestMessage: {
      id: 'm2', text: 'm2', createdAt: 20, author: agent } })]));
    await vi.advanceTimersByTimeAsync(10);
    expect(handle.current()?.chats[0]).toMatchObject({ unread: true, latestMessage: { id: 'm3' } });
    handle.release();
  });

  it('never lights the dot for a message in the Room on screen', async () => {
    const chats = vi.fn(async () => listOf([row('room-a', 10), row('room-b', 5)]));
    const handle = acquireChatList(key, { chats }, visible);
    await vi.advanceTimersByTimeAsync(10);
    live.viewing.add('room-b');
    const seen: boolean[] = [];
    handle.subscribe(() => seen.push(
      handle.current()!.chats.find((item) => item.room.id === 'room-b')!.unread));
    emit(agentMessage('room-b', 'm-open', 20));
    emit(readMark('room-b'));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((unread) => !unread)).toBe(true);
    handle.release();
  });
});
