import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  bootstrapLaunchdAgentService,
  installLaunchdAgentService,
  launchdAgentJobStatus,
  launchdAgentLabel,
  launchdUserDomain,
} from './launchd.js';

const run = promisify(execFile);
const enabled = process.platform === 'darwin' && process.env.BEELINE_LAUNCHD_ACCEPTANCE === '1';

/**
 * A fixed label, not one derived from this run's tmpdir: a cancelled run (the
 * job has its own timeout) leaves a real bootstrapped job behind whose files are
 * gone, and only a stable label lets the next run's `bootoutIfLoaded` reclaim it.
 * The temp HOME keeps the plist away from any paired agent.
 */
const publicKey = 'ac'.repeat(32);

describe.runIf(enabled)('isolated launchd supervision acceptance', () => {
  let root = '';
  let home = '';
  let target = '';
  let stateRoot = '';
  let env: NodeJS.ProcessEnv;

  beforeAll(async () => {
    root = await mkdtemp(resolve(tmpdir(), 'beeline-launchd-acceptance-'));
    home = resolve(root, 'home');
    stateRoot = resolve(root, 'state');
    target = `${launchdUserDomain()}/${launchdAgentLabel(publicKey)}`;
    const bin = resolve(home, '.local', 'bin');
    const lib = resolve(home, '.local', 'lib', 'beeline');
    await mkdir(bin, { recursive: true });
    await mkdir(resolve(lib, 'lib', 'beeline'), { recursive: true });
    await mkdir(stateRoot, { recursive: true });
    await writeFile(resolve(stateRoot, 'mode'), 'run\n');
    await writeFile(
      resolve(bin, 'beeline'),
      `#!/bin/sh
count_file=${JSON.stringify(resolve(stateRoot, 'count'))}
child_file=${JSON.stringify(resolve(stateRoot, 'child-pid'))}
mode_file=${JSON.stringify(resolve(stateRoot, 'mode'))}
count=0
test ! -f "$count_file" || count=$(cat "$count_file")
count=$((count + 1))
printf '%s\n' "$$" > "$child_file"
printf '%s\n' "$count" > "$count_file"
test "$(cat "$mode_file")" != terminal || exit 78
trap 'exit 0' TERM INT
while :; do sleep 1; done
`,
      { mode: 0o700 },
    );
    await chmod(resolve(bin, 'beeline'), 0o700);
    const invocationPath = resolve(lib, 'lib', 'beeline', 'beeline-cli.mjs');
    await writeFile(invocationPath, 'acceptance fixture\n');
    env = { HOME: home, BEELINE_LIB_DIR: lib };
    await installLaunchdAgentService(publicKey, { env, invocationPath, waitTimeoutMs: 15_000 });
    await waitForCountGreaterThan(0);
  }, 40_000);

  afterAll(async () => {
    await run('launchctl', ['bootout', target]).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  });

  async function count(): Promise<number> {
    return Number((await readFile(resolve(stateRoot, 'count'), 'utf8')).trim());
  }

  async function killFixture(): Promise<void> {
    const pid = Number((await readFile(resolve(stateRoot, 'child-pid'), 'utf8')).trim());
    process.kill(pid, 'SIGKILL');
  }

  async function waitForCountGreaterThan(previous: number): Promise<void> {
    try {
      await vi.waitFor(async () => expect(await count()).toBeGreaterThan(previous), {
        timeout: 20_000,
        interval: 250,
      });
    } catch (error) {
      // A bare count assertion cannot say whether launchd refused the job, left
      // it stopped, or started it and had it die, and that is the whole
      // difference between a supervision bug and a fixture bug.
      const status = await launchdAgentJobStatus(publicKey, { env });
      throw new Error(
        `launchd did not reach start #${previous + 1} within 20s: ` +
          `state=${status.state || 'unknown'} pid=${status.pid} ` +
          `lastExit=${status.lastExitStatus ?? 'none'} · ` +
          `${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }

  /**
   * The closest non-destructive CI equivalent of the next login: no job loaded
   * for the label, then the installed plist bootstrapped from
   * `~/Library/LaunchAgents`.
   *
   * `launchctl bootout` returns before launchd has taken the job out of the
   * domain, and a bootstrap of a label still there is refused, so the removal is
   * waited out. The fixture's supervisor exits 1 on the SIGTERM bootout sends
   * (a clean daemon stop is an unsuccessful launchd exit, which is exactly what
   * `KeepAlive.SuccessfulExit=false` restarts), so a removal launchd reads as a
   * crash can put the job back; the label is re-booted out until it stays gone.
   */
  async function loginBootstrap(): Promise<void> {
    const deadline = Date.now() + 30_000;
    for (;;) {
      await run('launchctl', ['bootout', target]).catch(() => undefined);
      await sleep(250);
      if ((await launchdAgentJobStatus(publicKey, { env })).state === 'unloaded') break;
      if (Date.now() >= deadline) {
        throw new Error(`launchd never removed ${launchdAgentLabel(publicKey)} after bootout`);
      }
    }
    await bootstrapLaunchdAgentService(publicKey, { env });
  }

  it('restarts after a crash and is loaded again at the next login bootstrap', async () => {
    const first = await count();
    await killFixture();
    await waitForCountGreaterThan(first);

    const afterCrash = await count();
    await loginBootstrap();
    await waitForCountGreaterThan(afterCrash);
  }, 60_000);

  it('does not restart a deliberate terminal status', async () => {
    // Both tests run in one process against one job, so this one re-establishes
    // a loaded, running daemon rather than inheriting it: a bootstrap failure
    // above must read as that failure, not as an unexplained timeout here.
    const loaded = await count();
    await loginBootstrap();
    await waitForCountGreaterThan(loaded);

    await writeFile(resolve(stateRoot, 'mode'), 'terminal\n');
    const before = await count();
    await killFixture();
    await waitForCountGreaterThan(before);
    const stoppedAt = await count();
    await sleep(7_000);
    expect(await count()).toBe(stoppedAt);
  }, 60_000);
});
