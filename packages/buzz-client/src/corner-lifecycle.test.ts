import { describe, expect, it } from 'vitest';
import {
  CORNER_NEEDS_YOU_STATUSES,
  CORNER_WORK_LIVENESS_WINDOW_MS,
  cornerLifecycleFact,
  isCornerNeedsYou,
  mapRawCornerStatusTag,
  mergeCornerStatuses,
  resolveCornerLifecycle,
  resolveCornerState,
  resolveCornerStatusAgainstArchive,
} from './corner-lifecycle.js';

const fact = cornerLifecycleFact;

function card(createdAt: number, rawStatus: string) {
  return fact(createdAt, { displayStatus: rawStatus });
}
function work(createdAt: number, t = 'agent-message') {
  return fact(createdAt, { t });
}
function ask(createdAt: number, text = 'Main moved on — which base should I rebase onto?') {
  return fact(createdAt, { t: 'agent-message', text });
}
/** A `now` just after `createdAt`, so liveness/ask windows hold. */
function fresh(at: number): number {
  return at * 1000 + 1000;
}

describe('corner lifecycle oracle — THE three-word verdict', () => {
  it('recent agent work → working', () => {
    expect(resolveCornerState([work(1000)], { now: fresh(1000) })).toBe('working');
    // Work inside the liveness window counts; past it, it does not.
    expect(
      resolveCornerState([work(1000)], { now: 1000 * 1000 + CORNER_WORK_LIVENESS_WINDOW_MS + 1 }),
    ).toBe('needs-human');
  });

  it('idle + unfinished + stale ask → needs-human (never review)', () => {
    const staleAsk = ask(200);
    const idleNow = 200 * 1000 + CORNER_WORK_LIVENESS_WINDOW_MS + 10_000;
    const events = [card(100, 'needs-attention'), staleAsk];
    expect(resolveCornerState(events, { now: idleNow })).toBe('needs-human');
    // The legacy projection agrees — and a bare ready word with no live
    // target behind it is needs-human too, not an approvable state.
    expect(resolveCornerLifecycle(events, { now: idleNow })).toBe('needs-attention');
    expect(resolveCornerState([card(100, 'ready')], { now: idleNow })).toBe('needs-human');
  });

  it('merged → finished', () => {
    expect(resolveCornerState([card(100, 'merged'), work(999)], { now: fresh(999) })).toBe(
      'finished',
    );
    expect(resolveCornerState([], { merged: true })).toBe('finished');
    expect(resolveCornerState([], { archived: true })).toBe('finished');
    expect(resolveCornerState([card(100, 'archived')], { now: fresh(100) })).toBe('finished');
  });

  it('a corner whose first card is still in flight is working', () => {
    expect(resolveCornerState([], { now: Date.now() })).toBe('working');
  });

  it('a fresh unanswered agent ask reads needs-human even over recent narration', () => {
    // The ask IS the newest event and well inside the ask window: the corner
    // waits on a person, so it must not read as merely "working".
    expect(resolveCornerState([work(100), ask(200)], { now: fresh(200) })).toBe('needs-human');
    // ...and it must never clear its own question via work-supersession.
    expect(
      resolveCornerState([card(100, 'needs-attention'), ask(200)], { now: fresh(200) }),
    ).toBe('needs-human');
    // A newer non-ask answer/work moots the question again.
    expect(resolveCornerState([ask(100), work(200)], { now: fresh(200) })).toBe('working');
  });

  it('a standing review announcement is needs-human; plain narration never fakes one', () => {
    expect(
      resolveCornerState([fact(100, { t: 'merge-ready', displayStatus: 'ready' })], {
        now: fresh(100),
      }),
    ).toBe('needs-human');
    // Plain narration without '?' is work, never an ask.
    expect(resolveCornerState([work(200)], { now: fresh(200) })).toBe('working');
  });

  it('a needs-attention card resolved by newer NON-ASK work reads working while live', () => {
    const events = [card(100, 'needs-attention'), work(200)];
    expect(resolveCornerState(events, { now: fresh(200) })).toBe('working');
    // Past the liveness window with nothing finished: needs-human.
    expect(
      resolveCornerState(events, { now: 200 * 1000 + CORNER_WORK_LIVENESS_WINDOW_MS + 1 }),
    ).toBe('needs-human');
  });

  it('keeps the answer stable under the newest-N backfill window', () => {
    const full = [work(1000), card(2000, 'needs-attention'), work(3000)];
    const windowed = full.slice(-2);
    expect(resolveCornerState(full, { now: fresh(3000) })).toBe('working');
    expect(resolveCornerState(windowed, { now: fresh(3000) })).toBe('working');
  });

  it('a landed-but-not-yet-archived corner still renders while its session works', () => {
    // The daemon's land card carries `status=ready` + `t=landed` and is NOT a
    // terminal word: since the land→archive race fix, the channel stays open
    // while the agent session winds down, so the corner must stay visible and
    // resolve from its newer facts like any other unfinished corner.
    const land = fact(1000, { t: 'landed', status: 'ready' });
    // A bare ready word with no live merge-ready target behind it reads
    // needs-human (pinned deliberately by the existing oracle suite); it is
    // certainly not terminal — the corner stays rendered.
    expect(resolveCornerState([land], { now: fresh(1000) })).toBe('needs-human');
    // Newer non-ask work signal: working — this is exactly what keeps a live,
    // merged-but-unarchived corner on screen instead of vanishing.
    expect(resolveCornerState([land, work(2000)], { now: fresh(2000) })).toBe('working');
    // Idle past the liveness window with nothing terminal yet: needs-human.
    // Still rendered; never silently gone before an archive is confirmed.
    expect(
      resolveCornerState([land, work(2000)], {
        now: 2000 * 1000 + CORNER_WORK_LIVENESS_WINDOW_MS + 1,
      }),
    ).toBe('needs-human');
    // Once the archive is actually confirmed (archived card or merged flag),
    // terminal wins outright — work signals never resurrect it.
    expect(
      resolveCornerState([land, work(2000), card(3000, 'archived')], { now: fresh(3000) }),
    ).toBe('finished');
    expect(resolveCornerState([land, work(2000)], { merged: true })).toBe('finished');
  });

  it('the legacy seven-word projection maps the three words for old consumers', () => {
    const now = fresh(3000);
    expect(resolveCornerLifecycle([work(3000)], { now })).toBe('live');
    expect(resolveCornerLifecycle([card(100, 'merged'), work(999)], { now: fresh(999) })).toBe(
      'merged',
    );
    expect(resolveCornerLifecycle([card(100, 'needs-attention')], { now: fresh(100) })).toBe(
      'needs-attention',
    );
    // Standing review keeps its legacy word.
    expect(
      resolveCornerLifecycle([fact(100, { t: 'merge-ready', displayStatus: 'ready' })], {
        now: fresh(100),
      }),
    ).toBe('open');
    // Idle-without-finishing has no newer word than its last card; the
    // legacy projection keeps that word for affordance routing (the SURFACE
    // decides approve-vs-reply from a live merge target), while the STATE is
    // needs-human either way.
    expect(
      resolveCornerLifecycle([card(100, 'ready')], {
        now: 100 * 1000 + CORNER_WORK_LIVENESS_WINDOW_MS + 1,
      }),
    ).toBe('open');
    // With no worded card at all there is nothing to route by — null.
    expect(
      resolveCornerLifecycle([work(100)], {
        now: 100 * 1000 + CORNER_WORK_LIVENESS_WINDOW_MS + 1,
      }),
    ).toBeNull();
  });
});

describe('corner lifecycle oracle — vocabulary and sets', () => {
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

  it('unmapped session words never speak as cards', () => {
    // 'suspended'/'queued' are not lifecycle facts; the standing word speaks.
    const events = [
      fact(100, { t: 'merge-ready', displayStatus: 'ready' }),
      card(200, 'suspended'),
    ];
    expect(resolveCornerLifecycle(events as never, { now: fresh(200) })).toBe('open');
    expect(resolveCornerState(events as never, { now: fresh(200) })).toBe('needs-human');
  });
});
