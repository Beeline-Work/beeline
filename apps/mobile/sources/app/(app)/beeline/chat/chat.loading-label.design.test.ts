import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Corners and Rooms share the `chat/[channelId]` route, so the pre-surface
 * loading line is the first thing a reader sees while a corner opens. It must
 * name the thing actually opening — "LOADING CORNER" when the route carries a
 * parent (every corner entry path passes `parent` on the first frame), and
 * "LOADING ROOM" otherwise — rather than always saying Room.
 */
const chatSource = readFileSync(path.join(__dirname, '[channelId].tsx'), 'utf8');

describe('the pre-surface loading label', () => {
  it('names the corner while a corner opens and the Room otherwise', () => {
    const start = chatSource.indexOf('if (!roomSurface) {');
    const end = chatSource.indexOf('<BuzzCommunityShell', start);
    const preSurface = chatSource.slice(start, end);
    expect(preSurface).toContain('<SurfaceGlyphLoader');
    expect(preSurface).toContain(
      'LOADING {(isCorner ? CORNER_LABEL : ROOM_LABEL).toUpperCase()}',
    );
    expect(preSurface).not.toContain('LOADING {ROOM_LABEL.toUpperCase()}');
    expect(preSurface).not.toContain('PixelLoader');
  });
});
