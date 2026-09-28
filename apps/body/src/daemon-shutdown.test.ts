import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DAEMON_HARD_STOP_MS, installDaemonStopSignals } from './daemon-shutdown.js';

afterEach(() => vi.useRealTimers());

describe('daemon signal shutdown', () => {
  it('aborts immediately on SIGTERM and hard exits if cleanup stays stuck', async () => {
    vi.useFakeTimers();
    const emitter = new EventEmitter();
    const controller = new AbortController();
    const hardExit = vi.fn();
    const dispose = installDaemonStopSignals(controller, { emitter, hardExit });
    emitter.emit('SIGTERM');
    expect(controller.signal.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(DAEMON_HARD_STOP_MS - 1);
    expect(hardExit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(hardExit).toHaveBeenCalledOnce();
    dispose();
  });

  it('cancels the hard exit once shutdown finishes', async () => {
    vi.useFakeTimers();
    const emitter = new EventEmitter();
    const controller = new AbortController();
    const hardExit = vi.fn();
    const dispose = installDaemonStopSignals(controller, { emitter, hardExit });
    emitter.emit('SIGTERM');
    dispose();
    await vi.advanceTimersByTimeAsync(DAEMON_HARD_STOP_MS);
    expect(hardExit).not.toHaveBeenCalled();
  });
});
