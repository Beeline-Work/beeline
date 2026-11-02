import { afterEach, describe, expect, it, vi } from 'vitest';
import { FlyApiError, FlyMachines } from './fly-machines.js';

afterEach(() => vi.useRealTimers());

describe('Fly start during suspend', () => {
  it('updates a stale image before wake, preserving the complete Machine configuration', async () => {
    const config = { image: 'old', env: { bootstrap: 'one-time' }, rootfs: { persist: 'always' },
      metadata: { beeline_agent: 'same-agent' }, guest: { cpus: 1, memory_mb: 2048 } };
    const request = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(JSON.stringify({
      state: 'suspended', version: 'current-version', config,
    }))).mockImplementation(async () => new Response('{}'));
    await new FlyMachines('test', 'proof', request).start('m1', 'new');
    expect(request.mock.calls.map(([url]) => String(url).split('/machines')[1])).toEqual([
      '/m1', '/m1/stop', '/m1/wait?state=stopped&timeout=30', '/m1', '/m1/start',
    ]);
    expect(JSON.parse(String(request.mock.calls[3]![1]!.body))).toEqual({
      current_version: 'current-version', skip_launch: true, config: { ...config, image: 'new' },
    });
  });

  it('does not update a current digest under a different tag', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(JSON.stringify({
      state: 'stopped', config: { image: 'registry/image:old-tag@sha256:same' },
    }))).mockResolvedValue(new Response('{}'));
    await new FlyMachines('test', 'proof', request).start('m1', 'registry/image:new-tag@sha256:same');
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('never starts after a failed image update', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(JSON.stringify({
      state: 'stopped', version: 'v1', config: { image: 'old' },
    }))).mockResolvedValueOnce(new Response('{}', { status: 500 }));
    await expect(new FlyMachines('test', 'proof', request).start('m1', 'new')).rejects.toMatchObject({ operation: 'update image' });
    expect(request).toHaveBeenCalledTimes(2);
  });
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
