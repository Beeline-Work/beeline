import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const listeners = vi.hoisted(() => [] as Array<(event: unknown) => void>);
vi.mock('@/sync/transport/live-connection', () => ({
  sharedLiveConnection: () => ({
    register: async (_filters: unknown, listener: (event: unknown) => void) => {
      listeners.push(listener);
      return () => undefined;
    },
  }),
}));

import { useRoomLiveDrafts } from './room-live-drafts';

const originalConsoleError = console.error;
beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  vi.spyOn(console, 'error').mockImplementation((message?: unknown, ...args: unknown[]) => {
    if (typeof message === 'string' && message.startsWith('react-test-renderer is deprecated'))
      return;
    originalConsoleError(message, ...args);
  });
});
afterAll(() => vi.restoreAllMocks());

function Harness({ capture }: { capture(drafts: ReadonlyMap<string, string>): void }) {
  capture(useRoomLiveDrafts('room-a'));
  return null;
}

const emit = (monolithLive: Record<string, unknown>) =>
  act(async () => {
    for (const listener of listeners) listener({ monolithLive: { roomId: 'room-a', ...monolithLive } });
  });

describe('Room live drafts', () => {
  it('drops a draft whose end was lost in a socket gap', async () => {
    let drafts = new Map<string, string>() as ReadonlyMap<string, string>;
    let renderer!: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(<Harness capture={(next) => (drafts = next)} />);
    });
    await emit({ type: 'draft', agentId: 'agent-a', turnId: 'turn-1', latestChunk: 'Working' });
    expect([...drafts.values()]).toEqual(['Working']);

    // A resumed lane replays what it missed, so the draft stays.
    await emit({ type: 'subscribed', resumed: true });
    expect([...drafts.values()]).toEqual(['Working']);

    // A fresh lane after a gap: the turn ended while the socket was down.
    await emit({ type: 'subscribed' });
    expect([...drafts.values()]).toEqual([]);
    await act(async () => renderer.unmount());
  });
});
