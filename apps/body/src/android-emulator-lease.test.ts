import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { leaseEmulator, runLeasedEmulator } from './android-emulator-lease.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Android emulator instance leases', () => {
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
