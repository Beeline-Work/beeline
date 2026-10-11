import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { leaseEmulator, runLeasedEmulator } from './android-emulator-lease.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Android emulator instance leases', () => {
  it('skips an occupied console port pair', async () => {
    const root = await mkdtemp(join(tmpdir(), 'beeline-emulator-port-'));
    roots.push(root);
    const server = createServer();
    let listening = false;
    try {
      await new Promise<void>((done, reject) => {
        server.once('error', reject);
        server.listen(5554, '127.0.0.1', () => done());
      });
      listening = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error;
    }
    try {
      const lease = await leaseEmulator(join(root, 'shared'), join(root, 'private'));
      expect(lease.port).not.toBe(5554);
      await lease.release();
    } finally { if (listening) await new Promise<void>((done) => server.close(() => done())); }
  });

  it('reclaims every stale marker on the first attempt, including a reused PID', async () => {
    const root = await mkdtemp(join(tmpdir(), 'beeline-emulator-stale-'));
    roots.push(root);
    const shared = join(root, 'shared');
    await mkdir(shared);
    for (let port = 5554; port <= 5584; port += 4)
      await writeFile(join(shared, `port-${port}.lease`), `${process.pid}:wrong-start:old`);
    const lease = await leaseEmulator(shared, join(root, 'private'));
    expect(lease.port).toBe(5554);
    await lease.release();
  });

  it('gives two agents distinct ports and writable instance directories', async () => {
    const root = await mkdtemp(join(tmpdir(), 'beeline-emulator-'));
    roots.push(root);
    const first = await leaseEmulator(join(root, 'shared/leases'), join(root, 'agent-a'));
    const second = await leaseEmulator(join(root, 'shared/leases'), join(root, 'agent-b'));
    expect(first.port).not.toBe(second.port);
    expect(first.root).toContain('agent-a');
    expect(second.root).toContain('agent-b');
    await first.release();
    await second.release();
  });

  it('materializes private AVD metadata, passes a leased port and releases it on exit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'beeline-emulator-run-'));
    roots.push(root);
    const avd = join(root, 'base/avd');
    await mkdir(join(avd, 'test.avd'), { recursive: true });
    await writeFile(join(avd, 'test.ini'), `path=${join(avd, 'test.avd')}\npath.rel=avd/test.avd\ntarget=android-36\n`);
    await writeFile(join(avd, 'test.avd/config.ini'), 'image.sysdir.1=system-images/android-36/default/x86_64/\n');
    const fake = join(root, 'fake-emulator');
    await writeFile(fake, `#!/bin/sh\nprintf '%s\\n' "$@" > "${root}/argv"\nprintf '%s\\n' "$ANDROID_AVD_HOME" > "${root}/avd-home"\n`);
    await chmod(fake, 0o755);
    const env = {
      BEELINE_ANDROID_LEASE_ROOT: join(root, 'shared/leases'),
      BEELINE_ANDROID_INSTANCE_ROOT: join(root, 'private'),
      BEELINE_ANDROID_BASE_AVD_HOME: avd,
      BEELINE_ANDROID_EMULATOR_BINARY: fake,
    };
    expect(await runLeasedEmulator(['-avd', 'test', '-no-window'], env)).toBe(0);
    const argv = await readFile(join(root, 'argv'), 'utf8');
    const port = Number(argv.match(/-port\n(\d+)\n/)?.[1]);
    expect(port).toBeGreaterThanOrEqual(5554);
    expect(port).toBeLessThanOrEqual(5584);
    expect(port % 2).toBe(0);
    expect(argv).toContain('-datadir\n');
    expect(await readFile(join(root, 'avd-home'), 'utf8')).toContain('private/instance-');
    const next = await leaseEmulator(env.BEELINE_ANDROID_LEASE_ROOT, env.BEELINE_ANDROID_INSTANCE_ROOT);
    expect(next.port).toBe(port);
    await next.release();
  });
});
