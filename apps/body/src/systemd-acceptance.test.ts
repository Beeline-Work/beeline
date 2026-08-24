import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const enabled = process.env.BEELINE_SYSTEMD_ACCEPTANCE === '1';
const roots: string[] = [];
const units: string[] = [];
const fixture = fileURLToPath(
  new URL('../scripts/systemd-acceptance-fixture.mjs', import.meta.url),
);

async function systemctl(...args: string[]): Promise<string> {
  return (await execFileAsync('systemctl', ['--user', ...args], { encoding: 'utf8' })).stdout;
}

async function waitFor(check: () => Promise<boolean>, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  do {
    if (await check()) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  } while (Date.now() < deadline);
  throw new Error(`condition not met within ${timeoutMs}ms`);
}

async function start(mode: 'steady' | 'block-once' | 'relay-outage') {
  const root = await mkdtemp(resolve(tmpdir(), 'beeline-systemd-acceptance-'));
  roots.push(root);
  const state = resolve(root, 'generation');
  const unit = `beeline-acceptance-${process.pid}-${Math.random().toString(16).slice(2)}.service`;
  units.push(unit);
  await execFileAsync('systemd-run', [
    '--user',
    '--quiet',
    `--unit=${unit}`,
    '--property=Type=notify',
    '--property=NotifyAccess=all',
    '--property=Restart=always',
    '--property=RestartSec=100ms',
    '--property=WatchdogSec=1s',
    '--property=TimeoutStartSec=5s',
    '--property=KillMode=control-group',
    process.execPath,
    fixture,
    mode,
    state,
  ]);
  await waitFor(async () => Number(await readFile(state, 'utf8').catch(() => '0')) >= 1);
  return { unit, state };
}

afterEach(async () => {
  await Promise.allSettled(
    units.splice(0).map(async (unit) => {
      await systemctl('stop', unit).catch(() => '');
      await systemctl('reset-failed', unit).catch(() => '');
    }),
  );
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe.runIf(enabled)('isolated systemd supervision acceptance', () => {
  it('respawns after SIGKILL', async () => {
    const { unit, state } = await start('steady');
    const pid = Number((await systemctl('show', '-p', 'MainPID', '--value', unit)).trim());
    process.kill(pid, 'SIGKILL');
    await waitFor(async () => Number(await readFile(state, 'utf8').catch(() => '0')) >= 2);
    expect(Number((await systemctl('show', '-p', 'NRestarts', '--value', unit)).trim())).toBe(1);
  });

  it('replaces a READY process whose event loop stops progressing', async () => {
    const { unit, state } = await start('block-once');
    await waitFor(async () => Number(await readFile(state, 'utf8').catch(() => '0')) >= 2);
    expect(Number((await systemctl('show', '-p', 'NRestarts', '--value', unit)).trim())).toBe(1);
  });

  it('keeps a relay-degraded process up while progress heartbeats continue', async () => {
    const { unit } = await start('relay-outage');
    await new Promise((resolveWait) => setTimeout(resolveWait, 2_500));
    expect(Number((await systemctl('show', '-p', 'NRestarts', '--value', unit)).trim())).toBe(0);
    expect(await systemctl('show', '-p', 'StatusText', '--value', unit)).toContain(
      'relay degraded',
    );
  });
});
