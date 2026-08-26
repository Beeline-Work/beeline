import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-native-mmkv', () => ({
  MMKV: class {
    getString() {
      return undefined;
    }
    set() {}
    delete() {}
  },
}));

import { createWorkspaceSnapshot, selectTranscript, type HumanMessage } from '@beeline/buzz-client';
import { channelCacheKey, clearBuzzLocalCache, useBuzzLocalCache } from './local-cache';
import {
  cacheLiveSessionEvents,
  drainLiveEventFrame,
  LIVE_EVENT_CHUNK_SIZE,
  LIVE_EVENT_FRAME_MAX_EVENTS,
} from './local-cache-sync';

const VIEWER = 'frame-viewer';
const ROOM = 'charles-scale-room';

function humanMessage(index: number): HumanMessage {
  return {
    type: 'human-message',
    eventId: `burst-${index}`,
    channelId: ROOM,
    workspaceId: 'workspace',
    scope: 'channel',
    authorPubkey: VIEWER,
    createdAt: index + 1,
    sourceKind: 9,
    signature: 'verified',
    body: `Captured message ${index}`,
    attachments: [],
    mentionPubkeys: [],
  } as HumanMessage;
}

beforeEach(() => {
  clearBuzzLocalCache();
  useBuzzLocalCache
    .getState()
    .replaceSnapshot(
      VIEWER,
      ROOM,
      createWorkspaceSnapshot({ workspaceId: 'workspace' }),
      undefined,
    );
});

describe('FRAME-BUDGET gate', () => {
  it('time-slices a charles-scale burst through the real live cache path', () => {
    const queue = Array.from({ length: 1_000 }, (_, index) => ({
      type: 'read-model' as const,
      sessionId: ROOM,
      event: humanMessage(index),
    }));
    let clock = 0;
    const now = () => clock;
    const writes = vi.spyOn(useBuzzLocalCache.getState(), 'replaceSnapshot');
    const firstFrame = drainLiveEventFrame(
      queue,
      (batch) => {
        cacheLiveSessionEvents(VIEWER, ROOM, batch);
        clock += 2;
      },
      { now, budgetMs: 5 },
    );

    expect(firstFrame.processed).toBeLessThanOrEqual(LIVE_EVENT_FRAME_MAX_EVENTS);
    expect(firstFrame.processed).toBeGreaterThanOrEqual(LIVE_EVENT_CHUNK_SIZE);
    expect(firstFrame.remaining).toBeGreaterThan(0);
    expect(writes).toHaveBeenCalledTimes(Math.ceil(firstFrame.processed / LIVE_EVENT_CHUNK_SIZE));

    let frames = 1;
    while (queue.length > 0) {
      clock = 0;
      drainLiveEventFrame(
        queue,
        (batch) => {
          cacheLiveSessionEvents(VIEWER, ROOM, batch);
          clock += 2;
        },
        { now, budgetMs: 5 },
      );
      frames += 1;
    }
    expect(frames).toBeGreaterThan(1);
    const snapshot =
      useBuzzLocalCache.getState().channels[channelCacheKey(VIEWER, ROOM)]!.snapshot!;
    expect(selectTranscript(snapshot, ROOM)).toHaveLength(1_000);
  });

  it('keeps corner-state churn inside the same budget as message traffic', () => {
    // A working corner republishes its kind:30078 state lease and activity
    // receipts continuously alongside its streamed reply. Those session-update
    // records ride the SAME drainLiveEventFrame pump, so the gate must hold
    // for a burst that mixes them with ordinary message rows.
    const queue = Array.from({ length: 400 }, (_, index) => {
      const message = index % 2 === 0;
      return {
        type: 'read-model' as const,
        sessionId: ROOM,
        event: message
          ? humanMessage(index)
          : ({
              type: 'session-update',
              eventId: `corner-state-${index}`,
              channelId: ROOM,
              workspaceId: 'workspace',
              scope: 'channel',
              authorPubkey: 'agent-1',
              createdAt: 5_000 + index,
              sourceKind: 30078,
              signature: 'verified',
              sessionId: ROOM,
              update: {
                kind: 'corner-state',
                cornerId: 'corner-1',
                state: 'working',
                sequence: index,
              },
            } as unknown),
      };
    });
    let clock = 0;
    const now = () => clock;
    let writes = 0;
    let frames = 0;
    while (queue.length > 0) {
      clock = 0;
      frames += 1;
      drainLiveEventFrame(
        queue,
        (batch) => {
          cacheLiveSessionEvents(VIEWER, ROOM, batch);
          writes += 1;
          clock += 2;
        },
        { now, budgetMs: 5 },
      );
    }
    // Every frame stayed within the budget (2ms per 16-event chunk against
    // the 5ms cap), so no single frame can hold an interaction hostage.
    expect(writes).toBe(Math.ceil(400 / LIVE_EVENT_CHUNK_SIZE));
    expect(frames).toBeGreaterThan(1);
    const snapshot =
      useBuzzLocalCache.getState().channels[channelCacheKey(VIEWER, ROOM)]!.snapshot!;
    expect(selectTranscript(snapshot, ROOM)).toHaveLength(200);
  });
});
