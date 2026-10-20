import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout } from 'node:timers/promises';

const launcher = fileURLToPath(new URL('./start-ci-runners.mjs', import.meta.url));
const cleaner = fileURLToPath(new URL('./ci-runner-clean.mjs', import.meta.url));
test('eight foreground listeners have separate homes and clean job state on both hooks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'beeline-ci-pool-'));
  let child;
  try {
    for (let n = 1; n <= 8; n++) {
      const directory = join(root, String(n).padStart(2, '0'));
      await mkdir(join(directory, '_work/repo/repo'), { recursive: true });
      await writeFile(join(directory, '_work/repo/repo/leftover'), 'previous job');
      await writeFile(join(directory, 'run.sh'), `#!/bin/bash
set -eu
export GITHUB_WORKSPACE="$PWD/_work/repo/repo"
"$ACTIONS_RUNNER_HOOK_JOB_STARTED"
test ! -e "$GITHUB_WORKSPACE/leftover"
printf '%s' "$HOME" > "$PWD/ready"
touch "$HOME/job-state" "$GITHUB_WORKSPACE/job-state"
trap '"$ACTIONS_RUNNER_HOOK_JOB_COMPLETED"; exit 0' TERM INT
while true; do sleep 0.1; done
`, { mode: 0o755 });
    }
    child = spawn(process.execPath, [launcher, root], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', data => { output += data; });
    child.stderr.on('data', data => { output += data; });
    const closed = new Promise(done => child.once('close', (code, signal) => done({ code, signal })));
    const deadline = Date.now() + 10000;
    while (true) {
      const ready = await Promise.all(Array.from({ length: 8 }, (_, i) => readFile(join(root, String(i + 1).padStart(2, '0'), 'ready'), 'utf8').catch(() => '')));
      if (ready.every(Boolean)) { assert.equal(new Set(ready).size, 8); break; }
      assert.ok(Date.now() < deadline, output);
      await setTimeout(25);
    }
    const duplicate = spawnSync(process.execPath, [launcher, root], { encoding: 'utf8' });
    assert.notEqual(duplicate.status, 0);
    assert.match(duplicate.stderr, /EEXIST/);
    child.kill('SIGTERM');
    assert.deepEqual(await closed, { code: 143, signal: null });
    for (let n = 1; n <= 8; n++) {
      const directory = join(root, String(n).padStart(2, '0'));
      assert.deepEqual(await readdir(join(directory, 'job-home')), []);
      assert.deepEqual(await readdir(join(directory, '_work/repo/repo')), []);
    }
  } finally {
    if (child?.exitCode === null) child.kill('SIGTERM');
    await rm(root, { recursive: true, force: true });
  }
});

test('cleanup refuses a workspace outside its instance', async () => {
  const root = await mkdtemp(join(tmpdir(), 'beeline-ci-clean-'));
  try {
    await writeFile(join(root, 'keep'), 'safe');
    const result = spawnSync(process.execPath, [cleaner], {
      env: { ...process.env, BEELINE_CI_INSTANCE: root, GITHUB_WORKSPACE: root }, encoding: 'utf8',
    });
    assert.notEqual(result.status, 0);
    assert.equal(await readFile(join(root, 'keep'), 'utf8'), 'safe');
  } finally { await rm(root, { recursive: true, force: true }); }
});
