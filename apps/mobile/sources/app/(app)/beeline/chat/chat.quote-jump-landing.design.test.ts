import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import type { RoomHistoryView, RoomViewMessage } from '@beeline/buzz-client';
import { useRoomTranscriptHistory } from '@/buzz/use-room-transcript-history';
import { shouldCoverMessageSource, shouldReleaseMessageSourceCover } from '@/buzz/message-source-cover';

const message = (digit: string, createdAt: number): RoomViewMessage => ({
  id: digit.repeat(64), createdAt, text: digit, presentation: 'message',
  author: { pubkey: 'a'.repeat(64), kind: 'human', name: 'Owner' },
});

it('loads a distant target in one anchored read and makes it resident', async () => {
  const target = message('b', 2);
  const around = vi.fn(async (): Promise<RoomHistoryView> => ({
    roomId: 'room', messages: [message('a', 1), target, message('c', 3)],
  }));
  const history = vi.fn(async (): Promise<RoomHistoryView> => ({ roomId: 'room', messages: [] }));
  let state: ReturnType<typeof useRoomTranscriptHistory>;
  function Probe() {
    state = useRoomTranscriptHistory({
      roomId: 'room', tailMessages: [message('f', 6)],
      roomClient: { history, historyAround: around }, enabled: true, initialVisibleCount: 1,
    });
    return React.createElement('Probe');
  }
  let renderer: ReturnType<typeof create>;
  await act(async () => { renderer = create(React.createElement(Probe)); });
  await act(async () => { state!.loadAround(target.id); });
  expect(around).toHaveBeenCalledExactlyOnceWith('room', target.id);
  expect(history).not.toHaveBeenCalled();
  expect(state!.aroundPage.map((row) => row.id)).toContain(target.id);
  expect(state!.aroundStatus).toBe('idle');
  await act(async () => { renderer!.unmount(); });
});

describe('message-source cover', () => {
  it('covers resident offscreen targets and releases after visibility or touch', () => {
    expect(shouldCoverMessageSource({ desktop: false, abandoned: false, targetVisible: false })).toBe(true);
    expect(shouldCoverMessageSource({ desktop: false, abandoned: true, targetVisible: false })).toBe(false);
    expect(shouldCoverMessageSource({ desktop: false, abandoned: false, targetVisible: true })).toBe(false);
    expect(shouldReleaseMessageSourceCover({ abandoned: false, targetVisible: true, retryAttempts: 0 })).toBe(true);
  });

  it('releases the cover when the retry budget ends', () => {
    expect(shouldReleaseMessageSourceCover({ abandoned: false, targetVisible: false, retryAttempts: 7 })).toBe(false);
    expect(shouldReleaseMessageSourceCover({ abandoned: false, targetVisible: false, retryAttempts: 8 })).toBe(true);
  });
});
