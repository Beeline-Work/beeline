import { expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ bytes: 0 }));
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
      while (fixture.bytes <= 129 * 1024 * 1024) { fixture.bytes += Buffer.byteLength(chunk); yield chunk; }
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
