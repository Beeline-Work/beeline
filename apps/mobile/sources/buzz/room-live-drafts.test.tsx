import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { LiveWireEvent } from '@/sync/transport/monolith-rig-transport';

vi.mock('@/sync/transport/live-connection', () => ({
  sharedLiveConnection: () => ({
    register: async () => () => undefined,
  }),
}));

import { resetClientState } from '@/sync/client-reset';
import { liveDraftDrainStore } from './live-draft-drain';
import { applyRoomDraftFrame, useRoomDraftLanes, useRoomLiveDrafts } from './room-live-drafts';

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

type Seen = { lanes: readonly { requestId: string; closed: boolean }[]; chunks: ReadonlyMap<string, string> };

/** Two views of one Room: the transcript's lanes and a workflow run's chunks. */
function Harness({ capture }: { capture(seen: Seen): void }) {
  capture({ lanes: useRoomDraftLanes('room-a'), chunks: useRoomLiveDrafts('room-a') });
  return null;
}

const frame = (live: Record<string, unknown>, resumed = false) =>
  act(async () => applyRoomDraftFrame({ roomId: 'room-a', ...live } as LiveWireEvent, resumed));

async function mount() {
  const seen = { current: { lanes: [], chunks: new Map() } as Seen };
  let renderer!: ReturnType<typeof create>;
  await act(async () => {
    renderer = create(<Harness capture={(next) => (seen.current = next)} />);
  });
  return { seen, unmount: () => act(async () => renderer.unmount()) };
}

const draft = (text: string, latestChunk: string) => ({
  type: 'draft',
  agentId: 'agent-a',
  turnId: 'turn-1',
  text,
  latestChunk,
});

describe('Room live drafts', () => {
  it('gives every view one copy of a draft', async () => {
    const { seen, unmount } = await mount();
    await frame(draft('Work', 'Work'));
    await frame(draft('Working', 'ing'));
    expect(seen.current.lanes).toMatchObject([{ requestId: 'turn-1', closed: false }]);
    expect([...seen.current.chunks.values()]).toEqual(['ing']);
    expect(liveDraftDrainStore.getReceived('agent-a:turn-1')).toBe('Working');

    // The turn ended: the run view drops it; the transcript keeps the lane
    // until the final reply settles it.
    await frame({
      type: 'turn-delta',
      turn: { agentPubkey: 'agent-a', requestId: 'turn-1', status: 'complete', createdAt: 2 },
    });
    expect(seen.current.chunks.size).toBe(0);
    expect(seen.current.lanes).toHaveLength(1);
    await frame({ type: 'subscribed' });
    await unmount();
  });

  // Review R5: a frame that changed only the newest chunk did not reach the run view.
  it('shows a new chunk when the cumulative text is unchanged', async () => {
    const { seen, unmount } = await mount();
    await frame(draft('Working', 'Working'));
    await frame(draft('Working', 'ing'));
    expect([...seen.current.chunks.values()]).toEqual(['ing']);
    await frame({ type: 'subscribed' });
    await unmount();
  });

  it('drops a draft whose end was lost in a socket gap', async () => {
    const { seen, unmount } = await mount();
    await frame(draft('Working', 'Working'));
    expect([...seen.current.chunks.values()]).toEqual(['Working']);

    // A resumed lane replays what it missed, so the draft stays.
    await frame({ type: 'subscribed' }, true);
    expect(seen.current.lanes).toHaveLength(1);

    // A fresh lane after a gap: the turn may have ended while the socket was down.
    await frame({ type: 'subscribed' }, false);
    expect(seen.current.lanes).toEqual([]);
    expect([...seen.current.chunks.values()]).toEqual([]);
    expect(liveDraftDrainStore.getReceived('agent-a:turn-1')).toBe('');
    await unmount();
  });

  it('drops every draft on a client reset', async () => {
    const { seen, unmount } = await mount();
    await frame(draft('Working', 'Working'));
    await act(async () => resetClientState());
    expect(seen.current.lanes).toEqual([]);
    expect(seen.current.chunks.size).toBe(0);
    await unmount();
  });
});
