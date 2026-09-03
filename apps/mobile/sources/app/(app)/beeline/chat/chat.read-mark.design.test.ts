import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Read-mark advancement contract for the chat surface. A Room the viewer is
 * sitting in must never report its own messages back as unread:
 *
 * - sending a message advances the read mark to that message immediately
 *   (optimistically, before the next scheduled fetch) — otherwise leaving
 *   the Room right after sending leaves a stale mark that golds the deck row
 *   for a message the viewer wrote (captain report 2026-09-02);
 * - a fetched Room view applied while the surface is mounted advances the
 *   mark to its latest message — the one "visible arrival" path, owned by
 *   the session's refresh scheduler;
 * - the server side independently refuses to count viewer-authored rows
 *   toward `unread` (apps/server/src/phone-service.ts).
 */
const chatSource = readFileSync(path.join(__dirname, '[channelId].tsx'), 'utf8');
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

  it('advances the read mark on every Room view applied while the surface is open', () => {
    expect(sessionSource).toContain('markRead(channelId, latest.id)');
  });
});
