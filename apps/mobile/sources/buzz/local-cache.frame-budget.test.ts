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
});
