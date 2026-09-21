import { describe, expect, it, vi } from 'vitest';
import {
  LIVE_DRAFT_TICK_MS,
  applyLiveOverlayStructure,
  createLiveDraftDrainStore,
  type LiveDraftClock,
  type LiveDraftPaint,
  type LiveDraftPresentation,
} from './live-draft-drain';

class ManualClock implements LiveDraftClock {
  at = 0;
  nextId = 1;
  timers = new Map<number, { at: number; callback: () => void }>();
  maxScheduled = 0;

  now() {
    return this.at;
  }

  setTimer(callback: () => void, delayMs: number) {
    const id = this.nextId++;
    this.timers.set(id, { at: this.at + delayMs, callback });
    this.maxScheduled = Math.max(this.maxScheduled, this.timers.size);
    return id;
  }

  clearTimer(id: number) {
    this.timers.delete(id);
  }

  runNext() {
    const next = [...this.timers.entries()].sort((left, right) => left[1].at - right[1].at)[0];
    if (!next) return false;
    const [id, timer] = next;
    this.timers.delete(id);
    this.at = timer.at;
    timer.callback();
    return true;
  }

  runAll(limit = 2_000) {
    let turns = 0;
    while (this.runNext()) {
      turns += 1;
      if (turns > limit) throw new Error('live drain did not become idle');
    }
  }
}

function sink() {
  const paints: LiveDraftPaint[] = [];
  const replacements: LiveDraftPresentation[] = [];
  return {
    paints,
    replacements,
    value: {
      paint: vi.fn((paint: LiveDraftPaint) => paints.push(paint)),
      replace: vi.fn((presentation: LiveDraftPresentation) => replacements.push(presentation)),
    },
  };
}

