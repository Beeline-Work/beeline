import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SPLASH_WATCHDOG_MS, armLaunchSplash } from './splash-watchdog';

describe('launch splash watchdog', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('hides the splash once when launch settles before the deadline', () => {
    const hide = vi.fn();
    const splash = armLaunchSplash(hide);
    splash.release();
    splash.release();
    vi.advanceTimersByTime(SPLASH_WATCHDOG_MS);
    expect(hide).toHaveBeenCalledTimes(1);
  });

  it('hides the splash at the deadline when launch never settles', () => {
    const hide = vi.fn();
    const log = vi.fn();
    armLaunchSplash(hide, { log });
    vi.advanceTimersByTime(SPLASH_WATCHDOG_MS - 1);
    expect(hide).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(hide).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledTimes(1);
  });

  it('does not hide twice when launch settles after the deadline', () => {
    const hide = vi.fn();
    const splash = armLaunchSplash(hide, { timeoutMs: 10 });
    vi.advanceTimersByTime(10);
    splash.release();
    expect(hide).toHaveBeenCalledTimes(1);
  });
});
