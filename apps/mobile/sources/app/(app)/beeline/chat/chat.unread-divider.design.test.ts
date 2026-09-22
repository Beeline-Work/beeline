import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Unread-divider contract for the chat surface, matching Slack's split
 * between two controls readers read as one:
 *
 * - the NEW MESSAGES divider says where the reader's unread run began when
 *   they opened this Room. The server's cursor owns it for the whole visit
 *   and a live arrival may never move it (UDIV-03: a message landing while
 *   the reader was in history dragged the divider down onto that message,
 *   so a fresh divider appeared at the newest row out of nowhere);
 * - the "N new" control says a newer message exists that the reader cannot
 *   see. Actual viewport visibility decides it, never tail distance
 *   (UDIV-02), and reaching the newest row settles it the way a tap does.
 *
 * The divider itself is painted above its message inside that message's own
 * row (`buzz/room-message-cell.tsx`), which is upright on both lists — the
 * inverted phone list flips the column and each cell back.
 */
const chatSource = readFileSync(path.join(__dirname, '_chat-surface.tsx'), 'utf8');

describe('the chat surface unread-divider contract', () => {
  it('draws the divider from the server cursor alone', () => {
    expect(chatSource).toContain('const firstNewMessageId = firstUnreadMessageId;');
    expect(chatSource).not.toContain('newMessageQueue.boundaryId ?? firstUnreadMessageId');
  });

  it('keeps the unread boundary out of the fold without consulting the live queue', () => {
    expect(chatSource).toContain('boundaryRowIndex(anchored, firstUnreadMessageId)');
  });

  it('shows the jump control on viewport visibility, not on tail distance', () => {
    expect(chatSource).toContain(
      'newMessageControlVisible(newMessageQueue, newestMessageVisible)',
    );
    // The former gate, which rendered the control from the queue alone.
    expect(chatSource).not.toContain('{newMessageQueue.count > 0 && newMessageQueue.boundaryId &&');
  });

  it('settles the queue from the list viewability pass when the newest row is on screen', () => {
    const observer = chatSource.slice(
      chatSource.indexOf('const observeVisibleTranscriptMessages'),
      chatSource.indexOf('const landAtNewMessageBoundary'),
    );
    expect(observer).toContain('newestTranscriptMessageIdRef.current');
    expect(observer).toContain('setNewestMessageVisible(newestVisible)');
    expect(observer).toContain('if (newestVisible) setNewMessageQueue(acknowledgeNewMessageQueue)');
  });

  it('reports the newest row from chronological order so both lists agree', () => {
    expect(chatSource).toContain('newestTranscriptRowId(visibleMessages)');
  });
});
