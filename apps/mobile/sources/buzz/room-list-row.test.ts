import { describe, expect, it } from 'vitest';

import type { CornerSummary, CornerStatus } from './corners';
import {
  isRoomAlive,
  NO_ACTIVITY_PREVIEW,
  roomListSections,
  roomRowPresentation,
} from './room-list-row';

function corner(status: CornerStatus, name = `corner-${status}`): CornerSummary {
  return { id: `${status}-id`, name, openerPubkey: 'opener', status, lastActivityAt: 10 };
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

  it('puts review-ready and failed work above live work, then leaves the rest quiet', () => {
    expect(roomRowPresentation({ corners: [corner('open')] }, NO_NAMES).zone).toBe('needs-you');
    expect(roomRowPresentation({ corners: [corner('failed')] }, NO_NAMES).zone).toBe('needs-you');
    expect(roomRowPresentation({ corners: [corner('live')] }, NO_NAMES).zone).toBe('working');
    expect(roomRowPresentation({ corners: [corner('merged')] }, NO_NAMES).zone).toBe('quiet');
    expect(roomRowPresentation({}, NO_NAMES).zone).toBe('quiet');
  });

  it('reports action-needed before concurrent live work when several corners are open', () => {
    const row = roomRowPresentation(
      { corners: [corner('open'), corner('live'), corner('needs-attention')] },
      NO_NAMES,
    );
    expect(row.live).toBe(true);
    expect(row.glyph).toBe('▲');
    expect(row.zone).toBe('needs-you');
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
    expect(row.corners.map((entry) => entry.status)).toEqual(['live', 'needs-attention', 'open']);
    // The dropdown CONTROL's visibility reads the total, not the listed set:
    // a Room whose corners are all terminal still needs its path into the
    // full corner list, even though none of them may be counted as open work.
    expect(row.totalCorners).toBe(6);
    expect(roomRowPresentation({ corners: [corner('merged')] }, NO_NAMES).totalCorners).toBe(1);
  });

  it('falls back to the spoken-in / quiet glyphs when no corner reports', () => {
    expect(roomRowPresentation({ latestMessage: 'we shipped it' }, NO_NAMES).glyph).toBe('›');
    expect(roomRowPresentation({}, NO_NAMES).glyph).toBe('·');
    // A review-ready corner is now a first-class Room fact, so it owns the
    // leading mark instead of letting a message preview hide it.
    const idle = roomRowPresentation(
      { corners: [corner('open')], latestMessage: 'we shipped it' },
      NO_NAMES,
    );
    expect(idle.glyph).toBe('◇');
    expect(idle.corners).toHaveLength(1);
  });

  it('declines a stale cached preview that is nothing but a ref or an id', () => {
    // The stored preview is sanitized where it is written, but a cache entry
    // written by an older build outlives the fix — the index must never print
    // `remote/1a2b3c4` while waiting for the revalidation that replaces it.
    for (const plumbing of ['remote/1a2b3c4', 'refs/heads/main', 'origin/main', '1a2b3c4d5e6']) {
      expect(roomRowPresentation({ latestMessage: plumbing }, NO_NAMES).fact, plumbing).toBe(
        NO_ACTIVITY_PREVIEW,
      );
    }
    // Prose that merely mentions one is still the best thing the row has.
    expect(
      roomRowPresentation({ latestMessage: 'pushed 1a2b3c4 to origin/main' }, NO_NAMES).fact,
    ).toBe('pushed 1a2b3c4 to origin/main');
  });

  it('states plainly when a Room holds nothing readable', () => {
    expect(roomRowPresentation({}, NO_NAMES).fact).toBe(NO_ACTIVITY_PREVIEW);
    // `roomPreviewText` stores `''` for a message that was entirely plumbing,
    // so the row must treat an empty preview as "nothing said", never print it.
    expect(roomRowPresentation({ latestMessage: '' }, NO_NAMES).fact).toBe(NO_ACTIVITY_PREVIEW);
    expect(roomRowPresentation({ latestMessage: '   ' }, NO_NAMES).fact).toBe(NO_ACTIVITY_PREVIEW);
  });

  it('states the current fact with the responsible agent and no speaker-prefixed fallback', () => {
    const names = new Map([['opener', 'Lena']]);
    expect(roomRowPresentation({ corners: [corner('open', 'login-fix')] }, names).fact).toBe(
      'Lena · ready for review · login-fix',
    );
    expect(roomRowPresentation({ corners: [corner('live', 'rebase-main')] }, names).fact).toBe(
      'Lena working · rebase-main',
    );
    expect(
      roomRowPresentation(
        { latestMessage: 'Can you check the API?', latestMessageAuthor: 'opener' },
        names,
      ).fact,
    ).toBe('Can you check the API?');
  });

  it('sorts each zone by the newest meaningful event and omits empty zones', () => {
    const sections = roomListSections(
      [
        { id: 'quiet', title: 'Quiet', latestMessage: 'old', latestMessageAt: 2 },
        {
          id: 'review-old',
          title: 'Review old',
          corners: [{ ...corner('open'), lastActivityAt: 4 }],
        },
        { id: 'live', title: 'Live', corners: [{ ...corner('live'), lastActivityAt: 8 }] },
        {
          id: 'review-new',
          title: 'Review new',
          corners: [{ ...corner('failed'), lastActivityAt: 9 }],
        },
        { id: 'landed', title: 'Landed', corners: [{ ...corner('merged'), lastActivityAt: 12 }] },
      ],
      NO_NAMES,
    );

    expect(sections.map((section) => section.title)).toEqual(['NEEDS YOU', 'WORKING', 'QUIET']);
    expect(sections[0]?.data.map(({ item }) => item.id)).toEqual(['review-new', 'review-old']);
    expect(sections[2]?.data.map(({ item }) => item.id)).toEqual(['landed', 'quiet']);
    expect(
      roomListSections([{ id: 'only', latestMessage: 'hello', latestMessageAt: 1 }], NO_NAMES).map(
        (section) => section.title,
      ),
    ).toEqual(['QUIET']);
  });

  it('keeps archived Rooms out of every Room-list consumer, including the cached sidebar', () => {
    const sections = roomListSections(
      [
        { id: 'archived', title: 'beeline', archived: true },
        { id: 'live', title: 'beeline', archived: false },
      ],
      NO_NAMES,
    );

    expect(sections.flatMap((section) => section.data.map(({ item }) => item.id))).toEqual(['live']);
  });

  it('disambiguates same-name Rooms for both the Room index and cached sidebar', () => {
    const sections = roomListSections(
      [
        { id: '11111111-room', title: 'beeline' },
        { id: '22222222-room', title: 'Beeline' },
      ],
      NO_NAMES,
    );

    expect(sections[0]?.data.map(({ item }) => item.title)).toEqual([
      'beeline · ID 11111111',
      'Beeline · ID 22222222',
    ]);
  });
});
