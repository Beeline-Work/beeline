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

/** A fixed "now": noon UTC on 2026-01-15. Recency buckets are asserted against it. */
const NOW = Date.UTC(2026, 0, 15, 12, 0, 0);
const TODAY_S = Math.floor(NOW / 1000) - 60;
const YESTERDAY_S = Math.floor((NOW - 24 * 60 * 60 * 1000) / 1000) - 60;
const EARLIER_S = Math.floor((NOW - 3 * 24 * 60 * 60 * 1000) / 1000);

describe('Room row presentation', () => {
  it('derives the three deck states from real corner lifecycle', () => {
    // needs-you: a person must act (review, decision, or a failure to hear about).
    expect(roomRowPresentation({ corners: [corner('open')] }, NO_NAMES).zone).toBe('needs-you');
    expect(roomRowPresentation({ corners: [corner('needs-attention')] }, NO_NAMES).zone).toBe(
      'needs-you',
    );
    expect(roomRowPresentation({ corners: [corner('failed')] }, NO_NAMES).zone).toBe('needs-you');
    // working: an agent turn is live in a corner.
    expect(roomRowPresentation({ corners: [corner('live')] }, NO_NAMES).zone).toBe('working');
    // idle: nothing happening.
    expect(roomRowPresentation({ corners: [corner('merged')] }, NO_NAMES).zone).toBe('idle');
    expect(roomRowPresentation({}, NO_NAMES).zone).toBe('idle');
  });

  it('ranks needs-you > working > idle when several corners disagree', () => {
    const row = roomRowPresentation(
      { corners: [corner('open'), corner('live'), corner('needs-attention')] },
      NO_NAMES,
    );
    expect(row.zone).toBe('needs-you');
    expect(row.attention).toBe(true);
    // The Room is still working underneath — the row just reports the stronger
    // state first.
    expect(row.live).toBe(true);
  });

  it('reports a live conversational agent turn as working', () => {
    // Corner turns are not the only turns: a read-only Room answer streaming
    // right now is real work too, seen by the index's own event subscription.
    expect(roomRowPresentation({ agentTurnWorking: true }, NO_NAMES)).toMatchObject({
      zone: 'working',
      live: true,
      attention: false,
    });
    // But a person's decision outranks it.
    expect(
      roomRowPresentation({ agentTurnWorking: true, corners: [corner('open')] }, NO_NAMES).zone,
    ).toBe('needs-you');
    // And it never survives into idle.
    expect(roomRowPresentation({ agentTurnWorking: false }, NO_NAMES).zone).toBe('idle');
  });

  it('marks a Room with a working agent as alive, and an idle one not', () => {
    // Motion is spent here and nowhere else on the index, so this is the
    // single condition the whole working-state rule rests on.
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

  it('escalates a corner waiting on a person without spending motion', () => {
    const row = roomRowPresentation({ corners: [corner('needs-attention')] }, NO_NAMES);
    expect(row).toMatchObject({ attention: true, live: false, glyph: '▲' });
  });

  it('carries exactly one loud action word per needs-you row', () => {
    expect(roomRowPresentation({ corners: [corner('open')] }, NO_NAMES).pills[0]).toEqual({
      kind: 'status',
      label: 'APPROVE',
    });
    expect(roomRowPresentation({ corners: [corner('needs-attention')] }, NO_NAMES).pills[0]).toEqual(
      { kind: 'status', label: 'DECIDE' },
    );
    expect(roomRowPresentation({ corners: [corner('failed')] }, NO_NAMES).pills[0]).toEqual({
      kind: 'status',
      label: 'BLOCKED',
    });
    // Working and idle rows never carry one.
    expect(
      roomRowPresentation({ corners: [corner('live')] }, NO_NAMES).pills.some(
        (pill) => pill.kind === 'status',
      ),
    ).toBe(false);
    expect(roomRowPresentation({}, NO_NAMES).pills.some((pill) => pill.kind === 'status')).toBe(
      false,
    );
  });

  it('keeps brass out of every quiet pill and builds the strip in reading order', () => {
    const row = roomRowPresentation(
      {
        corners: [corner('open')],
        modelLabel: 'ox-alpha',
        participantCount: 3,
        unreadNew: 2,
        latestMessage: 'old news',
        latestMessageAt: 5,
      },
      NO_NAMES,
    );
    expect(row.pills).toEqual([
      { kind: 'status', label: 'APPROVE' },
      { kind: 'model', label: 'ox-alpha' },
      { kind: 'corner', label: '1 corner open' },
      { kind: 'people', label: '3 here' },
      { kind: 'unread', label: '2 new' },
    ]);
    // Only the status pill is the loud one; everything else is metadata.
    expect(row.pills.filter((pill) => pill.kind === 'status')).toHaveLength(1);
  });

  it('shows an uncountable unread as NEW without inventing a number', () => {
    expect(roomRowPresentation({ unreadNew: null }, NO_NAMES).pills).toEqual([
      { kind: 'unread', label: 'new' },
    ]);
    // Read rooms and unknown rooms carry no unread pill at all.
    expect(roomRowPresentation({ unreadNew: 0 }, NO_NAMES).pills).toEqual([]);
    expect(roomRowPresentation({}, NO_NAMES).pills).toEqual([]);
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
    // The stored preview is sanitized where it was written, but a cache entry
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

  it('states the current fact with the responsible actor', () => {
    const names = new Map([['opener', 'Lena']]);
    expect(roomRowPresentation({ corners: [corner('open', 'login-fix')] }, names).fact).toBe(
      'Lena · ready for review · login-fix',
    );
    expect(roomRowPresentation({ corners: [corner('live', 'rebase-main')] }, names).fact).toBe(
      'Lena working · rebase-main',
    );
    // Idle previews attribute their speaker off the same roster ("you · …"),
    // and stay plain when the author is unknown.
    expect(
      roomRowPresentation(
        { latestMessage: 'Can you check the API?', latestMessageAuthor: 'opener' },
        names,
      ).fact,
    ).toBe('Lena · Can you check the API?');
    expect(
      roomRowPresentation({ latestMessage: 'Can you check the API?' }, names).fact,
    ).toBe('Can you check the API?');
  });

  it('sorts needs-you first, then working, then idle rooms by recency buckets', () => {
    const sections = roomListSections(
      [
        { id: 'quiet-old', title: 'Quiet old', latestMessage: 'old', latestMessageAt: EARLIER_S },
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
        { id: 'quiet-today', title: 'Quiet today', latestMessage: 'hi', latestMessageAt: TODAY_S },
        {
          id: 'quiet-yesterday',
          title: 'Quiet yesterday',
          latestMessage: 'hi',
          latestMessageAt: YESTERDAY_S,
        },
      ],
      NO_NAMES,
      { now: NOW },
    );

    // State first (needs-you > working), then recency inside idle only.
    expect(sections.map((section) => section.title)).toEqual([
      'NEEDS YOU',
      'WORKING',
      'TODAY',
      'YESTERDAY',
      'EARLIER',
    ]);
    expect(sections[0]?.data.map(({ item }) => item.id)).toEqual(['review-new', 'review-old']);
    expect(sections[2]?.data.map(({ item }) => item.id)).toEqual(['quiet-today']);
    expect(sections[3]?.data.map(({ item }) => item.id)).toEqual(['quiet-yesterday']);
    expect(sections[4]?.data.map(({ item }) => item.id)).toEqual(['quiet-old', 'landed']);
    // Empty zones and buckets are omitted entirely.
    expect(
      roomListSections([{ id: 'only', latestMessage: 'hello', latestMessageAt: TODAY_S }], NO_NAMES, {
        now: NOW,
      }).map((section) => section.title),
    ).toEqual(['TODAY']);
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
