import { describe, expect, it } from 'vitest';
import {
  cornerName,
  cornerStatusPresentation,
  cornerVisualState,
  isCornerActive,
  isCornerStalledOffline,
  isCornerTerminal,
  mapRawCornerStatusTag,
  resolveCornerLifecycle,
  resolveCornerLifecycleStatus,
  roomCornerSignal,
  roomState,
  roomListCorners,
  sortCorners,
  type CornerLifecycleFact,
  type CornerSummary,
} from './corners';

describe('the offline-stalled presentation (agent provably offline)', () => {
  it('keeps presence separate from canonical lifecycle presentation', () => {
    expect(cornerStatusPresentation(null, { agentOffline: true }).label).toBe('IDLE');
    expect(cornerStatusPresentation('needs-attention', { agentOffline: true }).label).toBe(
      'NEEDS YOU',
    );
    expect(cornerStatusPresentation('live', { agentOffline: true }).label).toBe('WORKING');
    expect(cornerStatusPresentation(null, { agentOffline: true }).glyph).toBe('○');
  });

  it("keeps today's reading for online/unknown agents and for real artifacts", () => {
    expect(cornerStatusPresentation(null).label).toBe('IDLE');
    expect(cornerStatusPresentation('needs-attention').label).toBe('NEEDS YOU');
    // A reviewable change stays actionable regardless of presence.
    expect(cornerStatusPresentation('open', { agentOffline: true }).label).toBe('NEEDS YOU');
    expect(cornerStatusPresentation('failed', { agentOffline: true }).label).toBe('NEEDS YOU');
    // Terminal words fold to idle; immutable metadata still hides them.
    expect(cornerStatusPresentation('archived', { agentOffline: true }).label).toBe('IDLE');
  });

  it('defines the stalled predicate once, with artifact-backed exceptions', () => {
    expect(isCornerStalledOffline({ status: null, agentOffline: true })).toBe(true);
    expect(isCornerStalledOffline({ status: 'failed', agentOffline: true })).toBe(false);
    expect(isCornerStalledOffline({ status: 'open', agentOffline: true })).toBe(false);
    expect(isCornerStalledOffline({ status: null })).toBe(false);
    expect(isCornerStalledOffline({ status: 'archived', agentOffline: true })).toBe(false);
  });
});