describe('live draft drain', () => {
  it('queues 800 cumulative arrivals without painting, then drains on one steady scheduler', () => {
    const clock = new ManualClock();
    const store = createLiveDraftDrainStore({ clock });
    const row = sink();
    store.attach('turn', row.value);

    let cumulative = '';
    for (let chunk = 0; chunk < 800; chunk += 1) {
      cumulative += `${String(chunk).padStart(4, '0')} the streamed sentence keeps moving.\n`;
      store.publish('turn', cumulative);
    }

    expect(row.value.paint).not.toHaveBeenCalled();
    expect(store.getMetrics('turn')).toMatchObject({ arrivals: 800, paints: 0 });
    expect(clock.maxScheduled).toBe(1);

    clock.runAll();

    const metrics = store.getMetrics('turn');
    expect(metrics.paints).toBeLessThan(800 / 3);
    expect(metrics.paintedCharacters).toBe(cumulative.length);
    expect(clock.maxScheduled).toBe(1);
    expect(store.getPresentation('turn')).toEqual({ text: cumulative });
  });

  it('commits the whole latest snapshot on each eligible frame, never a paced slice', () => {
    const clock = new ManualClock();
    const store = createLiveDraftDrainStore({ clock });
    const row = sink();
    store.attach('turn', row.value);

    store.publish('turn', 'first');
    clock.runNext();
    expect(row.paints.at(-1)).toEqual({ text: 'first' });

    // A burst of arrivals between frames is one full commit, not a drip.
    store.publish('turn', 'first second third');
    clock.runNext();
    expect(row.paints.at(-1)).toEqual({ text: 'first second third' });

    // Once the producer stops, the lane stops: no residual reveal timer.
    expect(clock.timers.size).toBe(0);
    const paintsAfterProducerStopped = row.value.paint.mock.calls.length;
    clock.runAll();
    expect(row.value.paint).toHaveBeenCalledTimes(paintsAfterProducerStopped);
  });

  it('shares that one timer across concurrent turns and advances only on its fixed tick', () => {
    const clock = new ManualClock();
    const store = createLiveDraftDrainStore({ clock });
    const first = sink();
    const second = sink();
    store.attach('first', first.value);
    store.attach('second', second.value);

    store.publish('first', 'a'.repeat(2_000));
    store.publish('second', 'b'.repeat(2_000));
    expect(clock.timers.size).toBe(1);
    expect(first.value.paint).not.toHaveBeenCalled();

    clock.runNext();
    expect(clock.at).toBe(LIVE_DRAFT_TICK_MS);
    expect(first.value.paint).toHaveBeenCalledTimes(1);
    expect(second.value.paint).toHaveBeenCalledTimes(1);
    // Both lanes are fully committed; nothing is pending, so the shared timer
    // stops rather than ticking out a cosmetic drain.
    expect(clock.timers.size).toBe(0);
  });

  it('notifies commit followers when a row grows, never on a queued arrival', () => {
    const clock = new ManualClock();
    const store = createLiveDraftDrainStore({ clock });
    const row = sink();
    const follow = vi.fn();
    store.attach('turn', row.value);
    const unsubscribe = store.subscribeCommit(follow);

    store.publish('turn', 'queued words');
    expect(follow).not.toHaveBeenCalled();
    clock.runNext();
    expect(follow).toHaveBeenCalledWith('turn');
    const callsAfterFirstCommit = follow.mock.calls.length;

    unsubscribe();
    store.publish('turn', `${store.getReceived('turn')} more words`);
    clock.runAll();
    expect(follow).toHaveBeenCalledTimes(callsAfterFirstCommit);
  });

  it('replaces a non-prefix rewrite immediately and flushes remaining queued text when stopped', () => {
    const clock = new ManualClock();
    const store = createLiveDraftDrainStore({ clock });
    const row = sink();
    store.attach('turn', row.value);

    store.publish('turn', 'the first draft');
    clock.runNext();
    store.publish('turn', 'a replacement');
    expect(row.replacements.at(-1)).toEqual({ text: 'a replacement' });
    expect(store.getMetrics('turn')).toMatchObject({ rewrites: 1 });

    store.publish('turn', 'a replacement with queued bytes');
    store.stop('turn');
    clock.runAll();
    expect(store.getPresentation('turn')).toEqual({
      text: 'a replacement with queued bytes',
    });
  });

  it('stops the scheduler on leave even with a sink and queued work still attached', () => {
    // The drain keeps ticking while StreamingProse stays mounted (native-stack
    // does not unmount the Room on blur). That occupies the JS thread until the
    // turn ends, so a back press and the next Room open wait on the message
    // painting. Leave must cancel the timer without flushing.
    const clock = new ManualClock();
    const store = createLiveDraftDrainStore({ clock });
    const row = sink();
    store.attach('turn', row.value);
    const text = 'word '.repeat(8_000);
    store.publish('turn', text);
    expect(clock.timers.size).toBe(1);

    store.setActive(false);

    expect(clock.timers.size).toBe(0);
    const paintsAtLeave = row.value.paint.mock.calls.length;
    clock.runAll();
    expect(clock.timers.size).toBe(0);
    expect(row.value.paint).toHaveBeenCalledTimes(paintsAtLeave);
    expect(store.getMetrics('turn').paintedCharacters).toBeLessThan(text.length);
  });

  it('does not restart the timer from a publish while the Room is unfocused', () => {
    const clock = new ManualClock();
    const store = createLiveDraftDrainStore({ clock });
    const row = sink();
    store.attach('turn', row.value);
    store.setActive(false);
    store.publish('turn', 'more tokens while the reader has already left');
    expect(clock.timers.size).toBe(0);
    clock.runAll();
    expect(row.value.paint).not.toHaveBeenCalled();
  });

  it('catches up in one replace on resume so re-entry does not wait on the drain', () => {
    const clock = new ManualClock();
    const store = createLiveDraftDrainStore({ clock });
    const row = sink();
    store.attach('turn', row.value);
    const text = `${'word '.repeat(400).trim()}.`;
    store.publish('turn', text);
    store.setActive(false);
    store.setActive(true);

    expect(clock.timers.size).toBe(0);
    expect(row.replacements.at(-1)).toEqual(store.getPresentation('turn'));
    expect(store.getPresentation('turn')).toEqual({ text });
  });

  it('publishes text outside structural overlay state after the row opens', () => {
    const clock = new ManualClock();
    const store = createLiveDraftDrainStore({ clock });
    const first = {
      kind: 'draft' as const,
      key: 'draft:agent:request',
      stableId: 'live-turn:agent:request',
      agentPubkey: 'agent',
      requestId: 'request',
      text: 'one',
      closed: false,
      createdAt: 1,
    };
    const structure = applyLiveOverlayStructure([], first, store);
    const next = applyLiveOverlayStructure(
      structure,
      { ...first, text: 'one two', createdAt: 2 },
      store,
    );

    expect(next).toBe(structure);
    expect(next[0]).not.toHaveProperty('text');
    expect(store.getReceived('agent:request')).toBe('one two');
  });
});