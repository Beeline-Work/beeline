import { describe, expect, it, vi } from 'vitest';
import { waitForAuthTicket } from './completion-wait.js';
describe('auth completion subscribes before one initial read', () => {
  it('pending two minutes performs one inspection and removes the waiter on its terminal deadline', async () => {
    vi.useFakeTimers();
    try {
      const read = vi.fn(async () => null), release = vi.fn();
      const waiting = waitForAuthTicket(() => release, read, 120_000);
      await vi.advanceTimersByTimeAsync(119_999); expect(read).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1); expect(await waiting).toBeNull(); expect(release).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });
  it('actual commit during initial inspection is retained and inspected once more', async () => {
    let wake!: () => void, finish!: (value: string | null) => void;
    const blocked = new Promise<string | null>(resolve => { finish = resolve; });
    const read = vi.fn().mockReturnValueOnce(blocked).mockResolvedValue('committed');
    const waiting = waitForAuthTicket(listener => { wake = listener; return () => {}; }, read, 1000);
    wake(); finish(null); expect(await waiting).toBe('committed'); expect(read).toHaveBeenCalledTimes(2);
  });
  it('explicit cancellation removes interest without retrying the observation', async () => {
    const controller = new AbortController(), release = vi.fn(), read = vi.fn(async () => null);
    const waiting = waitForAuthTicket(() => release, read, 1000, controller.signal);
    controller.abort(new Error('ceremony closed'));
    await expect(waiting).rejects.toThrow('ceremony closed'); expect(release).toHaveBeenCalledTimes(1); expect(read).toHaveBeenCalledTimes(1);
  });
});
