import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Read-mark advancement contract for the chat surface. A Room the viewer is
 * sitting in must never report its own messages back as unread, and must
 * never report as READ what the viewer has not actually seen:
 *
 * - sending a message advances the read mark to that message immediately
 *   (optimistically, before the next scheduled fetch) — otherwise leaving
 *   the Room right after sending leaves a stale mark that golds the deck row
 *   for a message the viewer wrote (captain report 2026-09-02);
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
  it('advances the read mark to the sent message immediately after publish', () => {
    // The send path marks read BEFORE the refresh signal, so the mark can
    // never lag behind a message the viewer just wrote.
    const sendBlock = chatSource.slice(
      chatSource.indexOf('await sendTransport.publishPreparedMessage(preparedEvent);'),
      chatSource.indexOf('refreshSignal.signal();'),
    );
    expect(sendBlock).toContain('markRead(decodedId, preparedEvent.id)');
  });

  it('advances the read mark from the viewport, not from the applied view', () => {
    // The scheduler's apply must hold no read-mark write at all: the tail of
    // a fetched view is exactly the thing the reader may not have reached.
    expect(sessionSource).not.toContain('markRead(channelId, latest.id)');
    const observer = chatSource.slice(
      chatSource.indexOf('const observeVisibleTranscriptMessages'),
      chatSource.indexOf('const landAtNewMessageBoundary'),
    );
    expect(observer).toContain(
      'advanceReadCursor(chronologicalMessagesRef.current, visibleTranscriptMessagesRef.current)',
    );
  });

  it('ranks the read cursor against chronological order, never the inverted list', () => {
    // `transcriptMessages` IS `invertedMessages` on the phone. The cursor
    // decides which visible row is newest by its index, so handing it that
    // array picks the OLDEST visible row and reads a scroll back up the
    // transcript as forward progress (review 2026-09-22).
    expect(chatSource).toContain('const chronologicalMessagesRef = useRef(visibleMessages)');
    const observer = chatSource.slice(
      chatSource.indexOf('const observeVisibleTranscriptMessages'),
      chatSource.indexOf('const landAtNewMessageBoundary'),
    );
    expect(observer).not.toContain('advanceReadCursor(transcriptMessagesRef');
  });
});
