import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  INITIAL_LANDING_TIMEOUT_MS,
  isInitialLandingNavigationSuppressed,
  isInitialLandingResolved,
  markInitialLandingResolved,
  resetInitialLandingForTests,
  suppressInitialLandingNavigation,
  whenInitialLandingResolved,
} from './initial-landing';

describe('initial landing gate', () => {
  beforeEach(() => {
    resetInitialLandingForTests();
  });

  it('holds a waiter until the app root has chosen its landing route', async () => {
    let landed = false;
    let result: string | undefined;
    const waiting = whenInitialLandingResolved().then((value) => {
      result = value;
      landed = true;
    });

    await Promise.resolve();
    expect(landed).toBe(false);
    expect(isInitialLandingResolved()).toBe(false);

    markInitialLandingResolved();
    await waiting;
    expect(result).toBe('committed');
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
    await expect(whenInitialLandingResolved()).resolves.toBe('committed');
  });

  // A tapped push claims the destination while the landing decision is still
  // pending: the app root's landing replace must then never run, or it would
  // overwrite the notification navigation (the #926 bug reopened on the
  // timeout path).
  it('lets a tapped push claim the destination, suppressing the landing replace', async () => {
    let landed = false;
    const waiting = whenInitialLandingResolved().then(() => {
      landed = true;
    });
    await Promise.resolve();
    expect(landed).toBe(false);
    expect(isInitialLandingNavigationSuppressed()).toBe(false);

    suppressInitialLandingNavigation();

    expect(isInitialLandingNavigationSuppressed()).toBe(true);
    await waiting;
    expect(landed).toBe(true);
    expect(isInitialLandingResolved()).toBe(true);
  });

  it('clears the suppression with the rest of the gate state', () => {
    suppressInitialLandingNavigation();
    expect(isInitialLandingNavigationSuppressed()).toBe(true);

    resetInitialLandingForTests();

    expect(isInitialLandingNavigationSuppressed()).toBe(false);
  });

  // A landing that never lands must not swallow the tap: the app is unusable
  // by then anyway, and waiting forever would be worse than routing late.
  it('gives up on the landing rather than losing the tap', async () => {
    vi.useFakeTimers();
    try {
      let landed = false;
      let result: string | undefined;
      const waiting = whenInitialLandingResolved().then((value) => {
        result = value;
        landed = true;
      });
      await vi.advanceTimersByTimeAsync(INITIAL_LANDING_TIMEOUT_MS - 1);
      expect(landed).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await waiting;
      expect(result).toBe('timeout');
      expect(landed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
