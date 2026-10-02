import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  OomKillTracker,
  cgroupOomKillProbe,
  parseOomKillCount,
  unifiedCgroupPath,
  type OomKillProbe,
} from './oom-kill.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('cgroup OOM counter reading', () => {
  it('reads only the oom_kill line from a memory.events body', () => {
    expect(
      parseOomKillCount('low 0\nhigh 2\nmax 0\noom 4\noom_kill 7\noom_group_kill 1\n'),
    ).toBe(7);
    expect(parseOomKillCount('low 0\nhigh 2\n')).toBeNull();
    expect(parseOomKillCount('oom_kill not-a-number\n')).toBeNull();
  });

  it('takes the unified-hierarchy path and ignores a v1 or malformed body', () => {
    expect(unifiedCgroupPath('0::/user.slice/user-1000.slice/beeline.service\n')).toBe(
      '/user.slice/user-1000.slice/beeline.service',
    );
    expect(unifiedCgroupPath('5:cpu:/legacy\n')).toBeNull();
    expect(unifiedCgroupPath('0::relative\n')).toBeNull();
  });

  it('reads the daemon cgroup memory.events and stays null when it is unavailable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'beeline-oom-cgroup-'));
    roots.push(root);
    await mkdir(join(root, 'user.slice', 'beeline.service'), { recursive: true });
    await writeFile(
      join(root, 'user.slice', 'beeline.service', 'memory.events'),
      'oom 0\noom_kill 3\n',
    );
    const probe = cgroupOomKillProbe({
      cgroupRoot: root,
      procSelfCgroup: async () => '0::/user.slice/beeline.service\n',
    });
    await expect(probe.read()).resolves.toBe(3);

    const missing = cgroupOomKillProbe({
      cgroupRoot: root,
      procSelfCgroup: async () => '0::/user.slice/absent.service\n',
    });
    await expect(missing.read()).resolves.toBeNull();

    const legacy = cgroupOomKillProbe({
      cgroupRoot: root,
      procSelfCgroup: async () => '5:cpu:/legacy\n',
    });
    await expect(legacy.read()).resolves.toBeNull();
  });
});

describe('OomKillTracker', () => {
  function probeOf(values: Array<number | null>): OomKillProbe {
    let index = 0;
    return {
      async read() {
        const value = values[Math.min(index, values.length - 1)];
        index += 1;
        return value ?? null;
      },
    };
  }

  it('reports a kill only after the counter advances past the primed baseline', async () => {
    const tracker = new OomKillTracker(probeOf([4, 4, 5]));
    await tracker.prime();
    await expect(tracker.consume()).resolves.toBe(false);
    await expect(tracker.consume()).resolves.toBe(true);
  });

  it('banks simultaneous increments so each killed child reports one', async () => {
    const tracker = new OomKillTracker(probeOf([2, 4, 4]));
    await tracker.prime();
    await expect(tracker.consume()).resolves.toBe(true);
    await expect(tracker.consume()).resolves.toBe(true);
    await expect(tracker.consume()).resolves.toBe(false);
  });

  it('never reports a kill when the counter is unreadable', async () => {
    const tracker = new OomKillTracker(probeOf([null, null]));
    await tracker.prime();
    await expect(tracker.consume()).resolves.toBe(false);
  });
});
