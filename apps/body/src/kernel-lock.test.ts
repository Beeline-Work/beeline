import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { expect, it } from 'vitest';
import { withKernelLock } from './kernel-lock.js';
it('serializes installers and releases ownership when the owner process dies', async () => {
  const key = `beeline-proof:${randomUUID()}`;
  const source = `import { withKernelLock } from ${JSON.stringify(new URL('./kernel-lock.ts', import.meta.url).pathname)}; await withKernelLock(${JSON.stringify(key)}, async () => { console.log('owned'); await new Promise(() => {}); });`;
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let ready = '';
  await new Promise<void>((done, reject) => {
    child.stdout.on('data', (chunk) => {
      ready += chunk;
      if (ready.includes('owned')) done();
    });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (!ready.includes('owned')) reject(new Error(`owner exited ${code}`));
    });
  });
  let acquired = false;
  const next = withKernelLock(
    key,
    async () => {
      acquired = true;
    },
    2000,
  );
  await new Promise((done) => setTimeout(done, 20));
  expect(acquired).toBe(false);
  const exited = once(child, 'exit');
  child.kill('SIGKILL');
  await exited;
  await next;
  expect(acquired).toBe(true);
});

it.runIf(process.platform === 'linux')(
  'never waits on an unrelated HTTP fixture that owns the former hashed port',
  async () => {
    const key = `beeline-collision:${randomUUID()}`;
    const port = 20_000 + (createHash('sha256').update(key).digest().readUInt32BE(0) % 40_000);
    const server = createServer((_request, response) => response.end('unrelated fixture'));
    await new Promise<void>((done, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', done);
    });
    try {
      await expect(withKernelLock(key, async () => 'owned', 1000)).resolves.toBe('owned');
    } finally {
      await new Promise<void>((done) => server.close(() => done()));
    }
  },
);

it('releases a completed owner even while a contender was connected', async () => {
  const key = `beeline-completion:${randomUUID()}`;
  let release!: () => void, entered!: () => void;
  const inside = new Promise<void>((done) => {
    entered = done;
  });
  const gate = new Promise<void>((done) => {
    release = done;
  });
  const owner = withKernelLock(key, async () => {
    entered();
    await gate;
  });
  await inside;
  const successor = withKernelLock(key, async () => 'successor', 1000);
  await new Promise((done) => setTimeout(done, 20));
  release();
  await owner;
  await expect(successor).resolves.toBe('successor');
  await expect(withKernelLock(key, async () => 'third', 1000)).resolves.toBe('third');
});
