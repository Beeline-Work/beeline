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

  it('restart-caused corner-session suspend/resume noise never churns the verdict', () => {
    // A daemon restart used to stamp every restored corner with a
    // `corner-session` status=suspended card. The oracle must be immune:
    // `suspended` is not a status word (mapRawCornerStatusTag → undefined),
    // and a session-state event is not a work signal, so it can neither
    // create needs-human nor fake working.
    const suspendCard = fact(2000, { t: 'corner-session', status: 'suspended' });
    expect(mapRawCornerStatusTag('suspended')).toBeUndefined();
    expect(suspendCard.isWorkSignal).toBeUndefined();
    expect(suspendCard.rawStatus).toBe('suspended');
    // Working before the noise stays working...
    expect(
      resolveCornerState([work(1000), suspendCard], { now: fresh(1000) }),
    ).toBe('working');
    // ...and idle-before-the-noise stays needs-human — the pause the restart
    // itself caused must not gold the row as fresh agent trouble.
    const idleNow = 1000 * 1000 + CORNER_WORK_LIVENESS_WINDOW_MS + 1;
    expect(resolveCornerState([work(1000), suspendCard], { now: idleNow })).toBe('needs-human');
  });

  it('a corner whose first card is still in flight is working', () => {
    expect(resolveCornerState([], { now: Date.now() })).toBe('working');  });

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

describe('corner lifecycle oracle — agent-offline (stalled) verdict', () => {
  // The owner's real shape (2026-08-23): a corner holding a stale ask card,
  // its daemon dead — the only thing that clears an ask (newer work) can
  // never come from a dead agent, so the ask golded the row as "waiting on
  // you" forever. Presence is a SOFT input: same facts + provably offline =
  // STALLED, not needs-human.
  const askFacts = [card(100, 'needs-attention'), ask(200)];
  const askNow = fresh(200);

  it('an ONLINE agent with a fresh ask reads needs-human exactly as today', () => {
    expect(resolveCornerState(askFacts, { now: askNow })).toBe('needs-human');
    // Unknown presence (no record read yet) must behave identically — the
    // soft input only speaks when it can PROVE sustained offline.
    expect(resolveCornerState(askFacts, { now: askNow, agentOffline: undefined })).toBe(
      'needs-human',
    );
    expect(resolveCornerState(askFacts, { now: askNow, agentOffline: false })).toBe(
      'needs-human',
    );
  });

  it('the SAME facts with the agent offline past the lease read stalled, never waiting-on-you', () => {
    expect(resolveCornerState(askFacts, { now: askNow, agentOffline: true })).toBe('stalled');
    // A bare fresh ask with no card behind it stalls too.
    expect(resolveCornerState([ask(200)], { now: askNow, agentOffline: true })).toBe('stalled');
    // So does idle-without-finishing and even a stale `live` word: a dead
    // agent is not working, whatever its last card said.
    const idleNow = 100 * 1000 + CORNER_WORK_LIVENESS_WINDOW_MS + 1;
    expect(resolveCornerState([work(100)], { now: idleNow, agentOffline: true })).toBe(
      'stalled',
    );
    expect(resolveCornerState([card(100, 'live')], { now: fresh(100), agentOffline: true })).toBe(
      'stalled',
    );
  });

  it('an offline agent WITH a live merge target still reads needs-you (review)', () => {
    const review = [fact(100, { t: 'merge-ready', displayStatus: 'ready' })];
    expect(resolveCornerState(review, { now: fresh(100) })).toBe('needs-human');
    expect(resolveCornerState(review, { now: fresh(100), agentOffline: true })).toBe(
      'needs-human',
    );
    // Same for an explicit ready word standing as the newest fact.
    expect(
      resolveCornerState([card(100, 'ready')], { now: fresh(100), agentOffline: true }),
    ).toBe('needs-human');
  });

  it('a presence blip inside the lease never flips a verdict (soft input)', () => {
    // Only `agentOffline: true` — computed from a lease already past — may
    // change the reading; false/undefined are the today behaviour.
    const working = [work(3000)];
    expect(resolveCornerState(working, { now: fresh(3000), agentOffline: false })).toBe(
      'working',
    );
    const review = [fact(100, { t: 'merge-ready', displayStatus: 'ready' })];
    expect(resolveCornerState(review, { now: fresh(100), agentOffline: true })).toBe(
      'needs-human',
    );
  });

  it('terminal words still win outright over the offline input', () => {
    expect(
      resolveCornerState([card(100, 'archived')], { now: fresh(100), agentOffline: true }),
    ).toBe('finished');
    expect(resolveCornerState([], { merged: true, agentOffline: true })).toBe('finished');
  });

  it('the legacy projection maps stalled to null (no fourth wire word)', () => {
    expect(resolveCornerLifecycle(askFacts, { now: askNow, agentOffline: true })).toBeNull();
    // ...while the online reading keeps its word.
    expect(resolveCornerLifecycle(askFacts, { now: askNow })).toBe('needs-attention');
    // And an offline review still carries its legacy open word.
    expect(
      resolveCornerLifecycle([fact(100, { t: 'merge-ready', displayStatus: 'ready' })], {
        now: fresh(100),
        agentOffline: true,
      }),
    ).toBe('open');
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
