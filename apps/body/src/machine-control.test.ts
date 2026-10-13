import { chmod, mkdir, mkdtemp, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { MachineControl, machineControlPath, requestMachine } from './machine-control.js';
import type { HelperStatusFile } from './helper-status.js';

const status: HelperStatusFile = {
  pid: process.pid,
  generation: 'long-home',
  processState: 'serving',
  updatedAt: 'now',
  agents: {},
};

it('serves distinct private control sockets with arbitrarily long and Unicode state homes', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'beeline-control-proof-'));
  const states = [resolve(root, '長'.repeat(80)), resolve(root, 'a'.repeat(200), 'state')];
  const paths = states.map(machineControlPath);
  const controls = paths.map((path) => new MachineControl(path, async () => undefined));
  try {
    for (const [i, control] of controls.entries()) {
      await control.start();
      control.publish({ ...status, generation: `long-home-${i}` });
      expect(Buffer.byteLength(control.path)).toBeLessThan(104);
      expect((await stat(dirname(control.path))).mode & 0o777).toBe(0o700);
      expect((await stat(control.path)).mode & 0o777).toBe(0o600);
    }
    const snapshots = await Promise.all(
      states.map((state) => requestMachine(state, { operation: 'converge' }, () => true, 1000)),
    );
    expect(snapshots.map((snapshot) => snapshot.generation)).toEqual([
      'long-home-0',
      'long-home-1',
    ]);
    expect(paths[0]).not.toBe(paths[1]);
  } finally {
    for (const control of controls) await control.stop();
    for (const path of paths) await rm(dirname(path), { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

it('refuses a substituted control directory for both the helper and its client', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'beeline-control-substitution-'));
  const path = machineControlPath(root);
  const control = new MachineControl(path, async () => undefined);
  try {
    await symlink(root, dirname(path));
    await expect(control.start()).rejects.toThrow('private helper control directory');
    await expect(requestMachine(root, { operation: 'converge' }, () => true, 1000)).rejects.toThrow(
      'private helper control directory',
    );
  } finally {
    await control.stop();
    await rm(dirname(path), { force: true });
    await rm(root, { recursive: true, force: true });
  }
});

it('refuses a control directory accessible by another user', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'beeline-control-permissions-'));
  const path = machineControlPath(root);
  try {
    await mkdir(dirname(path), { mode: 0o700 });
    await chmod(dirname(path), 0o755);
    await expect(requestMachine(root, { operation: 'status' }, () => true, 1000)).rejects.toThrow(
      'private helper control directory',
    );
    await expect(new MachineControl(path, async () => undefined).start()).rejects.toThrow(
      'private helper control directory',
    );
  } finally {
    await rm(dirname(path), { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

it('observes the successor generation through socket creation events at a long state path', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'beeline-control-successor-'));
  const state = resolve(root, 'state'.repeat(40));
  const path = machineControlPath(state);
  let acknowledge!: () => void;
  const requested = new Promise<void>((done) => {
    acknowledge = done;
  });
  const before = new MachineControl(path, async () => acknowledge());
  const after = new MachineControl(path, async () => undefined);
  try {
    await before.start();
    before.publish(status);
    const pending = requestMachine(
      state,
      { operation: 'converge' },
      (snapshot) => snapshot.generation === 'successor',
      1000,
    );
    await requested;
    await before.stop();
    await after.start();
    after.publish({ ...status, generation: 'successor' });
    expect((await pending).generation).toBe('successor');
  } finally {
    await before.stop();
    await after.stop();
    await rm(dirname(path), { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});
