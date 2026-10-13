import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('react-native', () => ({ AppState: { currentState: 'active',
  addEventListener: () => ({ remove: () => undefined }) } }));

const fixture = vi.hoisted(() => ({
  viewer: 'viewer-a',
  disk: new Map<string, unknown>(),
  reads: [] as Array<(items: unknown[]) => void>,
  savedReads: [] as Array<(bookmarks: unknown[]) => void>,
  registrations: [] as Array<{ stop: () => void; finish: () => void; receive: (event: unknown) => void }>,
  holdRegistration: false,
}));
vi.mock('@/auth/buzz-identity-storage', () => ({
  getEffectiveRelayUrl: async () => 'https://server.test',
  loadBuzzIdentity: async () => ({ publicKey: fixture.viewer }),
}));
vi.mock('@/buzz/surface-storage', () => ({
  surfaceAddress: (relay: string, viewer: string, endpoint: string, params: { workspaceId: string }) =>
    `${relay}|${viewer}|${endpoint}|${params.workspaceId}`,
  mobileSurfaceCache: {
    read: async (address: string) => fixture.disk.get(address) ?? null,
    write: async (address: string, value: unknown) => { fixture.disk.set(address, value); },
    remove: async (address: string) => { fixture.disk.delete(address); },
  },
}));
vi.mock('@/sync/transport/monolith-operation', () => ({
  monolithPhoneOperation: (name: string) => name === 'readNeedsYou'
    ? new Promise((resolve) => { fixture.reads.push((items) => resolve({ items })); })
    : name === 'listMessageBookmarks'
      ? new Promise((resolve) => { fixture.savedReads.push((bookmarks) => resolve({ bookmarks })); })
      : Promise.resolve(undefined),
}));
vi.mock('@/sync/transport/live-connection', () => ({
  sharedLiveConnection: () => ({ register: (_filters: unknown, receive: (event: unknown) => void) =>
    new Promise<() => void>((resolve) => {
    const stop = vi.fn();
    const finish = () => resolve(stop);
    fixture.registrations.push({ stop, finish, receive });
    if (!fixture.holdRegistration) finish();
  }) }),
}));

import { resetClientState } from '@/sync/client-reset';
import {
  applyNeedsYouLiveDelta,
  applyBookmarkDelta,
  forgetTray,
  loadSavedList,
  loadNeedsYouList,
  removeNeedsYou,
  seedNeedsYouList,
  updateSavedList,
} from './needs-you-store';

function need(messageId: string, roomId = 'room-1') {
  return { messageId, workspaceId: 'ws', roomId, roomName: 'Room', text: 'ask', createdAt: 1 };
}

const diskA = 'https://server.test|viewer-a|/workspace/:id/needs-you|ws';
const diskB = 'https://server.test|viewer-b|/workspace/:id/needs-you|ws';

async function settle() {
  for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
}

beforeEach(() => {
  resetClientState();
  fixture.viewer = 'viewer-a';
  fixture.disk.clear();
  fixture.reads = [];
  fixture.savedReads = [];
  fixture.registrations = [];
  fixture.holdRegistration = false;
});

describe('Needs-you disk copy', () => {
  it('keeps the read and its later changes on disk for the viewer that read it', async () => {
    const read = loadNeedsYouList('ws');
    await settle();
    fixture.reads[0]!([need('ask-1')]);
    await read;
    applyNeedsYouLiveDelta({ workspaceId: 'ws', sourceRoomId: 'room-2', count: 2, items: [need('ask-2', 'room-2')] as never });
    await settle();
    expect(fixture.disk.get(diskA)).toMatchObject({ items: [{ messageId: 'ask-1' }, { messageId: 'ask-2' }] });
  });

  it('never stores the previous account\'s read under the new account', async () => {
    const read = loadNeedsYouList('ws');
    await settle();
    fixture.viewer = 'viewer-b';
    resetClientState();
    fixture.reads[0]!([need('ask-a')]);
    await read;
    await settle();
    expect(fixture.disk.has(diskA)).toBe(false);
    expect(fixture.disk.has(diskB)).toBe(false);
  });

  it('paints the disk copy only while nothing changed during the disk read', async () => {
    fixture.disk.set(diskA, { items: [need('ask-old')] });
    await expect(seedNeedsYouList('ws')).resolves.toBe(true);
    const read = loadNeedsYouList('ws');
    await settle();
    fixture.reads[0]!([need('ask-new')]);
    await expect(read).resolves.toMatchObject([{ messageId: 'ask-new' }]);
    // A later disk read does not replace the server's list.
    await seedNeedsYouList('ws');
    expect(fixture.disk.get(diskA)).toMatchObject({ items: [{ messageId: 'ask-new' }] });
  });

  it('removes the disk copy when membership is lost and does not write it back', async () => {
    const read = loadNeedsYouList('ws');
    await settle();
    fixture.reads[0]!([need('ask-1')]);
    await read;
    await settle();
    expect(fixture.disk.has(diskA)).toBe(true);
    forgetTray('ws');
    applyNeedsYouLiveDelta({ workspaceId: 'ws', sourceRoomId: 'room-2', count: 1, items: [need('ask-2', 'room-2')] as never });
    await settle();
    expect(fixture.disk.has(diskA)).toBe(false);
  });
});

