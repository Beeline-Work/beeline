import { describe, expect, it } from 'vitest';
import type { ChatDisplayMessage } from './room-view-presentation';
import {
  EMPTY_NEW_MESSAGE_QUEUE,
  acknowledgeNewMessageQueue,
  boundaryRowIndex,
  catchUpStripVisible,
  compactNewMessageCount,
  countsAsUnread,
  messageBoundaryIds,
  newMessageBadgeCount,
  newestJumpDiscVisible,
  newestTranscriptRowId,
  queueIncomingMessages,
} from './room-new-message-boundary';

function message(id: string, isUser = false): ChatDisplayMessage {
  return { id, text: id, timestamp: 1, isUser };
}

/**
 * The phone's half of the server's one definition of unread
 * (`apps/server/src/read-cursor.ts`, `unreadMessageSql`). The server admits
 * `presentation IN ('message','system','card')` authored by somebody other
 * than the viewer; every row shape below is checked against that rule.
 */
describe('what counts as unread', () => {
  it('agrees with the server about which rows are unread mail', () => {
    expect(countsAsUnread(message('from-somebody-else'))).toBe(true);
    // The viewer's own row is never their own unread mail.
    expect(countsAsUnread(message('mine', true))).toBe(false);
    // presentation='activity' — an agent narrating the turn it is running.
    // This is what the queue used to count and the server never did.
    expect(countsAsUnread({ ...message('narration'), isAgentActivity: true })).toBe(false);
    // Neither a streaming draft nor its live turn row is a stored message yet.
    expect(countsAsUnread({ ...message('streaming'), isAgentDraft: true })).toBe(false);
    expect(countsAsUnread({ ...message('turn'), isAgentLiveTurn: true })).toBe(false);
  });

  it('keeps a narrating agent from inflating the reader\'s count', () => {
    const rows = [
      message('real'),
      { ...message('narration-a'), isAgentActivity: true },
      { ...message('narration-b'), isAgentActivity: true },
    ];
    const queue = queueIncomingMessages(EMPTY_NEW_MESSAGE_QUEUE, {
      messages: rows,
      arrivingIds: new Set(['real', 'narration-a', 'narration-b']),
      isPinnedToTail: false,
    });
    // One piece of mail arrived, not three.
    expect(queue).toEqual({ boundaryId: 'real', count: 1 });
  });
});

function from(id: string, name: string): ChatDisplayMessage {
  return {
    ...message(id),
    authorIdentity: { pubkey: `pk-${name}`, kind: 'agent', name },
  };
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

  it('names the newest row from transcript order', () => {
    expect(newestTranscriptRowId([message('old'), message('newest')])).toBe('newest');
    expect(newestTranscriptRowId([])).toBeNull();
  });

  it('CHEV-16: draws the strip from the server cursor, never from the live queue', () => {
    // The queue count only ever knows about arrivals during THIS visit, so a
    // strip sourced from it could not stand for what the reader missed while
    // away — the one thing it exists to stand for. The cursor is the gate,
    // which is the gate `/catch-up` itself runs on.
    expect(catchUpStripVisible('new-1')).toBe(true);
    expect(catchUpStripVisible(null)).toBe(false);
  });

  it('CHEV-01: shows the disc for an off-screen newest row with no queue behind it', () => {
    // The pill this replaces only ever appeared for unread mail. A reader who
    // scrolled up to re-read something had no way back to the live end.
    const scrolledIntoHistory = {
      newestMessageId: 'newest',
      newestMessageVisible: false,
      hasObservedVisibility: true,
    };
    expect(newestJumpDiscVisible(scrolledIntoHistory)).toBe(true);
    expect(newMessageBadgeCount(EMPTY_NEW_MESSAGE_QUEUE, false)).toBe(0);
    // At the newest row there is nothing to land on.
    expect(newestJumpDiscVisible({ ...scrolledIntoHistory, newestMessageVisible: true })).toBe(
      false,
    );
    // And before the list has answered anything about its viewport, a disc
    // drawn on that silence would flash over every Room at open.
    expect(newestJumpDiscVisible({ ...scrolledIntoHistory, hasObservedVisibility: false })).toBe(
      false,
    );
    expect(newestJumpDiscVisible({ ...scrolledIntoHistory, newestMessageId: null })).toBe(false);
  });

  it('CHEV-02: clears the badge on visibility while the disc itself stays up', () => {
    const queued = queueIncomingMessages(EMPTY_NEW_MESSAGE_QUEUE, {
      messages: [message('read'), from('new-1', 'Sol'), from('new-2', 'Nerd')],
      arrivingIds: new Set(['new-1', 'new-2']),
      isPinnedToTail: false,
    });
    expect(newMessageBadgeCount(queued, false)).toBe(2);
    // Seeing the newest row is what the badge counts towards: it clears there
    // without a tap, and the disc is a separate question.
    expect(newMessageBadgeCount(queued, true)).toBe(0);
    expect(
      newestJumpDiscVisible({
        newestMessageId: 'new-2',
        newestMessageVisible: false,
        hasObservedVisibility: true,
      }),
    ).toBe(true);
  });

  it('CHEV-16: carries no speaker roll of its own, only the per-visit count', () => {
    // The roll lives where the words are made (`room-catch-up-report.ts`).
    // The queue is arrival bookkeeping: a boundary and a count, nothing that
    // could be phrased at a reader.
    const queued = queueIncomingMessages(EMPTY_NEW_MESSAGE_QUEUE, {
      messages: [from('new-1', 'Sol'), from('new-2', 'Nerd')],
      arrivingIds: new Set(['new-1', 'new-2']),
      isPinnedToTail: false,
    });
    expect(Object.keys(queued).sort()).toEqual(['boundaryId', 'count']);
  });

  it('settles the queue when the reader scrolls back to the newest message', () => {
    // The count used to survive the reader's own scroll to the tail: only a
    // tap cleared it, so it sat there over a caught-up Room and armed again
    // the moment they paged back into history.
    const queued = queueIncomingMessages(EMPTY_NEW_MESSAGE_QUEUE, {
      messages: [message('read'), message('new-1'), message('new-2')],
      arrivingIds: new Set(['new-1', 'new-2']),
      isPinnedToTail: false,
    });
    const reachedTheTail = acknowledgeNewMessageQueue(queued);
    expect(reachedTheTail.count).toBe(0);
    // Scrolling away from a settled queue cannot bring the old count back.
    expect(newMessageBadgeCount(reachedTheTail, false)).toBe(0);
    expect(newMessageBadgeCount(reachedTheTail, true)).toBe(0);
  });

  it('keeps the visited divider but starts the next queue at its own earliest row', () => {
    const visited = acknowledgeNewMessageQueue({ boundaryId: 'new-1', count: 3 });
    expect(visited).toEqual({ boundaryId: 'new-1', count: 0 });
    expect(
      queueIncomingMessages(visited, {
        messages: [message('new-1'), from('new-4', 'Nerd'), from('new-5', 'Nerd')],
        arrivingIds: new Set(['new-4', 'new-5']),
        isPinnedToTail: false,
      }),
    ).toEqual({ boundaryId: 'new-4', count: 2 });
  });
});
