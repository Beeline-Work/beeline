import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import type { RoomHistoryView, RoomViewMessage } from '@beeline/buzz-client';
import { useRoomTranscriptHistory } from '@/buzz/use-room-transcript-history';
import { shouldCoverMessageSource, shouldReleaseMessageSourceCover } from '@/buzz/message-source-cover';
import { completeMessageSourceLanding, startMessageSourceLanding } from '@/buzz/message-source-landing';
import { messageJumpHref } from '@/buzz/corner-navigation';
import { displayRoomMessages, mergeDisplayPages } from '@/buzz/room-view-presentation';

const message = (digit: string, createdAt: number): RoomViewMessage => ({
  id: digit.repeat(64), createdAt, text: digit, presentation: 'message',
  author: { pubkey: 'a'.repeat(64), kind: 'human', name: 'Owner' },
});

it.each(['quote', 'notification', 'bookmark'])('%s fetches a distant target for the landing helper', async (source) => {
  const target = message('b', 2);
  const route = messageJumpHref('room', target.id, `${source}:${target.id}`);
  const around = vi.fn(async (): Promise<RoomHistoryView> => ({
    roomId: 'room', messages: [message('a', 1), target, message('c', 3)],
  }));
  const history = vi.fn(async (): Promise<RoomHistoryView> => ({ roomId: 'room', messages: [] }));
  let state: ReturnType<typeof useRoomTranscriptHistory>;
  function Probe() {
    state = useRoomTranscriptHistory({
      roomId: route.params.channelId, tailMessages: [message('f', 6)],
      roomClient: { history, historyAround: around }, enabled: true, initialVisibleCount: 1,
    });
    return React.createElement('Probe');
  }
  let renderer: ReturnType<typeof create>;
  await act(async () => { renderer = create(React.createElement(Probe)); });
  await act(async () => { state!.loadAround(route.params.notificationMessageId); });
  expect(around).toHaveBeenCalledExactlyOnceWith('room', target.id);
  expect(history).not.toHaveBeenCalled();
  expect(state!.aroundPage.map((row) => row.id)).toContain(target.id);

  const landing = startMessageSourceLanding(target.id);
  let coverVisible = shouldCoverMessageSource({ desktop: false, abandoned: false });
  const scrollToIndex = vi.fn();
  const flash = vi.fn();
  const input = {
    landing,
    messageAnchorId: route.params.notificationMessageId,
    abandoned: false,
    rows: [...state!.aroundPage, message('f', 6)],
    scrollToIndex,
    flash,
    dismissCover: () => { coverVisible = false; },
  };
  expect(completeMessageSourceLanding({ ...input, visibleMessageIds: new Set<string>() })).toBe(false);
  expect(coverVisible).toBe(true);
  expect(completeMessageSourceLanding({ ...input, abandoned: true, visibleMessageIds: new Set([target.id]) })).toBe(false);
  expect(scrollToIndex).not.toHaveBeenCalled();
  expect(completeMessageSourceLanding({ ...input, visibleMessageIds: new Set([target.id]) })).toBe(true);
  expect(scrollToIndex).toHaveBeenCalledExactlyOnceWith(1);
  expect(flash).toHaveBeenCalledExactlyOnceWith(target.id);
  expect(coverVisible).toBe(false);
  expect(completeMessageSourceLanding({ ...input, visibleMessageIds: new Set([target.id]) })).toBe(false);
  await act(async () => { renderer!.unmount(); });
});

