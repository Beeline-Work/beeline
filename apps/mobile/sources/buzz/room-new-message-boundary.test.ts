import { describe, expect, it } from 'vitest';
import type { ChatDisplayMessage } from './room-view-presentation';
import {
  EMPTY_NEW_MESSAGE_QUEUE,
  acknowledgeNewMessageQueue,
  boundaryRowIndex,
  catchUpStripVisible,
  compactNewMessageCount,
  messageBoundaryIds,
  newMessageBadgeCount,
  newestJumpDiscVisible,
  newestTranscriptRowId,
  queueIncomingMessages,
} from './room-new-message-boundary';

function message(id: string, isUser = false): ChatDisplayMessage {
  return { id, text: id, timestamp: 1, isUser };
}

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
    ).toEqual({ boundaryId: 'new-fact', count: 1, authors: [] });
  });

  it('holds history, anchors the first incoming row, and accumulates later arrivals', () => {
    const first = queueIncomingMessages(EMPTY_NEW_MESSAGE_QUEUE, {
      messages: [message('read'), message('new-1'), message('new-2')],
      arrivingIds: new Set(['new-1', 'new-2']),
      isPinnedToTail: false,
    });
    expect(first).toEqual({ boundaryId: 'new-1', count: 2, authors: [] });
    expect(
      queueIncomingMessages(first, {
        messages: [message('read'), message('new-1'), message('new-2'), message('new-3')],
        arrivingIds: new Set(['new-3']),
        isPinnedToTail: false,
      }),
    ).toEqual({ boundaryId: 'new-1', count: 3, authors: [] });
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

  it('hides the catch-up strip while any pixel of the newest message is on screen', () => {
    // UDIV-02: the reader is a finger's width above the geometric tail, so
    // the pin test says "not at the tail" and the batch queues — but they
    // are looking straight at the newest message, so there is nothing to
    // catch up on and Slack shows no strip.
    const queued = queueIncomingMessages(EMPTY_NEW_MESSAGE_QUEUE, {
      messages: [message('read'), message('new-1')],
      arrivingIds: new Set(['new-1']),
      isPinnedToTail: false,
    });
    expect(queued).toEqual({ boundaryId: 'new-1', count: 1, authors: [] });
    expect(catchUpStripVisible(queued, true)).toBe(false);
    expect(catchUpStripVisible(queued, false)).toBe(true);
    expect(catchUpStripVisible(EMPTY_NEW_MESSAGE_QUEUE, false)).toBe(false);
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

  it('CHEV-03: rolls the queue up by speaker identity, not by display name', () => {
    const two = queueIncomingMessages(EMPTY_NEW_MESSAGE_QUEUE, {
      messages: [from('new-1', 'Sol'), from('new-2', 'Nerd')],
      arrivingIds: new Set(['new-1', 'new-2']),
      isPinnedToTail: false,
    });
    expect(two.authors).toEqual([
      { pubkey: 'pk-Sol', name: 'Sol' },
      { pubkey: 'pk-Nerd', name: 'Nerd' },
    ]);

    // The same speaker again is the same entry; a DIFFERENT person who happens
    // to share that name is not. Deduplicating the strings lost the second one
    // and undercounted how many the reader was behind on.
    const sameName = queueIncomingMessages(two, {
      messages: [
        from('new-3', 'Sol'),
        { ...from('new-4', 'Sol'), authorIdentity: { pubkey: 'pk-other', kind: 'human', name: 'Sol' } },
      ],
      arrivingIds: new Set(['new-3', 'new-4']),
      isPinnedToTail: false,
    });
    expect(sameName.authors).toEqual([
      { pubkey: 'pk-Sol', name: 'Sol' },
      { pubkey: 'pk-Nerd', name: 'Nerd' },
      { pubkey: 'pk-other', name: 'Sol' },
    ]);
    expect(sameName.count).toBe(4);
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
    expect(catchUpStripVisible(reachedTheTail, true)).toBe(false);
    // Scrolling away from a settled queue cannot bring the old count back.
    expect(catchUpStripVisible(reachedTheTail, false)).toBe(false);
    expect(newMessageBadgeCount(reachedTheTail, false)).toBe(0);
  });

  it('keeps the visited divider but starts the next queue at its own earliest row', () => {
    const visited = acknowledgeNewMessageQueue({
      boundaryId: 'new-1',
      count: 3,
      authors: [{ pubkey: 'pk-Sol', name: 'Sol' }],
    });
    expect(visited).toEqual({ boundaryId: 'new-1', count: 0, authors: [] });
    expect(
      queueIncomingMessages(visited, {
        messages: [message('new-1'), from('new-4', 'Nerd'), from('new-5', 'Nerd')],
        arrivingIds: new Set(['new-4', 'new-5']),
        isPinnedToTail: false,
      }),
      // The visited batch's speakers do not carry into the next run.
    ).toEqual({
      boundaryId: 'new-4',
      count: 2,
      authors: [{ pubkey: 'pk-Nerd', name: 'Nerd' }],
    });
  });
});
