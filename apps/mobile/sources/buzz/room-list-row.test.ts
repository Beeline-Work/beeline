import { describe, expect, it } from 'vitest';

import type { CornerSummary, CornerStatus } from './corners';
import {
  isRoomAlive,
  NO_ACTIVITY_PREVIEW,
  roomListFeed,
  roomRowPresentation,
} from './room-list-row';

function corner(status: CornerStatus | null, name = `corner-${status ?? 'idle'}`): CornerSummary {
  const machine =
    status === 'live'
      ? ({ machineState: 'working' } as const)
      : status === 'open'
        ? ({ machineState: 'waiting', machineReason: 'review' } as const)
        : status === 'needs-attention'
          ? ({ machineState: 'waiting', machineReason: 'question' } as const)
          : status === 'failed'
            ? ({ machineState: 'waiting', machineReason: 'failure' } as const)
            : status === 'merged'
              ? ({ machineState: 'concluded' } as const)
              : status === 'archived'
                ? ({ machineState: 'closed' } as const)
                : ({ machineState: 'idle' } as const);
  return {
    id: `${status ?? 'idle'}-id`,
    name,
    openerPubkey: 'opener',
    status,
    ...machine,
    stateAt: Math.floor(Date.now() / 1_000),
    ...(status === 'needs-attention' ? { awaitingReply: true } : {}),
    lastActivityAt: 10,
  };
}

const NO_NAMES = new Map<string, string>();

