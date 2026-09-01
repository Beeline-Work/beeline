import { beforeEach, describe, expect, it, vi } from 'vitest';

const controls = vi.hoisted(() => ({ enabled: false, legacyCalls: 0, monolithCalls: 0 }));
const fixture = {
  workspaces: [],
  viewer: { pubkey: 'a'.repeat(64), kind: 'human' as const, name: 'Owner' },
  truncated: false,
  watchFilters: [],
};

vi.mock('@/buzz/runtime-config', () => ({
  getBuzzRuntimeConfig: () => ({
    monolithEnabled: controls.enabled,
    monolithUrl: 'https://server.example',
  }),
}));
vi.mock('@/auth/monolith-session', () => ({
  monolithSession: {
    fetch: vi.fn(async () => {
      controls.monolithCalls += 1;
      return new Response(JSON.stringify(fixture), { status: 200 });
    }),
  },
}));
vi.mock('@beeline/buzz-client', async (original) => {
  const actual = await original<typeof import('@beeline/buzz-client')>();
  return {
    ...actual,
    RoomViewClient: class {
      workspaces() {
        controls.legacyCalls += 1;
        return Promise.resolve(fixture);
      }
      workspace() {
        throw new Error('unused');
      }
      agent() {
        throw new Error('unused');
      }
      chats() {
        throw new Error('unused');
      }
      room() {
        throw new Error('unused');
      }
      corners() {
        throw new Error('unused');
      }
      history() {
        throw new Error('unused');
      }
      invite() {
        throw new Error('unused');
      }
      claimAgentPairing() {
        throw new Error('unused');
      }
      abandonAgentPairing() {
        throw new Error('unused');
      }
    },
  };
});

import { RoomViewClient } from './room-view-client';

describe('mobile transport cutover switch', () => {
  beforeEach(() => {
    controls.enabled = false;
    controls.legacyCalls = 0;
    controls.monolithCalls = 0;
  });

  it.each([false, true])(
    'returns the identical guarded screen DTO when monolith=%s',
    async (enabled) => {
      controls.enabled = enabled;
      const client = new RoomViewClient({
        baseUrl: 'https://relay.example',
        identity: { publicKey: 'a'.repeat(64), secretKey: new Uint8Array(32) },
      });
      await expect(client.workspaces()).resolves.toEqual(fixture);
      expect(controls.monolithCalls).toBe(enabled ? 1 : 0);
      expect(controls.legacyCalls).toBe(enabled ? 0 : 1);
    },
  );
});