describe('resolveCornerLifecycle (attention lifecycle, one oracle)', () => {
  const status = (raw: string, createdAt: number): CornerLifecycleFact => ({
    createdAt,
    rawStatus: raw,
  });
  const work = (createdAt: number): CornerLifecycleFact => ({ createdAt, isWorkSignal: true });
  const review = (createdAt: number): CornerLifecycleFact => ({
    createdAt,
    isMergeReady: true,
  });

  it('resolves a needs-decision card once the corner has worked again', () => {
    // The poisoned-history shape: a gate-outage-era decision card with hours
    // of agent narration and turn lifecycle after it. The card described one
    // moment; the work consumed whatever it was waiting for.
    expect(
      resolveCornerLifecycle([status('needs-attention', 100), work(200), work(300)], {
        now: 300_000,
      }),
    ).toBe('live');
    expect(
      resolveCornerLifecycle([status('needs-attention', 100), review(50), work(200)], {
        now: 200_000,
      }),
    ).toBe('live');
  });

  it('keeps a genuinely pending decision gold while it is the newest word', () => {
    expect(resolveCornerLifecycle([work(100), status('needs-attention', 300)])).toBe(
      'needs-attention',
    );
    expect(resolveCornerLifecycle([status('needs-attention', 300)])).toBe('needs-attention');
  });

  it('never lets a human message or system notice resolve a pending decision', () => {
    // Only agent-authored work signals count; anything else in the channel
    // (a person's steer, a body-control receipt) leaves the card standing.
    const humanMessage: CornerLifecycleFact = { createdAt: 400 };
    expect(resolveCornerLifecycle([status('needs-attention', 300), humanMessage])).toBe(
      'needs-attention',
    );
  });

  it('keeps a review open until consumed, then reads working again', () => {
    expect(resolveCornerLifecycle([review(100)], { now: 100_000 })).toBe('open');
    expect(resolveCornerLifecycle([review(100), status('ready', 150)], { now: 150_000 })).toBe(
      'open',
    );
    // Work after the announcement means the review window moved on.
    expect(resolveCornerLifecycle([review(100), work(200)], { now: 200_000 })).toBe('live');
    // A newer status still outranks an older merge-ready (existing rule).
    expect(resolveCornerLifecycle([review(100), status('failed', 200)])).toBe('failed');
  });

  it('resolves a recoverable failure card once realign work starts', () => {
    expect(resolveCornerLifecycle([status('failed', 100), work(200)], { now: 200_000 })).toBe(
      'live',
    );
    // A second failure newer than the work speaks again.
    expect(resolveCornerLifecycle([status('failed', 100), work(200), status('failed', 300)])).toBe(
      'failed',
    );
  });

  it('never resurrects a merged or archived corner, whatever came after', () => {
    expect(resolveCornerLifecycle([work(500)], { merged: true })).toBe('merged');
    expect(
      resolveCornerLifecycle([status('needs-attention', 100), work(200)], { archived: true }),
    ).toBe('archived');
  });

  it('answers live for a history with no status word at all', () => {
    expect(resolveCornerLifecycle([work(10), work(20)], { now: 20_000 })).toBe('live');
    expect(resolveCornerLifecycle([])).toBe('live');
  });

  it('is stable under the newest-N backfill window', () => {
    // The same append-only history read through two different windows — one
    // that still holds the old card, one where busy corners evicted it — must
    // answer identically, or the deck flips between cold cache and warm
    // refetch. This is the cold/warm parity property.
    const fullWindow: CornerLifecycleFact[] = [
      status('needs-attention', 100),
      ...Array.from({ length: 49 }, (_, i) => work(200 + i)),
    ];
    const evictedWindow: CornerLifecycleFact[] = Array.from({ length: 50 }, (_, i) =>
      work(200 + i),
    );
    expect(resolveCornerLifecycle(fullWindow, { now: 248 * 1000 + 500 })).toBe('live');
    expect(resolveCornerLifecycle(evictedWindow, { now: 248 * 1000 + 500 })).toBe('live');
  });
});

