import { describe, expect, it } from 'vitest';
import {
  cornerName,
  cornerStatusPresentation,
  isCornerActive,
  isCornerTerminal,
  mapRawCornerStatusTag,
  resolveCornerLifecycle,
  resolveCornerLifecycleStatus,
  roomCornerSignal,
  roomListCorners,
  sortCorners,
  type CornerLifecycleFact,
  type CornerSummary,
} from './corners';

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
    expect(resolveCornerLifecycle([status('needs-attention', 100), work(200), work(300)])).toBe(
      'live',
    );
    expect(resolveCornerLifecycle([status('needs-attention', 100), review(50), work(200)])).toBe(
      'live',
    );
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
    expect(resolveCornerLifecycle([review(100)])).toBe('open');
    expect(resolveCornerLifecycle([review(100), status('ready', 150)])).toBe('open');
    // Work after the announcement means the review window moved on.
    expect(resolveCornerLifecycle([review(100), work(200)])).toBe('live');
    // A newer status still outranks an older merge-ready (existing rule).
    expect(resolveCornerLifecycle([review(100), status('failed', 200)])).toBe('failed');
  });

  it('resolves a recoverable failure card once realign work starts', () => {
    expect(resolveCornerLifecycle([status('failed', 100), work(200)])).toBe('live');
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
    expect(resolveCornerLifecycle([work(10), work(20)])).toBe('live');
    expect(resolveCornerLifecycle([])).toBe('live');
  });

  it('is stable under the newest-N backfill window', () => {
    // The same append-only history read through two different windows — one
    // that still holds the old card, one where busy corners evicted it — must
    // answer identically, or the deck flips between cold cache and warm
    // refetch. This is the cold/warm parity property.
    const fullWindow: CornerLifecycleFact[] = [status('needs-attention', 100), ...Array.from({ length: 49 }, (_, i) => work(200 + i))];
    const evictedWindow: CornerLifecycleFact[] = Array.from({ length: 50 }, (_, i) => work(200 + i));
    expect(resolveCornerLifecycle(fullWindow)).toBe('live');
    expect(resolveCornerLifecycle(evictedWindow)).toBe('live');
  });
});

describe('corner navigation model', () => {
  const corners: CornerSummary[] = [
    { id: 'archived', name: 'old', openerPubkey: 'a', status: 'archived', createdAt: 4 },
    { id: 'open', name: 'ready', openerPubkey: 'a', status: 'open', createdAt: 2 },
    { id: 'live-new', name: 'new', openerPubkey: 'a', status: 'live', createdAt: 3 },
    { id: 'live-old', name: 'older', openerPubkey: 'a', status: 'live', createdAt: 1 },
    { id: 'stuck', name: 'stuck', openerPubkey: 'a', status: 'needs-attention', createdAt: 5 },
    { id: 'broken', name: 'broken', openerPubkey: 'a', status: 'failed', createdAt: 6 },
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

  it('lists only open and actively-worked corners in the Room-list dropdown', () => {
    // The dropdown is a live-work shortcut, so `merged`, `archived`, and
    // `failed` corners are excluded outright rather than shown dimmed — a Room
    // row's count must equal exactly what expanding it reveals.
    expect(roomListCorners(corners).map((corner) => corner.id)).toEqual([
      'open',
      'live-new',
      'live-old',
      'stuck',
    ]);
    expect(roomListCorners(corners).map((corner) => corner.status)).not.toContain('failed');
    expect(roomListCorners(corners).map((corner) => corner.status)).not.toContain('archived');
    expect(roomListCorners(corners).map((corner) => corner.status)).not.toContain('merged');
    // The excluded corners are filtered for display only; the Room's own corner
    // array still carries them for the full corners list to show.
    expect(corners.some((corner) => corner.status === 'archived')).toBe(true);
    expect(corners.some((corner) => corner.status === 'failed')).toBe(true);
  });

  it('excludes every terminal and failed status from the dropdown by name', () => {
    const one = (status: CornerSummary['status']): CornerSummary => ({
      id: status,
      name: status,
      openerPubkey: 'a',
      status,
      createdAt: 1,
    });
    expect(
      roomListCorners(
        (['live', 'needs-attention', 'open', 'failed', 'merged', 'archived'] as const).map(one),
      ).map((corner) => corner.status),
    ).toEqual(['live', 'needs-attention', 'open']);
  });

  describe('roomCornerSignal', () => {
    it('reports the highest-precedence actively-worked corner', () => {
      expect(roomCornerSignal(corners)).toBe('live');
      expect(
        roomCornerSignal([
          { id: 'stuck', name: 'stuck', openerPubkey: 'a', status: 'needs-attention' },
          { id: 'open', name: 'open', openerPubkey: 'a', status: 'open' },
        ]),
      ).toBe('needs-attention');
    });

    it('reports nothing for corners the dropdown does not list', () => {
      // A Room row must never advertise work its own count and dropdown hide.
      expect(
        roomCornerSignal([
          { id: 'broken', name: 'broken', openerPubkey: 'a', status: 'failed' },
          { id: 'gone', name: 'gone', openerPubkey: 'a', status: 'archived' },
          { id: 'landed', name: 'landed', openerPubkey: 'a', status: 'merged' },
        ]),
      ).toBeNull();
    });

    it('reports nothing for a merely open corner or no corners at all', () => {
      expect(
        roomCornerSignal([{ id: 'open', name: 'open', openerPubkey: 'a', status: 'open' }]),
      ).toBeNull();
      expect(roomCornerSignal([])).toBeNull();
    });
  });

  it('breaks ties by most recent activity, not just creation time', () => {
    const stale: CornerSummary = {
      id: 'stale',
      name: 'stale',
      openerPubkey: 'a',
      status: 'live',
      createdAt: 100,
      lastActivityAt: 1,
    };
    const busy: CornerSummary = {
      id: 'busy',
      name: 'busy',
      openerPubkey: 'a',
      status: 'live',
      createdAt: 1,
      lastActivityAt: 100,
    };
    expect(sortCorners([stale, busy]).map((corner) => corner.id)).toEqual(['busy', 'stale']);
  });

  it('never exposes legacy subchannel names in person-facing navigation', () => {
    expect(cornerName('sub-room-id', '12345678-abcd')).toBe('corner-12345678');
    expect(cornerName('  #Auth callback  ', 'unused')).toBe('Auth-callback');
  });

  it('uses redundant monochrome glyph and text for every status', () => {
    expect(cornerStatusPresentation('live')).toEqual({ glyph: '◆', label: 'LIVE' });
    expect(cornerStatusPresentation('needs-attention')).toEqual({
      glyph: '▲',
      label: 'NEEDS ATTENTION',
    });
    expect(cornerStatusPresentation('open')).toEqual({ glyph: '◇', label: 'READY' });
    expect(cornerStatusPresentation('failed')).toEqual({ glyph: '✕', label: 'FAILED' });
    expect(cornerStatusPresentation('merged')).toEqual({ glyph: '✓', label: 'MERGED' });
    expect(cornerStatusPresentation('archived')).toEqual({ glyph: '□', label: 'ARCHIVED' });
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

  it('names exactly the three terminal statuses', () => {
    expect(isCornerTerminal('merged')).toBe(true);
    expect(isCornerTerminal('failed')).toBe(true);
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
