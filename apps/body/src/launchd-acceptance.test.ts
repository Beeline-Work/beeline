import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  installLaunchdAgentService,
  launchdAgentLabel,
  launchdAgentPlistPath,
  launchdUserDomain,
} from './launchd.js';

const run = promisify(execFile);
const enabled = process.platform === 'darwin' && process.env.BEELINE_LAUNCHD_ACCEPTANCE === '1';

describe.runIf(enabled)('isolated launchd supervision acceptance', () => {
  let root = '';
  let home = '';
  let publicKey = '';
  let target = '';
  let stateRoot = '';
  let env: NodeJS.ProcessEnv;

  beforeAll(async () => {
    root = await mkdtemp(resolve(tmpdir(), 'beeline-launchd-acceptance-'));
    home = resolve(root, 'home');
    stateRoot = resolve(root, 'state');
    publicKey = createHash('sha256').update(root).digest('hex');
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
printf '%s\n' "$count" > "$count_file"
printf '%s\n' "$$" > "$child_file"
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
  }, 30_000);

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

  it('restarts after a crash and is loaded again at the next login bootstrap', async () => {
    const first = await count();
    await killFixture();
    await vi.waitFor(async () => expect(await count()).toBeGreaterThan(first), {
      timeout: 20_000,
      interval: 250,
    });

    const afterCrash = await count();
    await run('launchctl', ['bootout', target]);
    await run('launchctl', ['bootstrap', launchdUserDomain(), launchdAgentPlistPath(publicKey, env)]);
    await vi.waitFor(async () => expect(await count()).toBeGreaterThan(afterCrash), {
      timeout: 20_000,
      interval: 250,
    });
  }, 45_000);

  it('does not restart a deliberate terminal status', async () => {
    await writeFile(resolve(stateRoot, 'mode'), 'terminal\n');
    const before = await count();
    await killFixture();
    await vi.waitFor(async () => expect(await count()).toBeGreaterThan(before), {
      timeout: 20_000,
      interval: 250,
    });
    const stoppedAt = await count();
    await new Promise((resolveWait) => setTimeout(resolveWait, 7_000));
    expect(await count()).toBe(stoppedAt);
  }, 35_000);
});
