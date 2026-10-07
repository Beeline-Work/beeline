import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Corners and Rooms share the `chat/[channelId]` route. Inside a corner, the
 * phone swipe-right forward and the desktop header door's long press open a
 * new corner the same way a Room does. The server only accepts a top-level
 * Room as a corner's parent, so both paths create and open the new corner
 * under the parent Room, never under the corner itself.
 */
const chatSource = readFileSync(path.join(__dirname, '_chat-surface.tsx'), 'utf8');

describe('opening a corner from inside a corner', () => {
  it('offers the swipe-right forward in corners as in Rooms', () => {
    const start = chatSource.indexOf('? { onForwardToNewCorner: handleForwardToNewCorner }');
    const gate = chatSource.slice(chatSource.lastIndexOf('{...(', start), start);
    expect(gate).toContain('!isDirectMessage && !isArchived && !viewerIsAgent && !desktopExperience');
    expect(gate).not.toContain('isCorner');
  });

  it('shows the corners door in a desktop corner header', () => {
    expect(chatSource).toContain(
      '{(!parentChannelId || desktopExperience) && !isDirectMessage && (',
    );
    expect(chatSource).toContain('router.push(roomCornersHref(parentChannelId ?? decodedId))');
  });

  it('creates and opens both new-corner paths under the parent Room', () => {
    for (const name of ['const handleOpenRandomCorner', 'const confirmForwardToNewCorner']) {
      const start = chatSource.indexOf(name);
      const body = chatSource.slice(start, chatSource.indexOf('}, [', start));
      expect(body).toContain('roomId: parentChannelId ?? decodedId,');
      expect(body).toContain('openDesktopCorner(parentChannelId ?? decodedId, cornerId)');
      expect(body).toContain('router.push(cornerHref(cornerId, parentChannelId ?? decodedId, title))');
      expect(body).not.toMatch(/^\s+roomId: decodedId,$/m);
    }
  });
});
