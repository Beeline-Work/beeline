import { describe, expect, it, vi } from 'vitest';
import type { LiveOverlay } from '@beeline/buzz-client';

import {
  applyLiveOverlayStructure,
  createLiveDraftStore,
  type LiveDraftClock,
} from './live-draft-store';

class ManualClock implements LiveDraftClock {
  nowMs = 0;
  private nextId = 1;
  private frames = new Map<number, (at: number) => void>();
  private timers = new Map<number, { at: number; callback: () => void }>();

  now = () => this.nowMs;
  requestFrame = (callback: (at: number) => void) => {
    const id = this.nextId++;
    this.frames.set(id, callback);
    return id;
  };
  cancelFrame = (id: number) => {
    this.frames.delete(id);
  };
  setTimer = (callback: () => void, delayMs: number) => {
    const id = this.nextId++;
    this.timers.set(id, { at: this.nowMs + delayMs, callback });
    return id;
  };
  clearTimer = (id: number) => {
    this.timers.delete(id);
  };

  frame(at: number) {
    this.nowMs = at;
    const callbacks = [...this.frames.values()];
    this.frames.clear();
    for (const callback of callbacks) callback(at);
  }

  advanceTo(at: number) {
    this.nowMs = at;
    for (;;) {
      const due = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= at)
        .sort((left, right) => left[1].at - right[1].at)[0];
      if (!due) return;
      this.timers.delete(due[0]);
      due[1].callback();
    }
  }
}

const draft = (text: string, overrides: Partial<Extract<LiveOverlay, { kind: 'draft' }>> = {}) =>
  ({
    kind: 'draft',
    key: 'draft:agent-a:turn-a',
    stableId: 'live-turn:agent-a:turn-a',
    agentPubkey: 'agent-a',
    requestId: 'turn-a',
    text,
    closed: false,
    createdAt: 10,
    ...overrides,
  }) satisfies Extract<LiveOverlay, { kind: 'draft' }>;

describe('row-local live draft store', () => {
  it('commits the first arrival on the next frame, then collapses arrivals behind the 33ms gate', () => {
    const clock = new ManualClock();
    const store = createLiveDraftStore({ clock });
    const listener = vi.fn();
    store.subscribe('agent-a:turn-a', listener);

    store.publish('agent-a:turn-a', 'one');
    expect(store.getSnapshot('agent-a:turn-a').text).toBe('');
    clock.frame(16);
    expect(store.getSnapshot('agent-a:turn-a')).toMatchObject({ text: 'one', reveal: true });

    clock.nowMs = 20;
    store.publish('agent-a:turn-a', 'one two');
    clock.nowMs = 24;
    store.publish('agent-a:turn-a', 'one two three');
    clock.frame(32);
    clock.frame(48);
    expect(store.getSnapshot('agent-a:turn-a').text).toBe('one');
    clock.frame(50);
    expect(store.getSnapshot('agent-a:turn-a')).toMatchObject({
      text: 'one two three',
      reveal: true,
    });
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('uses the 50ms deadline as an immediate fully-visible catch-up commit', () => {
    const clock = new ManualClock();
    const store = createLiveDraftStore({ clock });
    store.publish('lane', 'first');
    clock.frame(16);

    clock.nowMs = 17;
    store.publish('lane', 'first second');
    clock.nowMs = 30;
    store.publish('lane', 'first second latest');
    clock.advanceTo(67);

    expect(store.getSnapshot('lane')).toMatchObject({
      text: 'first second latest',
      reveal: false,
      reason: 'deadline',
    });
  });

  it('commits rewrites and turn-end drains immediately with no reveal', () => {
    const clock = new ManualClock();
    const store = createLiveDraftStore({ clock });
    store.publish('lane', 'The answer is 41');
    clock.frame(16);

    clock.nowMs = 17;
    store.publish('lane', 'The answer is 42');
    expect(store.getSnapshot('lane')).toMatchObject({
      text: 'The answer is 42',
      reveal: false,
      reason: 'rewrite',
    });

    clock.nowMs = 18;
    store.publish('lane', 'The answer is 42. Done.');
    store.drain('lane');
    expect(store.getSnapshot('lane')).toMatchObject({
      text: 'The answer is 42. Done.',
      reveal: false,
      reason: 'drain',
    });
  });

  it('keeps Room-owned overlay identity stable while only the keyed row snapshot changes', () => {
    const clock = new ManualClock();
    const store = createLiveDraftStore({ clock });
    const opened = applyLiveOverlayStructure([], draft('one'), store);
    const updated = applyLiveOverlayStructure(opened, draft('one two'), store);
    const latest = applyLiveOverlayStructure(updated, draft('one two three'), store);

    expect(updated).toBe(opened);
    expect(latest).toBe(opened);
    expect(store.getReceived('agent-a:turn-a')).toBe('one two three');
    expect(opened).toEqual([
      expect.objectContaining({
        kind: 'draft',
        agentPubkey: 'agent-a',
        requestId: 'turn-a',
        closed: false,
      }),
    ]);
    expect(opened[0]).not.toHaveProperty('text');
  });

  it('drains and structurally closes one concurrent lane without touching its peer', () => {
    const clock = new ManualClock();
    const store = createLiveDraftStore({ clock });
    let overlays = applyLiveOverlayStructure([], draft('a'), store);
    overlays = applyLiveOverlayStructure(
      overlays,
      draft('b', {
        key: 'draft:agent-b:turn-a',
        stableId: 'live-turn:agent-b:turn-a',
        agentPubkey: 'agent-b',
      }),
      store,
    );
    const closed = applyLiveOverlayStructure(
      overlays,
      draft('', { text: undefined, closed: true }),
      store,
    );

    expect(closed).toHaveLength(2);
    expect(closed[0]).toMatchObject({ agentPubkey: 'agent-a', closed: true });
    expect(closed[1]).toMatchObject({ agentPubkey: 'agent-b', closed: false });
    expect(store.getSnapshot('agent-a:turn-a')).toMatchObject({ text: 'a', reveal: false });
  });
});