it('joins a 227-message Room from message 27 to the tail without gaps or duplicates', async () => {
  const all = Array.from({ length: 227 }, (_, index) => ({
    ...message('a', index + 1),
    id: (index + 1).toString(16).padStart(64, '0'),
  }));
  const tail = all.slice(197);
  const target = all[26]!;
  const around = vi.fn(async (): Promise<RoomHistoryView> => ({
    roomId: 'room', messages: all.slice(11, 41),
  }));
  const historyAfter = vi.fn(async (_roomId: string, afterId: string): Promise<RoomHistoryView> => {
    const index = all.findIndex((row) => row.id === afterId);
    return { roomId: 'room', messages: all.slice(index + 1, index + 31) };
  });
  const history = vi.fn(async (_roomId: string, before?: { id: string }): Promise<RoomHistoryView> => {
    const index = all.findIndex((row) => row.id === before?.id);
    const start = Math.max(0, index - 30);
    return {
      roomId: 'room', messages: all.slice(start, index),
      ...(start > 0 ? { nextBefore: { createdAt: all[start]!.createdAt, id: all[start]!.id } } : {}),
    };
  });
  let state: ReturnType<typeof useRoomTranscriptHistory>;
  function Probe() {
    state = useRoomTranscriptHistory({
      roomId: 'room', tailMessages: tail,
      roomClient: { history, historyAfter, historyAround: around },
      enabled: true, initialVisibleCount: 30,
    });
    const anchored = displayRoomMessages(state.segmentRows, 'a'.repeat(64));
    const recent = displayRoomMessages(tail, 'a'.repeat(64));
    const rows = state.anchoredSegmentActive ? anchored : mergeDisplayPages(anchored, recent);
    return React.createElement('Transcript', {
      onForwardEdge: state.loadNewerAround,
      onBackwardEdge: () => state.loadOlder(rows.length),
    }, rows.map((row) => React.createElement('Message', { key: row.id, id: row.id })));
  }
  let renderer: ReturnType<typeof create>;
  await act(async () => { renderer = create(React.createElement(Probe)); });
  await act(async () => { state!.loadAround(target.id); });
  expect(state!.anchoredSegmentActive).toBe(true);
  expect(renderer!.root.findAllByType('Message')).toHaveLength(30);
  await act(async () => { renderer!.root.findByType('Transcript').props.onBackwardEdge(); });
  for (let step = 0; step < 8 && !state!.aroundJoined; step += 1) {
    await act(async () => { renderer!.root.findByType('Transcript').props.onForwardEdge(); });
  }
  expect(state!.aroundJoined).toBe(true);
  const ids = renderer!.root.findAllByType('Message').map((node: { props: { id: string } }) => node.props.id);
  expect(ids).toEqual(all.map((row) => row.id));
  expect(new Set(ids).size).toBe(227);
  expect(historyAfter).toHaveBeenCalledTimes(6);
  await act(async () => { renderer!.unmount(); });
});

it('ignores an anchored response after the reader abandons the jump', async () => {
  const target = message('b', 2);
  let resolveAround!: (page: RoomHistoryView) => void;
  const pending = new Promise<RoomHistoryView>((resolve) => { resolveAround = resolve; });
  let state: ReturnType<typeof useRoomTranscriptHistory>;
  function Probe() {
    state = useRoomTranscriptHistory({
      roomId: 'room', tailMessages: [message('f', 6)],
      roomClient: {
        history: async () => ({ roomId: 'room', messages: [] }),
        historyAround: () => pending,
      },
      enabled: true, initialVisibleCount: 1,
    });
    return React.createElement('Transcript', null,
      state.segmentRows.map((row) => React.createElement('Message', { key: row.id, id: row.id })));
  }
  let renderer: ReturnType<typeof create>;
  await act(async () => { renderer = create(React.createElement(Probe)); });
  act(() => { state!.loadAround(target.id); });
  act(() => { state!.abandonAround(); });
  await act(async () => {
    resolveAround({ roomId: 'room', messages: [target] });
    await pending;
  });
  expect(state!.aroundPage).toEqual([]);
  expect(renderer!.root.findAllByType('Message')).toEqual([]);
  await act(async () => { renderer!.unmount(); });
});

describe('message-source cover', () => {
  it('covers resident offscreen targets until touch', () => {
    expect(shouldCoverMessageSource({ desktop: false, abandoned: false })).toBe(true);
    expect(shouldCoverMessageSource({ desktop: false, abandoned: true })).toBe(false);
  });

  it('releases the cover when the retry budget ends', () => {
    expect(shouldReleaseMessageSourceCover({ abandoned: false, retryAttempts: 7 })).toBe(false);
    expect(shouldReleaseMessageSourceCover({ abandoned: false, retryAttempts: 8 })).toBe(true);
  });
});