describe('Needs-you read replay', () => {
  it('keeps a pending clear after a later Room delta during the read', async () => {
    const read = loadNeedsYouList('ws');
    await settle();
    removeNeedsYou('ws', ['ask-1']);
    applyNeedsYouLiveDelta({ workspaceId: 'ws', sourceRoomId: 'room-1', count: 2,
      items: [need('ask-1'), need('ask-2')] as never });
    fixture.reads[0]!([need('ask-1')]);
    const items = await read;
    expect(items.map((item) => item.messageId)).toEqual(['ask-2']);
  });
});

describe('one tray clock and registration', () => {
  it('replays a Saved delta that arrived during its read', async () => {
    const read = loadSavedList('ws');
    await settle();
    applyBookmarkDelta({ workspaceId: 'ws', messageId: 'saved-2', bookmark: {
      messageId: 'saved-2', workspaceId: 'ws', roomId: 'room-1', roomName: 'Room',
      bookmarkedAt: 2, available: true, messageCreatedAt: 1,
    } as never });
    fixture.savedReads[0]!([]);
    await read;
    await settle();
    expect(fixture.disk.get('https://server.test|viewer-a|/workspace/:id/bookmarks|ws'))
      .toMatchObject({ bookmarks: [{ messageId: 'saved-2' }] });
  });

  it('keeps a pending Saved removal through a stale server read', async () => {
    const saved = { messageId: 'saved-1', workspaceId: 'ws', roomId: 'room-1',
      roomName: 'Room', bookmarkedAt: 2, available: true, messageCreatedAt: 1 };
    const first = loadSavedList('ws');
    await settle();
    fixture.savedReads[0]!([saved]);
    await first;
    const edit = updateSavedList('ws', (items) => items.filter((item) => item.messageId !== 'saved-1'));
    const stale = loadSavedList('ws');
    await settle();
    fixture.savedReads[1]!([saved]);
    await stale;
    expect(fixture.disk.get('https://server.test|viewer-a|/workspace/:id/bookmarks|ws'))
      .toMatchObject({ bookmarks: [] });
    const staleAgain = loadSavedList('ws');
    await settle();
    fixture.savedReads[2]!([saved]);
    await staleAgain;
    expect(fixture.disk.get('https://server.test|viewer-a|/workspace/:id/bookmarks|ws'))
      .toMatchObject({ bookmarks: [] });
    edit.settle();
  });

  it('does not revive either section from reads completed after membership loss', async () => {
    const needs = loadNeedsYouList('ws');
    const saved = loadSavedList('ws');
    await settle();
    forgetTray('ws');
    fixture.reads[0]!([need('ask-old')]);
    fixture.savedReads[0]!([{ messageId: 'saved-old' }]);
    await Promise.all([needs, saved]);
    await settle();
    expect(fixture.disk.has(diskA)).toBe(false);
    expect(fixture.disk.has('https://server.test|viewer-a|/workspace/:id/bookmarks|ws')).toBe(false);
  });

  it('re-registers after reset while the old registration is still starting', async () => {
    fixture.holdRegistration = true;
    await seedNeedsYouList('ws');
    expect(fixture.registrations).toHaveLength(1);
    fixture.viewer = 'viewer-b';
    fixture.disk.set(diskB, { items: [] });
    resetClientState();
    await seedNeedsYouList('ws');
    expect(fixture.registrations).toHaveLength(2);
    fixture.registrations[0]!.receive({ monolithLive: { type: 'needs-you-delta',
      workspaceId: 'ws', sourceRoomId: 'room-1', count: 1, items: [need('old-account')] } });
    await settle();
    expect(fixture.disk.get(diskB)).toEqual({ items: [] });
    fixture.registrations[0]!.finish();
    await settle();
    expect(fixture.registrations[0]!.stop).toHaveBeenCalledOnce();
    fixture.registrations[1]!.finish();
    await settle();
    expect(fixture.registrations[1]!.stop).not.toHaveBeenCalled();
    fixture.registrations[1]!.receive({ monolithLive: { type: 'needs-you-delta',
      workspaceId: 'ws', sourceRoomId: 'room-1', count: 1, items: [need('new-account')] } });
    await settle();
    expect(fixture.disk.get(diskB)).toMatchObject({ items: [{ messageId: 'new-account' }] });
  });
});
