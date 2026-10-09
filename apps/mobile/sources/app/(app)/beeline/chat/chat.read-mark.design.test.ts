import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Read-mark advancement contract for the chat surface. A Room the viewer is
 * sitting in must never report its own messages back as unread, and must
 * never report as READ what the viewer has not actually seen:
 *
 * - sending a message advances the read mark to that message in the same
 *   server write (`advanceAuthorReadMark`, apps/server/src/phone-service.ts;
 *   read-cursor.test.ts) — otherwise leaving the Room right after sending
 *   leaves a stale mark that golds the deck row for a message the viewer
 *   wrote (captain report 2026-09-02). The phone spends no second request;
 * - every OTHER advance comes from the viewport. A fetched Room view says
 *   what exists, not what was seen; marking its tail read cleared the badge
 *   for messages sitting far below the fold, so the session no longer does
 *   it and the list's own viewability pass owns the boundary instead;
 * - the server side independently refuses to count viewer-authored rows
 *   toward `unread` (apps/server/src/phone-service.ts).
 */
const chatSource = readFileSync(path.join(__dirname, '_chat-surface.tsx'), 'utf8');
const sessionSource = readFileSync(path.join(__dirname, 'useRoomSurfaceSession.ts'), 'utf8');

describe('the chat surface read-mark contract', () => {
  it('leaves the sent message’s read mark to the send itself, and rereads no Room for it', () => {
    // The server moves the author's mark in the send's own write, so the
    // phone neither posts a second mark nor reads the whole Room back.
    const sendBlock = chatSource.slice(
      chatSource.indexOf('await sendTransport.publishPreparedMessage(preparedEvent);'),
      chatSource.indexOf('scheduleOutboxConfirmation(preparedEvent.id);'),
    );
    expect(sendBlock.length).toBeGreaterThan(0);
    expect(sendBlock).not.toContain('markRead(');
    expect(sendBlock).not.toContain('refreshSignal.signal()');
  });

  it('advances the read mark from the viewport, not from the applied view', () => {
    // The scheduler's apply must hold no read-mark write at all: the tail of
    // a fetched view is exactly the thing the reader may not have reached.
    expect(sessionSource).not.toContain('markRead(channelId, latest.id)');
    const observer = chatSource.slice(
      chatSource.indexOf('const observeVisibleTranscriptMessages'),
      chatSource.indexOf('// Back from the code reader'),
    );
    expect(observer).toContain('advanceReadCursor(chronologicalMessagesRef.current, visibleRows)');
  });

  it('re-arms the advancer when a visit begins, not only when the Room changes', () => {
    // mark-unread suspends the advancer so the viewport cannot read back what
    // the reader just declared unread. Re-arming only on `channelId` left that
    // suspension permanent for a reader who reopened the SAME Room: the id
    // never changed, so nothing resumed (review 2026-09-22).
    const focusEffect = sessionSource.slice(
      sessionSource.indexOf('useEffect(() => {\n    if (isFocused) {'),
      sessionSource.indexOf('}, [isFocused]);'),
    );
    expect(focusEffect).toContain('readCursorRef.current?.resume()');
    expect(focusEffect).toContain('readCursorRef.current?.flush()');
  });

  it('does not expose a manual mark-unread action', () => {
    expect(chatSource).not.toContain('label="Mark unread"');
    expect(chatSource).not.toContain('accessibilityLabel="Mark unread from this message"');
    expect(chatSource).not.toContain('testID="message-mark-unread-action"');
    expect(chatSource).not.toContain('const handleMarkUnread = useCallback(');
  });

  it('ranks the read cursor against chronological order, never the inverted list', () => {
    // `transcriptMessages` IS `invertedMessages` on the phone. The cursor
    // decides which visible row is newest by its index, so handing it that
    // array picks the OLDEST visible row and reads a scroll back up the
    // transcript as forward progress (review 2026-09-22).
    expect(chatSource).toContain('const chronologicalMessagesRef = useRef(visibleMessages)');
    const observer = chatSource.slice(
      chatSource.indexOf('const observeVisibleTranscriptMessages'),
      chatSource.indexOf('// Back from the code reader'),
    );
    expect(observer).not.toContain('advanceReadCursor(transcriptMessagesRef');
  });
});
