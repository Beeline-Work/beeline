#!/usr/bin/env node
// Supervise already registered runners; registration stays outside this script.
import { spawn } from 'node:child_process';
import { mkdir, access, realpath, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = await realpath(resolve(process.argv[2] ?? `${process.env.HOME}/beeline-ci`));
const count = Number(process.argv[3] ?? 8);
if (!Number.isInteger(count) || count < 1 || count > 32) throw new Error('runner count must be 1–32');
const hook = fileURLToPath(new URL('./ci-runner-clean.sh', import.meta.url));
const directories = Array.from({ length: count }, (_, i) => join(root, String(i + 1).padStart(2, '0')));
// Validate all instances before starting any. Each must be registered with label beeline-ci.
for (const directory of directories) {
  if (await realpath(directory) !== directory) throw new Error(`runner directory must not be a symlink: ${directory}`);
  await access(join(directory, 'run.sh'), constants.X_OK);
}
const lock = join(root, '.pool-running');
await mkdir(lock); // A second supervisor must not start the same listeners.
const children = [];
const completions = [];
let stopping = false;
function stop(code) {
  if (stopping) return;
  stopping = true;
  process.exitCode = code;
  for (const child of children) {
    if (child.exitCode === null && child.pid) {
      try { process.kill(-child.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
  }
  const timeout = setTimeout(() => {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null && child.pid) {
        try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
      }
    }
  }, 10000);
  timeout.unref();
}
process.on('SIGINT', () => stop(130));
process.on('SIGTERM', () => stop(143));
try {
  for (const directory of directories) {
    if (stopping) break;
    const home = join(directory, 'job-home');
    const temp = join(directory, 'job-tmp');
    await mkdir(home, { recursive: true });
    await mkdir(temp, { recursive: true });
    const child = spawn('./run.sh', [], {
      cwd: directory, detached: true, stdio: 'inherit',
      env: {
        ...process.env, HOME: home, TMPDIR: temp,
        XDG_CONFIG_HOME: join(home, '.config'), XDG_STATE_HOME: join(home, '.local/state'),
        XDG_CACHE_HOME: join(home, '.cache'),
        BEELINE_CI_INSTANCE: directory,
        ACTIONS_RUNNER_HOOK_JOB_STARTED: hook,
        ACTIONS_RUNNER_HOOK_JOB_COMPLETED: hook,
      },
    });
    children.push(child);
    completions.push(new Promise(done => child.once('close', done)));
    child.on('error', () => stop(1));
    child.on('exit', () => { if (!stopping) stop(1); });
    console.log(`Started runner ${directory}: pid ${child.pid}`);
  }
  await Promise.all(completions);
} finally {
  await rm(lock, { recursive: true, force: true });
}
