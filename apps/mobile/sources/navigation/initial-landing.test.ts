import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  INITIAL_LANDING_TIMEOUT_MS,
  isInitialLandingResolved,
  markInitialLandingResolved,
  resetInitialLandingForTests,
  whenInitialLandingResolved,
} from './initial-landing';

describe('initial landing gate', () => {
  beforeEach(() => {
    resetInitialLandingForTests();
  });

  it('holds a waiter until the app root has chosen its landing route', async () => {
    let landed = false;
    const waiting = whenInitialLandingResolved().then(() => {
      landed = true;
    });

    await Promise.resolve();
    expect(landed).toBe(false);
    expect(isInitialLandingResolved()).toBe(false);

    markInitialLandingResolved();
    await waiting;
    expect(landed).toBe(true);
    expect(isInitialLandingResolved()).toBe(true);
  });

  it('never waits once the landing has been chosen', async () => {
    markInitialLandingResolved();
    let landed = false;
    void whenInitialLandingResolved().then(() => {
      landed = true;
    });
    await Promise.resolve();
    expect(landed).toBe(true);
  });

  it('is idempotent, so a re-rendered app root cannot re-open the gate', async () => {
    markInitialLandingResolved();
    markInitialLandingResolved();
    await expect(whenInitialLandingResolved()).resolves.toBeUndefined();
  });

  // A landing that never lands must not swallow the tap: the app is unusable
  // by then anyway, and waiting forever would be worse than routing late.
  it('gives up on the landing rather than losing the tap', async () => {
    vi.useFakeTimers();
    try {
      let landed = false;
      const waiting = whenInitialLandingResolved().then(() => {
        landed = true;
      });
      await vi.advanceTimersByTimeAsync(INITIAL_LANDING_TIMEOUT_MS - 1);
      expect(landed).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await waiting;
      expect(landed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
