import os from 'node:os';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { contention, summarizeLoad } from './nightly-compare.mjs';

export async function waitLoad({ timeoutMs = 45 * 60000, pollMs = 30000, now = Date.now,
  pause = sleep, observe = () => ({ atMs: now(), load: os.loadavg(), cpus: os.availableParallelism(),
    freeMemory: os.freemem(), totalMemory: os.totalmem() }), save = async () => {} } = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || !Number.isFinite(pollMs) || pollMs <= 0)
    throw new Error('Load gate requires a finite nonnegative timeout and positive polling interval');
  const deadline = now() + Math.min(timeoutMs, 45 * 60000);
  const observations = [];
  for (;;) {
    const sample = observe();
    observations.push(sample);
    await save(observations);
    const load = summarizeLoad([sample]);
    console.log(`Host load gate: load=${load.mean}, cpus=${load.cpus}, contended=${contention(load)}`);
    if (contention(load) === false) return true;
    // Never wait into the 04:00 Eastern prompt replay window.
    const hour = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', hourCycle: 'h23' }).format(now()));
    if (now() >= deadline || hour === 4) {
      sample.captureSkipped = 'host-contended';
      await save(observations);
      return false;
    }
    await pause(Math.min(pollMs, deadline - now(), 60000 - now() % 60000));
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const output = process.argv[2];
  await mkdir(dirname(output), { recursive: true });
  const passed = await waitLoad({ timeoutMs: Number(process.env.LATENCY_RIG_LOAD_WAIT_MS ?? 45 * 60000),
    save: (samples) => writeFile(output, JSON.stringify(samples, null, 2) + '\n') });
  if (!passed) { console.error('Capture skipped: host remained contended before the load gate deadline'); process.exitCode = 3; }
}
