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

  it("puts only ACTIONABLE corners in NEEDS YOU — a merely idle one DOESN'T NEED YOU", () => {
    // Owner refinement 2026-08-23: idle-without-finishing (`status: null`, no
    // fresh ask) has nothing for a person to act on, so its Room belongs in
    // DOESN'T NEED YOU deck state — not gold.
    const stalled = { ...corner('open'), status: null };
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
    const asked = { ...stalled, awaitingReply: true };
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
    const stalled = { ...corner('open', 'charles-fix'), status: null, agentOffline: true };
    const row = roomRowPresentation({ corners: [stalled] }, NO_NAMES);
    expect(row).toMatchObject({ zone: 'idle', attention: false, live: false, glyph: '◇' });
    expect(row.fact).toBe('Agent offline · charles-fix');
    expect(row.pills.some((pill) => pill.kind === 'status')).toBe(false);
    // A worded needs-you card next to the offline flag stalls too (defensive
    // shape — the oracle nulls stalled corners' words, but older caches may
    // still carry one).
    expect(
      roomRowPresentation(
        { corners: [{ ...corner('needs-attention', 'stale-ask'), agentOffline: true }] },
        NO_NAMES,
      ).attention,
    ).toBe(false);
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
    expect(row.fact).toBe('Waiting on you · review-me');
  });

  it('keeps an offline-stalled Room out of the NEEDS YOU tier', () => {
    // The deck-tier contract for the same defect: an offline-stalled room
    // belongs in DOESN'T NEED YOU (its row fact says "Agent offline"), never in NEEDS YOU
    // "waiting on you" — while a genuinely reviewable Room keeps its gold.
    const sections = roomListSections(
      [
        {
          id: 'charles',
          title: 'Charles',
          corners: [
            { ...corner('open', 'charles-fix'), status: null, agentOffline: true, lastActivityAt: 9 },
          ],
        },
        { id: 'review', title: 'Review', corners: [{ ...corner('open'), lastActivityAt: 5 }] },
      ],
      NO_NAMES,
      { now: NOW },
    );
    expect(sections.map((section) => section.title)).toEqual([
      'NEEDS YOU',
      "DOESN'T NEED YOU",
    ]);
    expect(sections[0]?.data.map(({ item }) => item.id)).toEqual(['review']);
    expect(sections[1]?.data.map(({ item }) => item.id)).toEqual(['charles']);
    const charlesRow = sections[1]?.data[0]?.row;
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
    expect(row).toMatchObject({ attention: true, live: false, glyph: '◇' });
  });

  it('carries exactly one loud action word per needs-you row', () => {
    expect(roomRowPresentation({ corners: [corner('open')] }, NO_NAMES).pills[0]).toEqual({
      kind: 'status',
      label: 'APPROVE',
    });
    expect(roomRowPresentation({ corners: [corner('needs-attention')] }, NO_NAMES).pills[0]).toEqual(
      { kind: 'status', label: 'REPLY' },
    );
    expect(roomRowPresentation({ corners: [corner('failed')] }, NO_NAMES).pills[0]).toEqual({
      kind: 'status',
      label: 'RETRY',
    });
    // A fresh ask waits on a reply too.
    expect(
      roomRowPresentation(
        { corners: [{ ...corner('open'), status: null, awaitingReply: true }] },
        NO_NAMES,
      ).pills[0],
    ).toEqual({ kind: 'status', label: 'REPLY' });
    // Working and idle rows never carry one — including merely-idle stalls.
    expect(
      roomRowPresentation({ corners: [corner('live')] }, NO_NAMES).pills.some(
        (pill) => pill.kind === 'status',
      ),
    ).toBe(false);
    expect(
      roomRowPresentation(
        { corners: [{ ...corner('open'), status: null }] },
        NO_NAMES,
      ).pills.some((pill) => pill.kind === 'status'),
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
    expect(row.corners.map((entry) => entry.status)).toEqual(['live', 'needs-attention', 'open']);
    expect(roomRowPresentation({ corners: [corner('merged')] }, NO_NAMES).corners).toEqual([]);
    expect(roomRowPresentation({ corners: [corner('archived')] }, NO_NAMES).corners).toEqual([]);
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
      'Waiting on you · login-fix',
    );
    // Idle-without-finishing is no longer a needs-you fact — a merely idle
    // corner's Room falls back to its spoken history. Only an ask-wait keeps
    // the "waiting on you" line.
    expect(
      roomRowPresentation(
        { corners: [{ ...corner('open', 'login-fix'), status: null }] },
        names,
      ).fact,
    ).toBe(NO_ACTIVITY_PREVIEW);
    expect(
      roomRowPresentation(
        { corners: [{ ...corner('open', 'login-fix'), status: null, awaitingReply: true }] },
        names,
      ).fact,
    ).toBe('Waiting on you · login-fix');
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

  it('puts an unread ROOM message in NEEDS YOU, and reading it drops the room back', () => {
    // Owner model 2026-08-23, trigger 3: an unread person-facing message in
    // the ROOM itself — agent OR human author — waits on a person all by
    // itself. `roomUnread` is derived by the caller off the existing read-mark
    // store (`isRoomUnread` over the room's own latest-message summary).
    expect(
      roomRowPresentation({ latestMessage: 'the relay is back up', roomUnread: true }, NO_NAMES),
    ).toMatchObject({ zone: 'needs-you', attention: true });
    // Once read, the same room is ordinary deck state again.
    expect(
      roomRowPresentation({ latestMessage: 'the relay is back up', roomUnread: false }, NO_NAMES),
    ).toMatchObject({ zone: 'idle', attention: false });
    // An unread message outranks a working corner but not a corner decision.
    expect(
      roomRowPresentation(
        { corners: [corner('live')], roomUnread: true },
        NO_NAMES,
      ).zone,
    ).toBe('needs-you');
    expect(
      roomRowPresentation(
        { corners: [corner('needs-attention')], roomUnread: true },
        NO_NAMES,
      ).zone,
    ).toBe('needs-you');
    // At the deck level the unread room takes the NEEDS YOU section.
    const sections = roomListSections(
      [
        {
          id: 'unread-room',
          title: 'Unread room',
          latestMessage: 'hello',
          latestMessageAt: TODAY_S,
          roomUnread: true,
        },
        {
          id: 'read-room',
          title: 'Read room',
          latestMessage: 'hello',
          latestMessageAt: TODAY_S + 1,
          roomUnread: false,
        },
      ],
      NO_NAMES,
      { now: NOW },
    );
    expect(sections.map((section) => section.title)).toEqual([
      'NEEDS YOU',
      "DOESN'T NEED YOU",
    ]);
    expect(sections[0]?.data.map(({ item }) => item.id)).toEqual(['unread-room']);
  });

  it('never lets corner output stand in for a room-level unread trigger', () => {
    // Corner messages are corner output, not room conversation: a chatty
    // working corner with nothing unread in the ROOM stays out of NEEDS YOU.
    expect(
      roomRowPresentation({ corners: [corner('live')], roomUnread: false }, NO_NAMES).zone,
    ).toBe('working');
    expect(
      roomRowPresentation(
        { corners: [{ ...corner('open'), status: null }], roomUnread: false },
        NO_NAMES,
      ).zone,
    ).toBe('idle');
  });

  it("zones the deck into NEEDS YOU then DOESN'T NEED YOU — working and finished rooms included", () => {
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
        { id: 'archived', title: 'Archived room', archived: true, latestMessageAt: TODAY_S + 5 },
      ],
      NO_NAMES,
      { now: NOW },
    );

    // Exactly two tiers: attention state first, then everything else (working
    // AND finished rooms live in DOESN'T NEED YOU per the owner's two-pile
    // model — their row marks and fact lines already convey working vs quiet
    // vs landed). No recency headings.
    expect(sections.map((section) => section.title)).toEqual([
      'NEEDS YOU',
      "DOESN'T NEED YOU",
    ]);
    expect(sections[0]?.zone).toBe('needs-you');
    expect(sections[0]?.data.map(({ item }) => item.id)).toEqual(['review-new', 'review-old']);
    expect(sections[1]?.zone).toBe('idle');
    // Newest activity first inside DOESN'T NEED YOU; working rooms are
    // ordinary members, and finished ones (landed/archived) fold in here too —
    // there is no FINISHED pile anymore.
    expect(sections[1]?.data.map(({ item }) => item.id)).toEqual([
      'archived',
      'quiet-today',
      'quiet-old',
      'landed',
      'live',
    ]);

    // Finished rooms — archived, or all corner work terminal — are ordinary
    // members of DOESN'T NEED YOU now: there is no FINISHED pile (owner model
    // 2026-08-23). They carry no needs-you trigger, so the rules alone place
    // them; their row still says landed/archived through its own fact line.
    const sectionsWithFinished = roomListSections(
      [
        { id: 'landed', title: 'Landed', corners: [corner('merged')] },
        { id: 'closed', title: 'Closed', corners: [corner('archived')] },
        { id: 'archived-room', title: 'Archived room', archived: true },
        { id: 'chat-only', title: 'Chat only' },
      ],
      NO_NAMES,
    );
    expect(sectionsWithFinished.map((section) => section.title)).toEqual([
      "DOESN'T NEED YOU",
    ]);
    expect(
      sectionsWithFinished[0]?.data.map(({ item }) => item.id),
    ).toEqual(['closed', 'landed', 'archived-room', 'chat-only']);
  });

  it('omits empty tiers and never renders a FINISHED or DIRECT pile', () => {
    // No needs-you entries -> that tier is omitted entirely.
    expect(
      roomListSections([{ id: 'only', latestMessage: 'hello', latestMessageAt: TODAY_S }], NO_NAMES, {
        now: NOW,
      }).map((section) => section.title),
    ).toEqual(["DOESN'T NEED YOU"]);
    // Nothing at all -> no sections.
    expect(roomListSections([], NO_NAMES, { now: NOW })).toEqual([]);
    // Exactly two labels exist, and neither is FINISHED nor DIRECT.
    for (const title of roomListSections(
      [
        {
          id: 'ask',
          corners: [{ ...corner('open'), status: null, awaitingReply: true }],
        },
        { id: 'quiet' },
        { id: 'dm-read' },
      ],
      NO_NAMES,
    ).map((section) => section.title)) {
      expect(['NEEDS YOU', "DOESN'T NEED YOU"]).toContain(title);
    }
  });

  it('gives DMs the same piles as Rooms: unread is NEEDS YOU, read is not', () => {
    // A DM has no corners and no work lifecycle — the unread rule is its only
    // trigger, exactly like a Room's.
    const unreadDm = { id: 'dm-unread', latestMessage: 'ping', latestMessageAt: TODAY_S, roomUnread: true };
    expect(roomRowPresentation(unreadDm, NO_NAMES)).toMatchObject({
      zone: 'needs-you',
      attention: true,
    });
    const readDm = { ...unreadDm, id: 'dm-read', roomUnread: false };
    expect(roomRowPresentation(readDm, NO_NAMES)).toMatchObject({
      zone: 'idle',
      attention: false,
    });
    // And on the deck itself, both DMs sort into the same two piles as Rooms,
    // newest first inside DOESN'T NEED YOU.
    const sections = roomListSections(
      [
        readDm,
        { id: 'room-quiet', title: 'Quiet room', latestMessageAt: TODAY_S + 5 },
        unreadDm,
      ],
      NO_NAMES,
      { now: NOW },
    );
    expect(sections.map((section) => section.title)).toEqual([
      'NEEDS YOU',
      "DOESN'T NEED YOU",
    ]);
    expect(sections[0]?.data.map(({ item }) => item.id)).toEqual(['dm-unread']);
    expect(sections[1]?.data.map(({ item }) => item.id)).toEqual(['room-quiet', 'dm-read']);
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
