import { describe, expect, it, vi } from 'vitest';

const relay = vi.hoisted(() => ({ subscribed: 0, released: 0, entries: 0 }));
vi.mock('@/sync/transport', () => ({
  BuzzRigTransport: class {
    async ensureClient() {
      return {
        surfaceSubscribe: async () => {
          relay.subscribed += 1;
          return () => {
            relay.released += 1;
          };
        },
      };
    }
  },
}));
vi.mock('./surface-storage', () => ({
  surfaceAddress: () => 'workspace',
  mobileSurfaceCache: {
    peek: () => ({ watchFilters: [{ kinds: [9], '#h': ['room-1'] }] }),
    subscribe: () => {
      relay.entries += 1;
      return () => {
        relay.entries -= 1;
      };
    },
  },
}));
vi.mock('./workspace-records', () => ({
  workspaceRecordScope: (relayUrl: string, viewer: string, workspaceId: string) =>
    `${relayUrl}|${viewer}|${workspaceId}`,
}));

import { resetClientState } from '@/sync/client-reset';
import { watchWorkspace } from './workspace-watch';

const identity = { publicKey: 'a'.repeat(64), secretKey: new Uint8Array(32) };

describe('workspace watch', () => {
  it('closes every watch on a client reset, and a later release does nothing', async () => {
    const first = watchWorkspace(identity, 'https://relay.test', 'ws', () => undefined);
    await first.ready;
    expect([relay.subscribed, relay.released, relay.entries]).toEqual([1, 0, 1]);
    resetClientState();
    expect([relay.released, relay.entries]).toEqual([1, 0]);
    const next = watchWorkspace(identity, 'https://relay.test', 'ws', () => undefined);
    await next.ready;
    expect([relay.subscribed, relay.entries]).toEqual([2, 1]);
    first.release();
    expect([relay.released, relay.entries]).toEqual([1, 1]);
    next.release();
    expect([relay.released, relay.entries]).toEqual([2, 0]);
  });
});