/** A fixed "now": noon UTC on 2026-01-15. Recency buckets are asserted against it. */
const NOW = Date.UTC(2026, 0, 15, 12, 0, 0);
const TODAY_S = Math.floor(NOW / 1000) - 60;
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

  it("puts only ACTIONABLE corners in NEEDS YOU — a merely idle one DOESN'T NEED YOU", () => {
    // Owner refinement 2026-08-23: idle-without-finishing (`status: null`, no
    // fresh ask) has nothing for a person to act on, so its Room belongs in
    // DOESN'T NEED YOU deck state — not gold.
    const stalled = corner(null);
    expect(roomRowPresentation({ corners: [stalled] }, NO_NAMES)).toMatchObject({
      zone: 'idle',
      attention: false,
    });
    expect(
      roomRowPresentation({ corners: [stalled] }, NO_NAMES).pills.some(
        (pill) => pill.kind === 'status',
      ),
    ).toBe(false);
    // But a fresh unanswered agent ask (`awaitingReply` — the same null word,
    // carried by the transport when the oracle says the ask IS the wait) is
    // exactly what NEEDS YOU exists for, with REPLY as its affordance.
    const asked = corner('needs-attention');
    expect(roomRowPresentation({ corners: [asked] }, NO_NAMES)).toMatchObject({
      zone: 'needs-you',
      attention: true,
    });
    expect(roomRowPresentation({ corners: [asked] }, NO_NAMES).pills[0]).toEqual({
      kind: 'status',
      label: 'REPLY',
    });
  });

  it("an OFFLINE agent with a stalled corner is never waiting on you — DOESN'T NEED YOU, honestly labelled", () => {
    // Owner report 2026-08-23: charles/beeline showed NEEDS YOU "Waiting on
    // you" while their agents were DEAD — a stale ask card golded forever
    // because only newer work (which a dead agent cannot produce) clears it.
    // The transport carries the oracle's STALLED verdict as `agentOffline`,
    // and the deck answers it: no gold, no action pill, an honest fact line.
    const stalled = { ...corner(null, 'charles-fix'), agentOffline: true };
    const row = roomRowPresentation({ corners: [stalled] }, NO_NAMES);
    expect(row).toMatchObject({ zone: 'idle', attention: false, live: false, glyph: '○' });
    expect(row.fact).toBe('Agent offline · charles-fix');
    expect(row.pills.some((pill) => pill.kind === 'status')).toBe(false);
    // Presence is a separate fact and cannot demote a canonical wait.
    expect(
      roomRowPresentation(
        { corners: [{ ...corner('needs-attention', 'stale-ask'), agentOffline: true }] },
        NO_NAMES,
      ).attention,
    ).toBe(true);
  });

  it('an offline agent WITH a reviewable change still reads needs-you (APPROVE)', () => {
    // The artifact stands on its own: approving a presented change does not
    // need the agent awake. Presence never touches this verdict.
    const row = roomRowPresentation(
      { corners: [{ ...corner('open', 'review-me'), agentOffline: true }] },
      NO_NAMES,
    );
    expect(row).toMatchObject({ zone: 'needs-you', attention: true });
    expect(row.pills[0]).toEqual({ kind: 'status', label: 'APPROVE' });
    expect(row.fact).toBe('review-me');
  });

  it('pins reviewable work ahead of a newer offline-idle Room', () => {
    const feed = roomListFeed(
      [
        {
          id: 'charles',
          title: 'Charles',
          corners: [
            {
              ...corner(null, 'charles-fix'),
              agentOffline: true,
              lastActivityAt: 9,
            },
          ],
        },
        { id: 'review', title: 'Review', corners: [{ ...corner('open'), lastActivityAt: 5 }] },
      ],
      NO_NAMES,
      { now: NOW },
    );
    expect(feed.map(({ item }) => item.id)).toEqual(['review', 'charles']);
    const charlesRow = feed[1]?.row;
    expect(charlesRow?.fact).toBe('Agent offline · charles-fix');
    expect(charlesRow?.attention).toBe(false);
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

  it('never invents an independent Room state from a conversational turn', () => {
    // Room state is only max(corner states); a Room-level stream is not a
    // fourth input to the rollup.
    expect(roomRowPresentation({ agentTurnWorking: true }, NO_NAMES)).toMatchObject({
      zone: 'idle',
      live: false,
      attention: false,
    });
    // But a person's decision outranks it.
    expect(
      roomRowPresentation({ agentTurnWorking: true, corners: [corner('open')] }, NO_NAMES).zone,
    ).toBe('needs-you');
    // And it never survives into idle.
    expect(roomRowPresentation({ agentTurnWorking: false }, NO_NAMES).zone).toBe('idle');
  });

  it('ignores a legacy active word when no canonical working record exists', () => {
    const controlProjectedGhost: CornerSummary = {
      id: 'corner-06ac8027',
      name: 'ghost',
      openerPubkey: 'agent',
      // This is the exact word an unmatched parent body-control OPEN card used
      // to persist forever. Without machineState/stateAt it has no authority.
      status: 'live',
    };
    expect(roomRowPresentation({ corners: [controlProjectedGhost] }, NO_NAMES)).toMatchObject({
      zone: 'idle',
      state: 'idle',
      live: false,
      attention: false,
      corners: [],
    });
  });

  it('expires a canonical working lease at the shared freshness horizon', () => {
    const stale = {
      ...corner('live'),
      stateAt: Math.floor((NOW - 90_001) / 1_000),
    };
    expect(roomRowPresentation({ corners: [stale] }, NO_NAMES)).toMatchObject({
      zone: 'idle',
      state: 'idle',
      live: false,
    });
  });

  it('marks a Room with a working agent as alive, and an idle one not', () => {
    // Motion is spent here and nowhere else on the index, so this is the
    // single condition the whole working-state rule rests on.
    expect(roomRowPresentation({ corners: [corner('live')] }, NO_NAMES)).toMatchObject({
      live: true,
      glyph: '◌',
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
    expect(row).toMatchObject({ attention: true, live: false, glyph: '●' });
  });

  it('carries exactly one loud action word per needs-you row', () => {
    expect(roomRowPresentation({ corners: [corner('open')] }, NO_NAMES).pills[0]).toEqual({
      kind: 'status',
      label: 'APPROVE',
    });
    expect(
      roomRowPresentation({ corners: [corner('needs-attention')] }, NO_NAMES).pills[0],
    ).toEqual({ kind: 'status', label: 'REPLY' });
    expect(roomRowPresentation({ corners: [corner('failed')] }, NO_NAMES).pills[0]).toEqual({
      kind: 'status',
      label: 'RETRY',
    });
    // A fresh ask waits on a reply too.
    expect(
      roomRowPresentation({ corners: [corner('needs-attention')] }, NO_NAMES).pills[0],
    ).toEqual({ kind: 'status', label: 'REPLY' });
    // Working and idle rows never carry one — including merely-idle stalls.
    expect(
      roomRowPresentation({ corners: [corner('live')] }, NO_NAMES).pills.some(
        (pill) => pill.kind === 'status',
      ),
    ).toBe(false);
    expect(
      roomRowPresentation({ corners: [corner(null)] }, NO_NAMES).pills.some(
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
    // The count and the expand must agree: immutable terminal corners are
    // excluded outright, while an actionable failure remains visible, so a person is never offered a
    // number that expands into fewer rows. Finished corners are represented
    // nowhere — there is no recorded-total fallback: a Room whose corners all
    // landed or closed carries no corner affordance at all.
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
      'failed',
    ]);
    expect(roomRowPresentation({ corners: [corner('merged')] }, NO_NAMES).corners).toEqual([]);
    expect(roomRowPresentation({ corners: [corner('archived')] }, NO_NAMES).corners).toEqual([]);
  });

  it('always renders the idle state circle when no corner reports', () => {
    expect(roomRowPresentation({ latestMessage: 'we shipped it' }, NO_NAMES).glyph).toBe('○');
    expect(roomRowPresentation({}, NO_NAMES).glyph).toBe('○');
    // A review-ready corner is now a first-class Room fact, so it owns the
    // leading mark instead of letting a message preview hide it.
    const idle = roomRowPresentation(
      { corners: [corner('open')], latestMessage: 'we shipped it' },
      NO_NAMES,
    );
    expect(idle.glyph).toBe('●');
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
      'login-fix',
    );
    // Idle-without-finishing is no longer a needs-you fact — a merely idle
    // corner's Room falls back to its spoken history. Only an ask-wait keeps
    // the "waiting on you" line.
    expect(roomRowPresentation({ corners: [corner(null, 'login-fix')] }, names).fact).toBe(
      NO_ACTIVITY_PREVIEW,
    );
    expect(
      roomRowPresentation({ corners: [corner('needs-attention', 'login-fix')] }, names).fact,
    ).toBe('login-fix');
    expect(roomRowPresentation({ corners: [corner('live', 'rebase-main')] }, names).fact).toBe(
      'Lena · rebase-main',
    );
    // Idle previews attribute their speaker off the same roster ("you · …"),
    // and stay plain when the author is unknown.
    expect(
      roomRowPresentation(
        { latestMessage: 'Can you check the API?', latestMessageAuthor: 'opener' },
        names,
      ).fact,
    ).toBe('Lena · Can you check the API?');
    expect(roomRowPresentation({ latestMessage: 'Can you check the API?' }, names).fact).toBe(
      'Can you check the API?',
    );
  });

  it('uses unread only for bold activity, never for Room state', () => {
    expect(
      roomRowPresentation({ latestMessage: 'the relay is back up', roomUnread: true }, NO_NAMES),
    ).toMatchObject({ zone: 'idle', state: 'idle', attention: false, unread: true });
    expect(
      roomRowPresentation({ latestMessage: 'the relay is back up', roomUnread: false }, NO_NAMES),
    ).toMatchObject({ zone: 'idle', state: 'idle', attention: false, unread: false });
    expect(
      roomRowPresentation({ corners: [corner('live')], roomUnread: true }, NO_NAMES),
    ).toMatchObject({ zone: 'working', state: 'working', unread: true });
  });

  it('pins needs-you first, then sorts both clusters by most recent activity', () => {
    const feed = roomListFeed(
      [
        { id: 'quiet-old', latestMessageAt: EARLIER_S },
        { id: 'review-old', corners: [{ ...corner('open'), lastActivityAt: 4 }] },
        { id: 'live-new', corners: [{ ...corner('live'), lastActivityAt: TODAY_S }] },
        { id: 'review-new', corners: [{ ...corner('failed'), lastActivityAt: 9 }] },
        { id: 'quiet-new', latestMessageAt: TODAY_S + 5 },
      ],
      NO_NAMES,
    );
    expect(feed.map(({ item }) => item.id)).toEqual([
      'review-new',
      'review-old',
      'quiet-new',
      'live-new',
      'quiet-old',
    ]);
  });

  it('new messages and Room turns float ordinary Rooms without faking attention', () => {
    const initial = roomListFeed(
      [
        { id: 'older', latestMessageAt: 10 },
        { id: 'newer', latestMessageAt: 20 },
      ],
      NO_NAMES,
    );
    expect(initial.map(({ item }) => item.id)).toEqual(['newer', 'older']);
    const active = roomListFeed(
      [
        { id: 'older', latestMessageAt: 10, agentTurnWorking: true, agentTurnAt: 30 },
        { id: 'newer', latestMessageAt: 20 },
      ],
      NO_NAMES,
    );
    expect(active.map(({ item }) => item.id)).toEqual(['older', 'newer']);
    expect(active[0]?.row).toMatchObject({ state: 'idle', attention: false, unread: true });
  });

  it('is stable for equal state and activity and returns one flat feed', () => {
    expect(roomListFeed([], NO_NAMES)).toEqual([]);
    const feed = roomListFeed(
      [
        { id: 'first', latestMessageAt: 10 },
        { id: 'second', latestMessageAt: 10 },
        { id: 'third', latestMessageAt: 10 },
      ],
      NO_NAMES,
    );
    expect(feed.map(({ item }) => item.id)).toEqual(['first', 'second', 'third']);
  });

  it('disambiguates same-name Rooms for both the Room index and cached sidebar', () => {
    const feed = roomListFeed(
      [
        { id: '11111111-room', title: 'beeline' },
        { id: '22222222-room', title: 'Beeline' },
      ],
      NO_NAMES,
    );

    expect(feed.map(({ item }) => item.title)).toEqual([
      'beeline · ID 11111111',
      'Beeline · ID 22222222',
    ]);
  });

  it('swaps the gutter age slot for a count chip only on message-unread rows', () => {
    // Exact count when the local transcript can count against the mark.
    expect(roomRowPresentation({ roomUnread: true, unreadNew: 3 }, NO_NAMES).unreadBadge).toBe('3');
    // Uncountable unread never invents a number.
    expect(roomRowPresentation({ roomUnread: true, unreadNew: null }, NO_NAMES).unreadBadge).toBe(
      'NEW',
    );
    expect(roomRowPresentation({ roomUnread: true }, NO_NAMES).unreadBadge).toBe('NEW');
    // Read rows keep their age stamp: no badge at all.
    expect(roomRowPresentation({ roomUnread: false, unreadNew: 3 }, NO_NAMES).unreadBadge).toBe(
      null,
    );
    expect(roomRowPresentation({}, NO_NAMES).unreadBadge).toBe(null);
    // A live conversational turn lifts the row but is not a message, so it
    // never produces a count in the gutter.
    expect(roomRowPresentation({ agentTurnWorking: true }, NO_NAMES).unreadBadge).toBe(null);
  });

  it('caps compact counts so the fixed gutter chip never reflows', () => {
    expect(roomRowPresentation({ roomUnread: true, unreadNew: 9 }, NO_NAMES).unreadBadge).toBe('9');
    expect(roomRowPresentation({ roomUnread: true, unreadNew: 12 }, NO_NAMES).unreadBadge).toBe(
      '9+',
    );
  });

  it('keeps corner state and corner count stable across read/unread rows', () => {
    const corners = [corner('open'), corner('live')];
    const read = roomRowPresentation({ corners, roomUnread: false }, NO_NAMES);
    const unread = roomRowPresentation({ corners, roomUnread: true, unreadNew: 2 }, NO_NAMES);
    // The chip replaces the AGE, never the corner affordance: zone, corner
    // set, and count stay identical across both states.
    expect(unread.zone).toBe(read.zone);
    expect(unread.state).toBe(read.state);
    expect(unread.corners).toEqual(read.corners);
    expect(unread.pills.filter((pill) => pill.kind === 'corner')).toEqual(
      read.pills.filter((pill) => pill.kind === 'corner'),
    );
    expect(unread.unread).toBe(true);
    expect(read.unread).toBe(false);
  });

  it('never partitions or pins the feed by unread — recency stays the co-driver', () => {
    // An older unread Room must not jump a newer read one; unread affects
    // recency through meaningfulAt already, and nothing else.
    const feed = roomListFeed(
      [
        { id: 'older-unread', latestMessageAt: 10, roomUnread: true, unreadNew: 4 },
        { id: 'newer-read', latestMessageAt: 20, roomUnread: false },
        // Same timestamp as `newer-read`: unread must not win the stable tie.
        { id: 'tie-unread', latestMessageAt: 20, roomUnread: true, unreadNew: 7 },
      ],
      NO_NAMES,
    );
    expect(feed.map(({ item }) => item.id)).toEqual(['newer-read', 'tie-unread', 'older-unread']);
    // Needs-you clustering is untouched by unread either way.
    const clustered = roomListFeed(
      [
        { id: 'unread-idle', latestMessageAt: TODAY_S, roomUnread: true, unreadNew: 1 },
        { id: 'read-needs-you', corners: [{ ...corner('open'), lastActivityAt: 5 }] },
      ],
      NO_NAMES,
    );
    expect(clustered.map(({ item }) => item.id)).toEqual(['read-needs-you', 'unread-idle']);
  });
});
