import { expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ bytes: 0, limit: 129 * 1024 * 1024, advance: undefined as undefined | (() => Promise<void>) }));
vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const { EventEmitter } = await import('node:events');
  const { Readable, PassThrough } = await import('node:stream');
  return { ...actual, spawn: (...args: unknown[]) => {
    if (args[0] !== '/usr/bin/python3') return Reflect.apply(actual.spawn, undefined, args);
    const child = new EventEmitter() as InstanceType<typeof EventEmitter> & { stdout: InstanceType<typeof Readable>; stderr: InstanceType<typeof PassThrough> };
    const row = `${JSON.stringify(['/large/cache/blob', 1, 2, 4096, 1, false, 1])}\n`;
    const chunk = row.repeat(4096);
    child.stdout = Readable.from((async function* () {
      // Duplicate inode rows keep this fixture's memory small while exercising
      // the real parser with a pipe larger than the old 128 MiB execFile cap.
      while (fixture.bytes <= fixture.limit) { await fixture.advance?.(); fixture.bytes += Buffer.byteLength(chunk); yield chunk; }
      setImmediate(() => child.emit('close', 0));
    })());
    child.stderr = new PassThrough();
    return child;
  } };
});
import { storageTree } from './storage-filesystem.js';

it.skipIf(process.platform !== 'linux')('streams inventories larger than the old output cap without retaining a second giant JSON buffer', async () => {
  const tree = await storageTree('/large/cache');
  expect(fixture.bytes).toBeGreaterThan(128 * 1024 * 1024);
  expect(tree.size).toBe(1);
  expect(tree.get('/large/cache/blob')?.blocks).toBe(4096);
});


it.skipIf(process.platform !== 'linux')('Reproduction storage-watchdog: a moving inventory acknowledges watchdog progress before expiry', async () => {
  const { startLocalWatchdog } = await import('./systemd.js');
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
  fixture.bytes = 0;
  fixture.limit = 4 * 1024 * 1024;
  let acknowledge: (() => void) | undefined;
  const feeds = vi.fn(async () => undefined);
  const stalled = vi.fn();
  const stop = startLocalWatchdog({ progress: feeds }, () => 'healthy',
    () => new Promise<void>(done => { acknowledge = done; }),
    60_000, { WATCHDOG_USEC: '180000000' }, undefined, stalled);
  fixture.advance = () => vi.advanceTimersByTimeAsync(60_000);
  const progress = vi.fn(async () => { acknowledge?.(); acknowledge = undefined; });
  try {
    const tree = await storageTree('/large/cache', progress);
    await vi.advanceTimersByTimeAsync(0);
    expect(tree.size).toBe(1);
    expect(stalled).not.toHaveBeenCalled();
    expect(feeds.mock.calls.length).toBeGreaterThan(3);
  } finally {
    stop(); fixture.advance = undefined; fixture.limit = 129 * 1024 * 1024;
    vi.useRealTimers();
  }
});
