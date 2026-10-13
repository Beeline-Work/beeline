import { execFile } from 'node:child_process';
import { watch } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { nativeHelperPlist, LAUNCHD_HELPER_LABEL } from './native-helper.js';
import { launchdUserDomain } from './launchd.js';
import { assertLifecycleTestIsolation } from './lifecycle-test-guard.js';

const run = promisify(execFile);
const enabled = process.platform === 'darwin' && process.env.BEELINE_LAUNCHD_ACCEPTANCE === '1';
// The test owns a unique label even on a shared Mac; never bootout the real helper.
const label = `app.usebeeline.acceptance.${process.pid}.${Date.now()}`;
const target = `${launchdUserDomain()}/${label}`;
const home = process.env.HOME!;
const root = resolve(home, 'native-acceptance');
const plist = resolve(root, 'helper.plist');
const countPath = resolve(root, 'generation');
const modePath = resolve(root, 'mode');
async function count() { return Number(await readFile(countPath, 'utf8').catch(() => '0')); }
async function nextGeneration(previous: number): Promise<void> {
  await new Promise<void>((done, reject) => {
    const watcher = watch(root, (_event, file) => { if (file === 'generation') void check(); });
    const deadline = setTimeout(() => { watcher.close(); reject(new Error('launchd did not restart the unique fixture')); }, 20_000);
    async function check() { if (await count() > previous) { clearTimeout(deadline); watcher.close(); done(); } }
    void check();
  });
}
async function kill() {
  const { stdout } = await run('launchctl', ['print', target]);
  const pid = Number(stdout.match(/^\s*pid\s*=\s*(\d+)$/m)?.[1]);
  if (!pid) throw new Error('unique launchd fixture has no PID');
  process.kill(pid, 'SIGKILL');
}

describe.runIf(enabled)('isolated launchd restart contract', () => {
  beforeAll(async () => {
    assertLifecycleTestIsolation(process.env, true);
    await mkdir(root, { recursive: true });
    await mkdir(resolve(home, '.local/bin'), { recursive: true });
    await mkdir(resolve(home, 'Library/Logs/Beeline'), { recursive: true });
    await writeFile(modePath, 'run');
    await writeFile(resolve(home, '.local/bin/beeline'), `#!/bin/sh
count_file=${JSON.stringify(countPath)}
count=0
test ! -f "$count_file" || count=$(cat "$count_file")
printf '%s\n' "$((count+1))" > "$count_file"
test "$(cat ${JSON.stringify(modePath)})" != terminal || exit 79
trap 'exit 0' TERM INT
while :; do sleep 1; done
`, { mode: 0o700 });
    await writeFile(plist, nativeHelperPlist(process.env).replaceAll(LAUNCHD_HELPER_LABEL, label));
    const started = nextGeneration(0);
    await run('launchctl', ['bootstrap', launchdUserDomain(), plist]);
    await started;
  }, 30_000);
  afterAll(async () => {
    if (enabled) await run('launchctl', ['bootout', target]).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  });
  it('restarts crashes, restarts exit 79, and honors explicit native stop', async () => {
    let prior = await count();
    let started = nextGeneration(prior);
    await kill(); await started;
    await writeFile(modePath, 'terminal');
    prior = await count(); started = nextGeneration(prior);
    await kill(); await started;
    prior = await count(); await nextGeneration(prior);
    await run('launchctl', ['bootout', target]);
    const stopped = await count();
    await sleep(7000);
    expect(await count()).toBe(stopped);
    await writeFile(modePath, 'run');
    started = nextGeneration(stopped);
    await run('launchctl', ['bootstrap', launchdUserDomain(), plist]);
    await started;
  }, 60_000);
});
