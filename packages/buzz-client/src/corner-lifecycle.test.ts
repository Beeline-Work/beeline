import { describe, expect, it } from 'vitest';
import {
  CORNER_NEEDS_YOU_STATUSES,
  cornerLifecycleFact,
  isCornerNeedsYou,
  mapRawCornerStatusTag,
  mergeCornerStatuses,
  resolveCornerLifecycle,
  resolveCornerStatusAgainstArchive,
} from './corner-lifecycle.js';

const fact = cornerLifecycleFact;

function card(createdAt: number, rawStatus: string) {
  return fact(createdAt, { displayStatus: rawStatus });
}
function work(createdAt: number, t = 'agent-message') {
  return fact(createdAt, { t });
}

describe('corner lifecycle oracle', () => {
  it('maps every raw wire status onto the one canonical vocabulary', () => {
    expect(mapRawCornerStatusTag('starting')).toBe('live');
    expect(mapRawCornerStatusTag('working')).toBe('live');
    expect(mapRawCornerStatusTag('live')).toBe('live');
    expect(mapRawCornerStatusTag('ready')).toBe('open');
    expect(mapRawCornerStatusTag('needs-attention')).toBe('needs-attention');
    expect(mapRawCornerStatusTag('failed')).toBe('failed');
    expect(mapRawCornerStatusTag('merged')).toBe('merged');
    expect(mapRawCornerStatusTag('archived')).toBe('archived');
    // Turn lifecycle words are NOT status cards.
    expect(mapRawCornerStatusTag('complete')).toBeUndefined();
    expect(mapRawCornerStatusTag(undefined)).toBeUndefined();
  });

  it('resolves a needs-attention card to live the moment newer work exists', () => {
    const status = resolveCornerLifecycle([card(100, 'needs-attention'), work(200)]);
    expect(status).toBe('live');
    // ...and only from NEW facts: work older than the card never clears it.
    expect(resolveCornerLifecycle([work(50), card(100, 'needs-attention')])).toBe(
      'needs-attention',
    );
  });

  it('lets a merge-ready speak as open only while nothing newer has', () => {
    expect(resolveCornerLifecycle([fact(100, { t: 'merge-ready' })])).toBe('open');
    expect(
      resolveCornerLifecycle([fact(100, { t: 'merge-ready' }), card(200, 'needs-attention')]),
    ).toBe('needs-attention');
  });

  it('never lets work resurrect a terminal corner', () => {
    expect(resolveCornerLifecycle([card(100, 'merged'), work(999)])).toBe('merged');
    expect(resolveCornerLifecycle([], { archived: true })).toBe('archived');
    expect(resolveCornerLifecycle([], { merged: true })).toBe('merged');
  });

  it('treats no facts as live — a corner whose first card is still in flight', () => {
    expect(resolveCornerLifecycle([])).toBe('live');
  });

  it('keeps the answer stable under the newest-N backfill window', () => {
    const full = [work(10), card(20, 'needs-attention'), work(30)];
    const windowed = full.slice(-2);
    expect(resolveCornerLifecycle(full)).toBe('live');
    expect(resolveCornerLifecycle(windowed)).toBe('live');
  });

  it('defines needs-you exactly once', () => {
    expect([...CORNER_NEEDS_YOU_STATUSES].sort()).toEqual(['failed', 'needs-attention', 'open']);
    expect(isCornerNeedsYou('needs-attention')).toBe(true);
    expect(isCornerNeedsYou('open')).toBe(true);
    expect(isCornerNeedsYou('failed')).toBe(true);
    expect(isCornerNeedsYou('live')).toBe(false);
    expect(isCornerNeedsYou('merged')).toBe(false);
    expect(isCornerNeedsYou('archived')).toBe(false);
  });

  it('merges conflicting reports of one corner terminal-highest', () => {
    expect(mergeCornerStatuses('live', 'needs-attention')).toBe('needs-attention');
    expect(mergeCornerStatuses('needs-attention', 'live')).toBe('needs-attention');
    expect(mergeCornerStatuses('archived', 'live')).toBe('archived');
    expect(mergeCornerStatuses(undefined, 'open')).toBe('open');
    expect(mergeCornerStatuses('live', undefined)).toBe('live');
  });

  it('forces a confirmed archive over a stale non-terminal snapshot', () => {
    expect(resolveCornerStatusAgainstArchive('needs-attention', true)).toBe('archived');
    expect(resolveCornerStatusAgainstArchive('merged', true)).toBe('archived');
    expect(resolveCornerStatusAgainstArchive('needs-attention', false)).toBe('needs-attention');
    expect(resolveCornerStatusAgainstArchive(null, false)).toBeNull();
  });
});

describe('corner lifecycle oracle — unmapped session words never speak', () => {
  it('a trailing suspended/queued card does not erase a standing verdict', () => {
    // Live shape (2026-08-23): a merge-ready stands, then the session goes
    // idle. The corner is still review-ready — 'suspended' is not a lifecycle
    // fact, so it cannot outvote one.
    const events = [
      { createdAt: 100, rawStatus: 'ready' },
      { createdAt: 200, rawStatus: 'suspended' },
    ];
    expect(resolveCornerLifecycle(events as never)).toBe('open');
    expect(resolveCornerLifecycle([{ createdAt: 100, rawStatus: 'needs-attention' }, { createdAt: 200, rawStatus: 'queued' }] as never)).toBe(
      'needs-attention',
    );
  });
});
