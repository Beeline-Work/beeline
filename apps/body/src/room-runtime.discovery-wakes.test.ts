import { describe, expect, it } from 'vitest';
import { DiscoveryWakes } from './room-runtime.js';

/**
 * The #1369 wake latch, held to the semantics that make a corner opened while
 * a reconcile is already running start immediately instead of a heartbeat
 * later: a reconcile covers only the wakes that arrived before it started,
 * anything landing during it re-arms, and a reconcile that throws covers
 * nothing.
 */
describe('DiscoveryWakes', () => {
  it('a wake before the reconcile is served by its start pass', () => {
    const wakes = new DiscoveryWakes();
    expect(wakes.needsFastReconcile()).toBe(false);
    wakes.wake();
    expect(wakes.needsFastReconcile()).toBe(true);
    const covered = wakes.beginReconcile();
    wakes.completeReconcile(covered);
    expect(wakes.needsFastReconcile()).toBe(false);
  });

  it('a wake landing during the reconcile survives its start pass', () => {
    const wakes = new DiscoveryWakes();
    const covered = wakes.beginReconcile();
    // The corner-open wake arrives while the reconcile's reads are in flight.
    wakes.wake();
    wakes.completeReconcile(covered);
    expect(wakes.needsFastReconcile()).toBe(true);
    // The follow-up reconcile serves it.
    wakes.completeReconcile(wakes.beginReconcile());
    expect(wakes.needsFastReconcile()).toBe(false);
  });

  it('a reconcile that throws covers nothing', () => {
    const wakes = new DiscoveryWakes();
    wakes.wake();
    wakes.beginReconcile();
    // The start pass never ran to completion: no completeReconcile() call, so
    // the latch stays armed and discovery retries fast.
    expect(wakes.needsFastReconcile()).toBe(true);
    wakes.completeReconcile(wakes.beginReconcile());
    expect(wakes.needsFastReconcile()).toBe(false);
  });

  it('several wakes are one fast reconcile, not several', () => {
    const wakes = new DiscoveryWakes();
    wakes.wake();
    const covered = wakes.beginReconcile();
    wakes.wake();
    wakes.wake();
    wakes.completeReconcile(covered);
    expect(wakes.needsFastReconcile()).toBe(true);
    wakes.completeReconcile(wakes.beginReconcile());
    expect(wakes.needsFastReconcile()).toBe(false);
  });
});
