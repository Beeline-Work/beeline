import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

const exec = promisify(execFile);
const enabled = process.env.BEELINE_SYSTEMD_ACCEPTANCE === '1';
it.runIf(enabled)('systemd expires a frozen work loop and restarts the isolated helper', async () => {
  const root = await mkdtemp(resolve(process.cwd(), '.systemd-watchdog-'));
  const state = resolve(root, 'generation');
  const unit = `beeline-workloop-test-${process.pid}-${Date.now()}.service`;
  const systemctl = async (...args: string[]) => (await exec('systemctl', ['--user', ...args])).stdout;
  try {
    await exec('systemd-run', ['--user', '--quiet', `--unit=${unit}`,
      '--property=Type=notify', '--property=NotifyAccess=all', '--property=Restart=always',
      '--property=RestartSec=100ms', '--property=WatchdogSec=1s', '--property=TimeoutStartSec=10s',
      '--property=KillMode=control-group', `--working-directory=${process.cwd()}`,
      process.execPath, '--import', 'tsx',
      fileURLToPath(new URL('../scripts/workloop-watchdog-fixture.ts', import.meta.url)), state]);
    const deadline = Date.now() + 12_000;
    while (Number(await readFile(state, 'utf8').catch(() => '0')) < 2 && Date.now() < deadline)
      await new Promise(resolveWait => setTimeout(resolveWait, 100));
    expect(Number(await readFile(state, 'utf8'))).toBe(2);
    expect(Number(await systemctl('show', '-p', 'NRestarts', '--value', unit))).toBe(1);
    const journal = (await exec('journalctl', ['--user', '--unit', unit, '--no-pager', '-o', 'cat'])).stdout;
    expect(journal).toMatch(/watchdog timeout/i);
    // The successor's loop is healthy under the same manager and local tick.
    await new Promise(resolveWait => setTimeout(resolveWait, 1500));
    expect(Number(await systemctl('show', '-p', 'NRestarts', '--value', unit))).toBe(1);
  } finally {
    await systemctl('stop', unit).catch(() => '');
    await systemctl('reset-failed', unit).catch(() => '');
    await rm(root, { recursive: true, force: true });
  }
}, 20_000);
