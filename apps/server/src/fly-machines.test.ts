import { afterEach, describe, expect, it, vi } from 'vitest';
import { FlyApiError, FlyMachines } from './fly-machines.js';

afterEach(() => vi.useRealTimers());

describe('Fly start during suspend', () => {
  it('retries a snapshot transition and starts the same Machine without waiting for the sweep', async () => {
    vi.useFakeTimers();
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('{"error":"machine still active"}', { status: 412 }))
      .mockResolvedValueOnce(new Response('{}'));
    const machines = new FlyMachines('test', 'proof', request);
    const started = machines.start('m1');
    await vi.advanceTimersByTimeAsync(249);
    expect(request).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await started;
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls.every(([url]) => String(url).endsWith('/machines/m1/start'))).toBe(
      true,
    );
  });

  it('bounds retries when the transition never finishes', async () => {
    vi.useFakeTimers();
    const request = vi
      .fn<typeof fetch>()
      .mockImplementation(
        async () => new Response('{"error":"machine still active"}', { status: 412 }),
      );
    const started = new FlyMachines('test', 'proof', request).start('m1');
    const rejected = expect(started).rejects.toMatchObject({ status: 412 });
    await vi.advanceTimersByTimeAsync(5_750);
    await rejected;
    expect(request).toHaveBeenCalledTimes(6);
  });

  it.each([401, 403, 404, 429, 500])(
    'does not turn HTTP %i into a suspend retry',
    async (status) => {
      const request = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}', { status }));
      await expect(new FlyMachines('test', 'proof', request).start('m1')).rejects.toBeInstanceOf(
        FlyApiError,
      );
      expect(request).toHaveBeenCalledTimes(1);
    },
  );
});
