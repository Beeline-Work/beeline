import { describe, expect, it } from 'vitest';

import type { CornerSummary, CornerStatus } from './corners';
import { isRoomAlive, NO_ACTIVITY_PREVIEW, roomRowPresentation } from './room-list-row';

function corner(status: CornerStatus, name = `corner-${status}`): CornerSummary {
  return { id: `${status}-id`, name, openerPubkey: 'opener', status };
}

const NO_NAMES = new Map<string, string>();

describe('Room row presentation', () => {
  it('marks a Room with a working agent as alive, and an idle one not', () => {
    // Gold is spent here and nowhere else on the index, so this is the single
    // condition the whole accent rule rests on.
    expect(roomRowPresentation({ corners: [corner('live')] }, NO_NAMES)).toMatchObject({
      live: true,
      glyph: '◆',
    });
    expect(isRoomAlive([corner('live')])).toBe(true);

    for (const idle of ['open', 'needs-attention', 'merged', 'archived', 'failed'] as const) {
      const row = roomRowPresentation({ corners: [corner(idle)] }, NO_NAMES);
      expect(row.live, `a ${idle} corner is not live work`).toBe(false);
      expect(isRoomAlive([corner(idle)])).toBe(false);
    }

    // A Room with no corners at all is never alive.
    expect(roomRowPresentation({}, NO_NAMES).live).toBe(false);
    expect(isRoomAlive(undefined)).toBe(false);
  });

  it('escalates a corner waiting on a person without spending the accent', () => {
    const row = roomRowPresentation({ corners: [corner('needs-attention')] }, NO_NAMES);
    expect(row).toMatchObject({ attention: true, live: false, glyph: '▲' });
  });

  it('reports the loudest corner state when several are open at once', () => {
    const row = roomRowPresentation(
      { corners: [corner('open'), corner('live'), corner('needs-attention')] },
      NO_NAMES,
    );
    expect(row.live).toBe(true);
    expect(row.glyph).toBe('◆');
    expect(row.corners).toHaveLength(3);
  });

  it('counts exactly the corners the dropdown will list', () => {
    // The count and the expand must agree: terminal and failed corners are
    // excluded outright rather than dimmed, so a person is never offered a
    // number that expands into fewer rows.
    const row = roomRowPresentation(
      {
        corners: [
          corner('live'),
          corner('needs-attention'),
          corner('open'),
          corner('failed'),
          corner('merged'),
          corner('archived'),
        ],
      },
      NO_NAMES,
    );
    expect(row.corners.map((entry) => entry.status)).toEqual([
      'live',
      'needs-attention',
      'open',
    ]);
  });

  it('falls back to the spoken-in / quiet glyphs when no corner reports', () => {
    expect(roomRowPresentation({ latestMessage: 'we shipped it' }, NO_NAMES).glyph).toBe('›');
    expect(roomRowPresentation({}, NO_NAMES).glyph).toBe('·');
    // A corner that is merely open reports nothing: the leading mark is for
    // work that is happening or stuck, and an idle corner is neither. It still
    // counts in the gutter, so the expand affordance is unaffected.
    const idle = roomRowPresentation(
      { corners: [corner('open')], latestMessage: 'we shipped it' },
      NO_NAMES,
    );
    expect(idle.glyph).toBe('›');
    expect(idle.corners).toHaveLength(1);
  });

  it('declines a stale cached preview that is nothing but a ref or an id', () => {
    // The stored preview is sanitized where it is written, but a cache entry
    // written by an older build outlives the fix — the index must never print
    // `remote/1a2b3c4` while waiting for the revalidation that replaces it.
    for (const plumbing of ['remote/1a2b3c4', 'refs/heads/main', 'origin/main', '1a2b3c4d5e6']) {
      expect(roomRowPresentation({ latestMessage: plumbing }, NO_NAMES).preview, plumbing).toBe(
        NO_ACTIVITY_PREVIEW,
      );
    }
    // Prose that merely mentions one is still the best thing the row has.
    expect(
      roomRowPresentation({ latestMessage: 'pushed 1a2b3c4 to origin/main' }, NO_NAMES).preview,
    ).toBe('pushed 1a2b3c4 to origin/main');
  });

  it('states plainly when a Room holds nothing readable', () => {
    expect(roomRowPresentation({}, NO_NAMES).preview).toBe(NO_ACTIVITY_PREVIEW);
    // `roomPreviewText` stores `''` for a message that was entirely plumbing,
    // so the row must treat an empty preview as "nothing said", never print it.
    expect(roomRowPresentation({ latestMessage: '' }, NO_NAMES).preview).toBe(NO_ACTIVITY_PREVIEW);
    expect(roomRowPresentation({ latestMessage: '   ' }, NO_NAMES).preview).toBe(
      NO_ACTIVITY_PREVIEW,
    );
  });

  it('attributes the activity line only when the author is on the roster', () => {
    const names = new Map([['author-1', 'Bobby']]);
    expect(
      roomRowPresentation({ latestMessage: 'on it', latestMessageAuthor: 'author-1' }, names)
        .author,
    ).toBe('BOBBY');
    expect(
      roomRowPresentation({ latestMessage: 'on it', latestMessageAuthor: 'stranger' }, names)
        .author,
    ).toBe('');
    expect(roomRowPresentation({ latestMessage: 'on it' }, names).author).toBe('');
  });
});
