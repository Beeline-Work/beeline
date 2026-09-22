import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The transitions themselves are driven for real in
 * `buzz/use-new-message-control.test.tsx`, which mounts the hook and the
 * production divider cell and makes each failure happen. What is left for this
 * file is the wiring a mounted hook cannot see: that the surface hands the hook
 * the right four inputs, and that no second path to the divider or the control
 * has grown back beside it.
 */
const chatSource = readFileSync(path.join(__dirname, '_chat-surface.tsx'), 'utf8');

describe('the chat surface unread-divider wiring', () => {
  it('draws divider and control from the one hook, with no second path', () => {
    expect(chatSource).toContain('useNewMessageControl({');
    expect(chatSource).toContain('dividerMessageId: firstNewMessageId');
    expect(chatSource).toContain('controlVisible: newMessageControlShown');
    expect(chatSource).toContain('{newMessageControlShown && (');
    // The coupling this change removed, in either of the shapes it had.
    expect(chatSource).not.toContain('newMessageQueue.boundaryId ?? firstUnreadMessageId');
    expect(chatSource).not.toContain('{newMessageQueue.count > 0 && newMessageQueue.boundaryId &&');
    // The queue is the hook's to move. A setter here would be a way around it.
    expect(chatSource).not.toContain('setNewMessageQueue');
  });

  it('gives the hook the server cursor, the folded rows, and the arriving ids', () => {
    const call = chatSource.slice(
      chatSource.indexOf('useNewMessageControl({'),
      chatSource.indexOf('const transcriptLandingAnchorId'),
    );
    expect(call).toContain('roomId: decodedId');
    expect(call).toContain('queueableMessages: foldedMessages');
    expect(call).toContain('arrivingIds: transcriptArrivalObservation.arrivingIds');
    expect(call).toContain('newestMessageId: newestTranscriptMessageId');
    expect(call).toContain('firstUnreadMessageId,');
    // Tail distance reaches the hook for queueing only; what the control shows
    // is decided by the viewability pass below.
    expect(call).toContain('isPinnedToTail: () => isPinnedToTailRef.current');
  });

  it('feeds the hook the list’s own viewability pass', () => {
    const observer = chatSource.slice(
      chatSource.indexOf('const observeVisibleTranscriptMessages'),
      chatSource.indexOf('const landAtNewMessageBoundary'),
    );
    expect(observer).toContain('observeVisibleMessages(visibleTranscriptMessagesRef.current)');
    expect(chatSource).toContain('onViewableItemsChanged={observeVisibleTranscriptMessages}');
  });

  it('keeps the unread boundary out of the fold without consulting the live queue', () => {
    expect(chatSource).toContain('boundaryRowIndex(anchored, firstUnreadMessageId)');
  });

  it('reports the newest row from chronological order so both lists agree', () => {
    expect(chatSource).toContain('newestTranscriptRowId(visibleMessages)');
  });
});
