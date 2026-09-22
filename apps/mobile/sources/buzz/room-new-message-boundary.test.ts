import { describe, expect, it } from 'vitest';
import type { ChatDisplayMessage } from './room-view-presentation';
import {
  EMPTY_NEW_MESSAGE_QUEUE,
  acknowledgeNewMessageQueue,
  boundaryRowIndex,
  compactNewMessageCount,
  messageBoundaryIds,
  queueIncomingMessages,
} from './room-new-message-boundary';

function message(id: string, isUser = false): ChatDisplayMessage {
  return { id, text: id, timestamp: 1, isUser };
}

describe('new-message boundary', () => {
  it('resolves an exact row or a relayed message nested inside its host', () => {
    const rows = [
      message('read'),
      { ...message('host'), relayReports: [message('relayed')] },
      message('later'),
    ];
    expect(boundaryRowIndex(rows, 'host')).toBe(1);
    expect(boundaryRowIndex(rows, 'relayed')).toBe(1);
    expect(boundaryRowIndex(rows, 'missing')).toBe(-1);
  });

  it('resolves and queues a new fact folded into an existing virtualized row', () => {
    const folded = { ...message('old'), foldedIds: ['old', 'new-fact'] };
    expect(boundaryRowIndex([folded], 'new-fact')).toBe(0);
    expect(messageBoundaryIds(folded)).toEqual(['old', 'new-fact']);
    expect(
      queueIncomingMessages(EMPTY_NEW_MESSAGE_QUEUE, {
        messages: [folded],
        arrivingIds: new Set(['new-fact']),
        isPinnedToTail: false,
      }),
    ).toEqual({ boundaryId: 'new-fact', count: 1 });
  });

  it('holds history, anchors the first incoming row, and accumulates later arrivals', () => {
    const first = queueIncomingMessages(EMPTY_NEW_MESSAGE_QUEUE, {
      messages: [message('read'), message('new-1'), message('new-2')],
      arrivingIds: new Set(['new-1', 'new-2']),
      isPinnedToTail: false,
    });
    expect(first).toEqual({ boundaryId: 'new-1', count: 2 });
    expect(
      queueIncomingMessages(first, {
        messages: [message('read'), message('new-1'), message('new-2'), message('new-3')],
        arrivingIds: new Set(['new-3']),
        isPinnedToTail: false,
      }),
    ).toEqual({ boundaryId: 'new-1', count: 3 });
  });

  it('does not queue the viewer own send or an arrival already followed at the tail', () => {
    expect(
      queueIncomingMessages(EMPTY_NEW_MESSAGE_QUEUE, {
        messages: [message('mine', true)],
        arrivingIds: new Set(['mine']),
        isPinnedToTail: false,
      }),
    ).toBe(EMPTY_NEW_MESSAGE_QUEUE);
    expect(
      queueIncomingMessages(EMPTY_NEW_MESSAGE_QUEUE, {
        messages: [message('incoming')],
        arrivingIds: new Set(['incoming']),
        isPinnedToTail: true,
      }),
    ).toBe(EMPTY_NEW_MESSAGE_QUEUE);
  });

  it('compacts fixed-width counts at nine', () => {
    expect(compactNewMessageCount(1)).toBe('1');
    expect(compactNewMessageCount(9)).toBe('9');
    expect(compactNewMessageCount(10)).toBe('9+');
  });

  it('keeps the visited divider but starts the next queue at its own earliest row', () => {
    const visited = acknowledgeNewMessageQueue({ boundaryId: 'new-1', count: 3 });
    expect(visited).toEqual({ boundaryId: 'new-1', count: 0 });
    expect(
      queueIncomingMessages(visited, {
        messages: [message('new-1'), message('new-4'), message('new-5')],
        arrivingIds: new Set(['new-4', 'new-5']),
        isPinnedToTail: false,
      }),
    ).toEqual({ boundaryId: 'new-4', count: 2 });
  });
});
