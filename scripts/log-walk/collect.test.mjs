import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

// R2: on 2026-10-31 flyctl caught SIGTERM and never exited, so `timeout` without
// -k waited forever and server logs stopped for two days. A stream that ignores
// SIGTERM must still be replaced on the next window.
test('R2: collector reconnects when the log stream ignores SIGTERM', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'log-collect-'));
  const calls = join(dir, 'calls');
  const fake = join(dir, 'flyctl');
  await writeFile(fake, `#!/usr/bin/env bash\ntrap '' TERM\necho x >> '${calls}'\necho "$(date -u +%Y-%m-%dT%H:%M:%SZ) line $$"\nwhile true; do sleep 0.1; done\n`);
  await chmod(fake, 0o755);
  const child = spawn('bash', ['scripts/log-walk/collect.sh', 'demo-app', join(dir, 'raw')], {
    detached: true, stdio: 'ignore',
    env: { ...process.env, LOG_COLLECT_FLYCTL: fake, LOG_COLLECT_WINDOW_SECONDS: '1', LOG_COLLECT_KILL_AFTER_SECONDS: '1', LOG_COLLECT_PAUSE_SECONDS: '0.2' },
  });
  try {
    await delay(6000);
    const count = (await readFile(calls, 'utf8')).trim().split('\n').length;
    assert.ok(count >= 2, `expected a reconnect, saw ${count} stream start(s)`);
    assert.ok((await readdir(join(dir, 'raw', 'demo-app'))).some(name => /^\d{4}-\d\d-\d\d\.log$/.test(name)));
  } finally {
    try { process.kill(-child.pid, 'SIGKILL'); } catch {}
    await rm(dir, { recursive: true, force: true });
  }
});
