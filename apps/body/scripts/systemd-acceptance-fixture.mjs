#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const [mode, statePath] = process.argv.slice(2);
if (!mode || !statePath) process.exit(64);

const previous = Number(await readFile(statePath, 'utf8').catch(() => '0')) || 0;
const generation = previous + 1;
await writeFile(statePath, `${generation}\n`);

async function notify(...fields) {
  await execFileAsync('systemd-notify', fields);
}

await notify('--ready', `--status=${mode}; generation=${generation}`);

// The first generation deliberately wedges its event loop after READY. It
// cannot emit a watchdog progress notification, so systemd must replace it.
if (mode === 'block-once' && generation === 1) {
  while (true) {
    // This process is scoped to an isolated transient test unit.
  }
}

const status = mode === 'relay-outage' ? 'relay degraded; loop progressing' : 'healthy';
const timer = setInterval(() => {
  void notify('WATCHDOG=1', `STATUS=${status}; generation=${generation}`);
}, 100);

process.on('SIGTERM', () => {
  clearInterval(timer);
  process.exit(0);
});
