import React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// These fixtures exercise the negotiated legacy compatibility path. The actual
// router owner/negotiation path has independent integration coverage.
const protocol = vi.hoisted(() => ({ mode: 'legacy' as 'legacy' | 'router' | 'pending',count:2,listeners:new Set<()=>void>(),acquire:vi.fn() }));
vi.mock('@/buzz/router-family', () => ({ useRouterFamily: () => protocol.mode, holdRouterConnection: () => () => {} }));

vi.mock('@/buzz/router-owner', () => ({
  subscribeRouterOwner: () => () => {},
  routerFamilyMode: () => protocol.mode,
  acquireRouterLane: (request:unknown,_visible:()=>boolean,listener:()=>void) => {
    protocol.acquire(request);protocol.listeners.add(listener);return {release:()=>protocol.listeners.delete(listener)};
  },
  routerLaneSnapshot: () => ({ state: 'LIVE', value: {count:protocol.count}, cut: null, error: null }),
  retryRouterLane: () => {}, routerOwnerListPanel: () => {},
}));

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
  readServerSurface: (_authority: unknown, name: string) => name === 'readNeedsYou'
    ? new Promise(resolve => { fixture.reads.push(items => resolve({ items })); })
    : name === 'listMessageBookmarks' ? new Promise(resolve => { fixture.savedReads.push(bookmarks => resolve({ bookmarks })); }) : Promise.resolve(undefined),
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
import { useNeedsYouCount } from './needs-you-store';

// Committed deltas enter only through the live adapter, never a feature export.
function applyNeedsYouLiveDelta(delta: unknown) {
  for (const registration of fixture.registrations) registration.receive({ monolithLive: { ...(delta as object), type: 'needs-you-delta' } });
}
function applyBookmarkDelta(delta: unknown) {
  for (const registration of fixture.registrations) registration.receive({ monolithLive: { ...(delta as object), type: 'bookmark-delta' } });
}
function need(messageId: string, roomId = 'room-1') {
  return { messageId, workspaceId: 'ws', roomId, roomName: 'Room', text: 'ask', createdAt: 1 };
}

const diskA = 'https://server.test|viewer-a|/workspace/:id/needs-you|ws';
const diskB = 'https://server.test|viewer-b|/workspace/:id/needs-you|ws';

async function settle() {
  for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
}

beforeEach(() => {
  protocol.mode = 'legacy';protocol.count=2;protocol.listeners.clear();protocol.acquire.mockClear();
  resetClientState();
  fixture.viewer = 'viewer-a';
  fixture.disk.clear();
  fixture.reads = [];
  fixture.savedReads = [];
  fixture.registrations = [];
  fixture.holdRegistration = false;
});

describe('Room-list badges consume only the canonical count lane',()=>{
  it('two badges share count facts without attaching the full Tray reader',async()=>{
    protocol.mode='router';const values:number[]=[];
    function Badge(){const count=useNeedsYouCount('ws','surface');values.push(count);return React.createElement('badge',{count});}
    let root!:ReturnType<typeof create>;
    await act(async()=>{root=create(React.createElement(React.Fragment,null,React.createElement(Badge),React.createElement(Badge)));});
    expect(values).toEqual([2,2]);
    expect(protocol.acquire.mock.calls.every(([request])=>request.family==='needs-you-count')).toBe(true);
    expect(fixture.reads).toHaveLength(0);expect(fixture.registrations).toHaveLength(0);
    await act(async()=>{protocol.count=1;for(const listener of protocol.listeners)listener();});
    expect(values.slice(-2)).toEqual([1,1]);expect(values).not.toContain(0);
    expect(fixture.reads).toHaveLength(0);
    await act(async()=>root.unmount());expect(protocol.listeners.size).toBe(0);
  });
  it.each(['pending','legacy'] as const)('does not fall back to the full Tray list in %s mode',async mode=>{
    protocol.mode=mode;let count=-1;
    function Badge(){count=useNeedsYouCount('ws','surface');return null;}
    let root!:ReturnType<typeof create>;
    await act(async()=>{root=create(React.createElement(Badge));await settle();});
    expect(count).toBe(0);expect(fixture.reads).toHaveLength(0);expect(fixture.registrations).toHaveLength(0);
    await act(async()=>root.unmount());
  });
});