describe('corner navigation model', () => {
  const canonical = (status: CornerSummary['status']) => ({
    ...(status === 'live'
      ? { machineState: 'working' as const }
      : status === 'open'
        ? { machineState: 'waiting' as const, machineReason: 'review' as const }
        : status === 'needs-attention'
          ? { machineState: 'waiting' as const, machineReason: 'question' as const }
          : status === 'failed'
            ? { machineState: 'waiting' as const, machineReason: 'failure' as const }
            : status === 'merged'
              ? { machineState: 'concluded' as const }
              : status === 'archived'
                ? { machineState: 'closed' as const }
                : { machineState: 'idle' as const }),
    stateAt: Math.floor(Date.now() / 1_000),
  });
  const summary = (
    id: string,
    name: string,
    status: CornerSummary['status'],
    createdAt?: number,
  ): CornerSummary => ({
    id,
    name,
    openerPubkey: 'a',
    status,
    ...canonical(status),
    ...(createdAt !== undefined ? { createdAt } : {}),
  });
  const corners: CornerSummary[] = [
    summary('archived', 'old', 'archived', 4),
    summary('open', 'ready', 'open', 2),
    summary('live-new', 'new', 'live', 3),
    summary('live-old', 'older', 'live', 1),
    summary('stuck', 'stuck', 'needs-attention', 5),
    summary('broken', 'broken', 'failed', 6),
  ];

  it('keeps active corners first in the room-scoped corner list', () => {
    expect(sortCorners(corners).map((corner) => corner.id)).toEqual([
      'live-new',
      'live-old',
      'stuck',
      'open',
      'broken',
      'archived',
    ]);
  });

  it('lists every unfinished corner in the Room-list dropdown', () => {
    // A failed status is emitted only for an actionable review artifact, so it
    // remains visible; only immutable merged/archived facts leave the list.
    expect(roomListCorners(corners).map((corner) => corner.id)).toEqual([
      'open',
      'live-new',
      'live-old',
      'stuck',
      'broken',
    ]);
    expect(roomListCorners(corners).map((corner) => corner.status)).toContain('failed');
    expect(roomListCorners(corners).map((corner) => corner.status)).not.toContain('archived');
    expect(roomListCorners(corners).map((corner) => corner.status)).not.toContain('merged');
    // The excluded corners are filtered for display only; the Room's own corner
    // array still carries them for the full corners list to show.
    expect(corners.some((corner) => corner.status === 'archived')).toBe(true);
    expect(corners.some((corner) => corner.status === 'failed')).toBe(true);
  });

  it('excludes only immutable terminal statuses from the dropdown by name', () => {
    const one = (status: CornerSummary['status']): CornerSummary => ({
      id: status,
      name: status,
      openerPubkey: 'a',
      status,
      ...canonical(status),
      createdAt: 1,
    });
    expect(
      roomListCorners(
        (['live', 'needs-attention', 'open', 'failed', 'merged', 'archived'] as const).map(one),
      ).map((corner) => corner.status),
    ).toEqual(['live', 'needs-attention', 'open', 'failed']);
  });

  describe('roomCornerSignal', () => {
    it('reports the highest-precedence actively-worked corner', () => {
      expect(roomCornerSignal(corners)).toBe('needs-attention');
      expect(
        roomCornerSignal([
          summary('stuck', 'stuck', 'needs-attention'),
          summary('open', 'open', 'open'),
        ]),
      ).toBe('needs-attention');
    });

    it('reports needs-you for actionable failure and ignores immutable terminals', () => {
      expect(
        roomCornerSignal([
          summary('broken', 'broken', 'failed'),
          summary('gone', 'gone', 'archived'),
          summary('landed', 'landed', 'merged'),
        ]),
      ).toBe('needs-attention');
    });

    it('reports needs-you for an open review and nothing for no corners', () => {
      expect(roomCornerSignal([summary('open', 'open', 'open')])).toBe('needs-attention');
      expect(roomCornerSignal([])).toBeNull();
    });
  });

  it('breaks ties by most recent activity, not just creation time', () => {
    const stale: CornerSummary = {
      id: 'stale',
      name: 'stale',
      openerPubkey: 'a',
      status: 'live',
      ...canonical('live'),
      createdAt: 100,
      lastActivityAt: 1,
    };
    const busy: CornerSummary = {
      id: 'busy',
      name: 'busy',
      openerPubkey: 'a',
      status: 'live',
      ...canonical('live'),
      createdAt: 1,
      lastActivityAt: 100,
    };
    expect(sortCorners([stale, busy]).map((corner) => corner.id)).toEqual(['busy', 'stale']);
  });

  it('never exposes legacy subchannel names in person-facing navigation', () => {
    expect(cornerName('sub-room-id', '12345678-abcd')).toBe('corner-12345678');
    expect(cornerName('  #Auth callback  ', 'unused')).toBe('Auth-callback');
  });

  it('uses the one circle family and exact three-state accessibility vocabulary', () => {
    expect(cornerStatusPresentation('live')).toEqual({ glyph: '◌', label: 'WORKING' });
    for (const word of ['needs-attention', 'open', 'failed'] as const) {
      expect(cornerStatusPresentation(word)).toEqual({ glyph: '●', label: 'NEEDS YOU' });
    }
    expect(cornerStatusPresentation(null)).toEqual({ glyph: '○', label: 'IDLE' });
    for (const word of ['merged', 'archived'] as const) {
      expect(cornerStatusPresentation(word)).toEqual({ glyph: '○', label: 'IDLE' });
    }
  });

  it('rolls Room state up as an order-independent max over corner states', () => {
    const idle = summary('i', 'idle', null);
    const working = summary('w', 'working', 'live');
    const needs = summary('n', 'needs', 'open');

    expect(roomState([idle, working, needs])).toBe('needs-you');
    expect(roomState([idle, working])).toBe('working');
    expect(roomState([idle, { ...idle, id: 'i2' }])).toBe('idle');
    expect(roomState([needs, idle, working])).toBe(roomState([working, needs, idle]));
    expect(roomState([working, working])).toBe(cornerVisualState('live'));
    expect(roomState([idle])).toBe('idle');
  });

  it('collapses every raw wire status onto the one canonical model', () => {
    // body.ts always emits BOTH `status` (wire, "starting" collapsed to "open")
    // and `display-status` (exact). Both must land on the same canonical value.
    expect(mapRawCornerStatusTag('starting')).toBe('live');
    expect(mapRawCornerStatusTag('working')).toBe('live');
    expect(mapRawCornerStatusTag('open')).toBe('live');
    expect(mapRawCornerStatusTag('live')).toBe('live');
    expect(mapRawCornerStatusTag('needs-attention')).toBe('needs-attention');
    expect(mapRawCornerStatusTag('ready')).toBe('open');
    expect(mapRawCornerStatusTag('failed')).toBe('failed');
    expect(mapRawCornerStatusTag('merged')).toBe('merged');
    expect(mapRawCornerStatusTag('archived')).toBe('archived');
    expect(mapRawCornerStatusTag(undefined)).toBeUndefined();
    expect(mapRawCornerStatusTag('nonsense')).toBeUndefined();
  });

  it('treats only live/needs-attention as actively worked', () => {
    expect(isCornerActive('live')).toBe(true);
    expect(isCornerActive('needs-attention')).toBe(true);
    expect(isCornerActive('open')).toBe(false);
    expect(isCornerActive('failed')).toBe(false);
    expect(isCornerActive('merged')).toBe(false);
    expect(isCornerActive('archived')).toBe(false);
  });

  it('names only immutable merged and archived facts as terminal', () => {
    expect(isCornerTerminal('merged')).toBe(true);
    expect(isCornerTerminal('failed')).toBe(false);
    expect(isCornerTerminal('archived')).toBe(true);
    expect(isCornerTerminal('live')).toBe(false);
    expect(isCornerTerminal('needs-attention')).toBe(false);
    expect(isCornerTerminal('open')).toBe(false);
  });

  describe('resolveCornerLifecycleStatus', () => {
    it('keeps the last known status while archival is unconfirmed', () => {
      expect(resolveCornerLifecycleStatus('live', false)).toBe('live');
      expect(resolveCornerLifecycleStatus(null, false)).toBeNull();
    });

    // This is the corner view badge's exact staleness bug: the badge's known
    // status is a one-time snapshot fetched at mount, but confirmed-archived
    // can resolve later (via a live signal, on an already-mounted screen).
    // The stale snapshot must never keep outranking a confirmed archive.
    it('overrides a stale non-terminal snapshot once archival is confirmed', () => {
      expect(resolveCornerLifecycleStatus('live', true)).toBe('archived');
      expect(resolveCornerLifecycleStatus('open', true)).toBe('archived');
      expect(resolveCornerLifecycleStatus('needs-attention', true)).toBe('archived');
      expect(resolveCornerLifecycleStatus('failed', true)).toBe('archived');
      expect(resolveCornerLifecycleStatus(null, true)).toBe('archived');
    });

    it('does not downgrade an already-terminal snapshot below archived precedence', () => {
      // 'merged' still yields to a confirmed archive (archived outranks merged
      // in cornerStatusPrecedence), matching the monotonic guard used elsewhere.
      expect(resolveCornerLifecycleStatus('merged', true)).toBe('archived');
      expect(resolveCornerLifecycleStatus('archived', true)).toBe('archived');
    });
  });
});
