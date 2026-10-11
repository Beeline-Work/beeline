import { beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  viewer: 'viewer-a',
  disk: new Map<string, unknown>(),
  reads: [] as Array<(items: unknown[]) => void>,
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
    : Promise.resolve(undefined),
}));
vi.mock('@/sync/transport/live-connection', () => ({
  sharedLiveConnection: () => ({ register: async () => () => undefined }),
}));

import { resetClientState } from '@/sync/client-reset';
import {
  applyNeedsYouLiveDelta,
  forgetNeedsYouList,
  loadNeedsYouList,
  removeNeedsYou,
  seedNeedsYouList,
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
    forgetNeedsYouList('ws');
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
