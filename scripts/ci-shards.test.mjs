import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, symlinkSync, rmSync, mkdirSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { balanceFiles } from '../apps/server/scripts/ci-shards.mjs';

test('measured slow files land on separate shards with complete, disjoint coverage', () => {
  const times = { slow: 300, medium: 200, quick: 100, tiny: 10 };
  const shards = balanceFiles(Object.keys(times), times, 2);
  assert.deepEqual(shards.map((shard) => shard.milliseconds), [310, 300]);
  assert.deepEqual(shards.flatMap((shard) => shard.files).sort(), Object.keys(times).sort());
});

test('new tests remain covered, deleted timings are ignored, and discovery order does not change assignments', () => {
  const files = ['new.test.ts', 'old.test.ts', 'other.test.ts'];
  const timings = { 'old.test.ts': 100, 'other.test.ts': 300, 'deleted.test.ts': 200 };
  const first = balanceFiles(files, timings, 2);
  assert.deepEqual(balanceFiles([...files].reverse(), timings, 2), first);
  assert.ok(first.some((shard) => shard.files.includes('new.test.ts')));
  assert.equal(first.flatMap((shard) => shard.files).includes('deleted.test.ts'), false);
});

test('empty timing data falls back safely and duplicate discovery fails closed', () => {
  assert.equal(balanceFiles(['a', 'b'], {}, 2).flatMap((shard) => shard.files).length, 2);
  assert.throws(() => balanceFiles(['a', 'a'], {}, 2), /unique/);
  assert.throws(() => balanceFiles(['a'], {}, 0), /positive/);
});

test('ordinary files balance around isolated and integration work without changing coverage', () => {
  const shards = balanceFiles(['slow', 'medium', 'small'], { slow: 300, medium: 100, small: 50 }, 2, [200, 0]);
  assert.deepEqual(shards, [
    { files: ['medium', 'small'], milliseconds: 350 },
    { files: ['slow'], milliseconds: 300 },
  ]);
  assert.throws(() => balanceFiles(['a'], {}, 2, [0]), /shard count/);
  assert.throws(() => balanceFiles(['a'], {}, 2, [-1, 0]), /nonnegative/);
});

test('isolated latency and voice suites remain covered exactly once outside parallel workers', () => {
  const shards = Array.from({ length: 8 }, (_, index) => index + 1).map(position => {
    const result = spawnSync(process.execPath, ['apps/server/scripts/run-ci-shard.mjs', `${position}/8`, '--list'], {
      encoding: 'utf8', maxBuffer: 4 * 1024 * 1024,
    });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  });
  const isolated = ['src/production-corpus-width.test.ts', 'src/voice-room-runtime.test.ts',
    'src/phone-service.read-room-latency.test.ts', 'src/daemon-service.completion-latency.test.ts',
    'src/durable-live.integration.test.ts', 'src/wake-inbox.integration.test.ts'];
  isolated.forEach((file, index) => assert.deepEqual(shards[index].isolatedFiles, [file]));
  const files = shards.flatMap(shard => [...shard.files, ...shard.isolatedFiles]);
  assert.equal(new Set(files).size, files.length);
  assert.equal(files.length, shards[0].totalFiles);
  for (const shard of shards) {
    for (const file of isolated) assert.equal(shard.files.includes(file), false);
  }
});

test('PR timing suites move to the hosted gate with complete, disjoint coverage', () => {
  const shards = Array.from({ length: 8 }, (_, index) => index + 1).map(position => {
    const result = spawnSync(process.execPath, ['apps/server/scripts/run-ci-shard.mjs', `${position}/8`, '--list'], {
      encoding: 'utf8', maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, SERVER_HOSTED_TIMING: 'true', GITHUB_EVENT_NAME: 'pull_request' },
    });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  });
  const hosted = ['src/production-corpus-width.test.ts', 'src/phone-service.read-room-latency.test.ts',
    'src/daemon-service.completion-latency.test.ts'];
  for (const shard of shards) assert.deepEqual(shard.hostedFiles, hosted);
  const local = shards.flatMap(shard => [...shard.files, ...shard.isolatedFiles]);
  assert.deepEqual(shards[1].isolatedFiles, ['src/voice-room-runtime.test.ts']);
  for (const file of hosted) assert.equal(local.includes(file), false);
  assert.equal(new Set([...local, ...hosted]).size, shards[0].totalFiles);
  assert.equal(local.length + hosted.length, shards[0].totalFiles);
  const invalid = spawnSync(process.execPath, ['apps/server/scripts/run-ci-shard.mjs', '1/8', '--list'], {
    encoding: 'utf8', env: { ...process.env, SERVER_HOSTED_TIMING: 'true', GITHUB_EVENT_NAME: 'workflow_dispatch' },
  });
  assert.notEqual(invalid.status, 0, 'dispatch cannot omit its local timing coverage');
});

test('grouping files in one fork retains module and mock isolation between files', () => {
  const directory = mkdtempSync(join(tmpdir(), 'ci-fork-isolation-'));
  try {
    symlinkSync(new URL('../node_modules', import.meta.url), join(directory, 'node_modules'), 'dir');
    const pids = join(directory, 'pids');
    writeFileSync(join(directory, 'package.json'), '{"type":"module"}');
    writeFileSync(join(directory, 'state.js'), "export const state = { count: 0 }; export const value = 'original';");
    writeFileSync(join(directory, 'vitest.config.js'), 'export default { test: { isolate: true } };');
    const fixture = `
      import { appendFileSync } from 'node:fs';
      import { expect, it, vi } from 'vitest';
      import { state, value } from './state.js';
      it('starts with independent module and mock state', async () => {
        expect(state.count).toBe(0);
        expect(value).toBe('original');
        state.count++;
        vi.doMock('./state.js', () => ({ state: { count: 99 }, value: 'mocked' }));
        expect((await import('./state.js')).value).toBe('mocked');
        appendFileSync(${JSON.stringify(pids)}, process.pid + '\\n');
      });
    `;
    for (const file of ['first.test.js', 'second.test.js']) writeFileSync(join(directory, file), fixture);
    const result = spawnSync(process.execPath, [new URL('../node_modules/vitest/vitest.mjs', import.meta.url).pathname,
      'run', '--root', directory, '--config', join(directory, 'vitest.config.js'),
      '--maxWorkers=1', '--minWorkers=1', '--poolOptions.forks.singleFork', '--isolate'], {
      encoding: 'utf8', timeout: 30_000,
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const ids = readFileSync(pids, 'utf8').trim().split('\n');
    assert.equal(ids.length, 2);
    assert.equal(new Set(ids).size, 1, 'both isolated files must reuse the same process');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('server test setup lets IPC run between microtask-only tests even with fake timers', () => {
  const directory = mkdtempSync(join(tmpdir(), 'ci-event-loop-'));
  try {
    symlinkSync(new URL('../node_modules', import.meta.url), join(directory, 'node_modules'), 'dir');
    writeFileSync(join(directory, 'package.json'), '{"type":"module"}');
    const setup = new URL('../apps/server/scripts/test-event-loop.ts', import.meta.url).pathname;
    writeFileSync(join(directory, 'vitest.config.js'),
      `export default { test: { setupFiles: [${JSON.stringify(setup)}] } };`);
    writeFileSync(join(directory, 'yield.test.js'), `
      import { setImmediate, clearImmediate } from 'node:timers';
      import { afterAll, expect, it, vi } from 'vitest';
      let turns = 0, previous = -1, pending;
      const tick = () => { turns++; pending = setImmediate(tick); };
      pending = setImmediate(tick);
      afterAll(() => { clearImmediate(pending); vi.useRealTimers(); });
      for (let index = 0; index < 6; index++) it('yields after test ' + index, async () => {
        expect(turns).toBeGreaterThan(previous);
        previous = turns;
        if (index === 2) vi.useFakeTimers();
        for (let query = 0; query < 100; query++) await Promise.resolve();
      });
    `);
    const command = [new URL('../node_modules/vitest/vitest.mjs', import.meta.url).pathname,
      'run', '--root', directory, '--config', join(directory, 'vitest.config.js'),
      '--maxWorkers=1', '--minWorkers=1'];
    const result = spawnSync(process.execPath, command, { encoding: 'utf8', timeout: 30_000 });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    writeFileSync(join(directory, 'vitest.config.js'), 'export default {};');
    const unyielding = spawnSync(process.execPath, command, { encoding: 'utf8', timeout: 30_000 });
    assert.notEqual(unyielding.status, 0, 'the fixture must detect starvation without the setup');
    assert.match(unyielding.stdout + unyielding.stderr, /to be greater than/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a PR selection runs each selected file once and skips unselected integration batches', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'server-selection-')), 'selection.json');
  const wanted = ['apps/server/src/agent-access.test.ts', 'apps/server/src/phone-service.read-room-latency.test.ts',
    'apps/server/src/rooms-mcp.test.ts', 'apps/server/src/voice-room-runtime.test.ts'];
  writeFileSync(path, JSON.stringify({ mode: 'subset', reason: 'test', files: wanted }));
  const env = { ...process.env, SERVER_TEST_SELECTION: path };
  const shards = [1, 2, 3, 4].map(position => {
    const result = spawnSync(process.execPath, ['apps/server/scripts/run-ci-shard.mjs', `${position}/4`, '--list'], {
      encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, env,
    });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  });
  const files = shards.flatMap(shard => [...shard.files, ...shard.isolatedFiles]).map(file => `apps/server/${file}`).sort();
  assert.deepEqual(files, wanted);
  assert.ok(shards.every(shard => shard.selection === 'subset'));
  const integration = spawnSync(process.execPath, ['apps/server/scripts/run-integration-shard.mjs', '1/8'], { encoding: 'utf8', env });
  assert.equal(integration.status, 0, integration.stderr);
  assert.match(integration.stdout, /skipped/);
});


function coverageRunnerFixture() {
  const root = mkdtempSync(join(tmpdir(), 'coverage-runner-'));
  const server = join(root, 'apps/server');
  mkdirSync(join(server, 'scripts'), { recursive: true });
  mkdirSync(join(root, 'node_modules/vitest'), { recursive: true });
  writeFileSync(join(root, 'package.json'), '{"type":"module"}');
  for (const name of ['run-ci-shard.mjs', 'run-integration-shard.mjs', 'ci-shards.mjs', 'selected-tests.mjs', 'ci-test-timings.json']) {
    copyFileSync(new URL(`../apps/server/scripts/${name}`, import.meta.url), join(server, 'scripts', name));
  }
  const calls = join(root, 'calls.jsonl');
  writeFileSync(join(root, 'node_modules/vitest/vitest.mjs'), `
import { appendFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
const args = process.argv.slice(2);
appendFileSync(process.env.CALLS, JSON.stringify({ args, coverage: process.env.SERVER_COVERAGE_MAP_DIR }) + '\\n');
if (args[0] === 'list') {
  let result;
  if (args.some((arg, i) => arg === 'src/integration.test.ts' && args[i - 1] !== '--exclude')) {
    const names = ['monolith integration > first', 'monolith integration > second'];
    const pattern = args[args.indexOf('--testNamePattern') + 1];
    result = names.filter(name => !args.includes('--testNamePattern') || new RegExp(pattern).test(name.replace(' > ', ' '))).map(name => ({ name }));
  } else {
    const all = ['src/ordinary.test.ts', 'src/production-corpus-width.test.ts', 'src/voice-room-runtime.test.ts',
      'src/phone-service.read-room-latency.test.ts', 'src/daemon-service.completion-latency.test.ts',
      'src/durable-live.integration.test.ts', 'src/wake-inbox.integration.test.ts'];
    const excluded = args.filter((_, i) => args[i - 1] === '--exclude');
    const requested = args.filter((arg, i) => arg.endsWith('.test.ts') && args[i - 1] !== '--exclude');
    result = all.filter(file => !excluded.includes(file) && (!requested.length || requested.includes(file))).map(file => ({ file: resolve(file) }));
  }
  const json = args.find(arg => arg.startsWith('--json='));
  if (json) writeFileSync(json.slice(7), JSON.stringify(result));
  else console.log(JSON.stringify(result));
}
`);
  const env = { ...process.env, CI_TEST_WORKERS: '1', SERVER_HOSTED_TIMING: 'false', SERVER_TEST_SELECTION: '',
    SERVER_COVERAGE_MAP_DIR: join(root, 'coverage'), CALLS: calls };
  return { root, server, calls, env };
}

test('main records ordinary coverage but runs every isolated timer/socket suite uninstrumented', () => {
  const fixture = coverageRunnerFixture();
  try {
    const result = spawnSync(process.execPath, [join(fixture.server, 'scripts/run-ci-shard.mjs'), '1/1'], {
      cwd: fixture.server, env: fixture.env, encoding: 'utf8', timeout: 15_000 });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const runs = readFileSync(fixture.calls, 'utf8').trim().split('\n').map(JSON.parse).filter(call => call.args[0] === 'run');
    const ordinary = runs.find(call => call.args.includes('--exclude'));
    assert.equal(ordinary.coverage, fixture.env.SERVER_COVERAGE_MAP_DIR);
    const isolated = runs.filter(call => !call.args.includes('--exclude'));
    for (const call of isolated) assert.equal(call.coverage, '', JSON.stringify(call.args));
    assert.equal(isolated.length, 6);
    assert.ok(isolated.some(call => call.args.includes('src/wake-inbox.integration.test.ts')));
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});

test('integration discovery and execution retain warm database setup under main coverage', () => {
  const fixture = coverageRunnerFixture();
  try {
    const result = spawnSync(process.execPath, [join(fixture.server, 'scripts/run-integration-shard.mjs'), '1/1'], {
      cwd: fixture.server, env: fixture.env, encoding: 'utf8', timeout: 15_000 });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const calls = readFileSync(fixture.calls, 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(calls.length, 3, 'two exact discoveries and one execution remain mandatory');
    for (const call of calls) assert.equal(call.coverage, '');
    assert.equal(calls.at(-1).args[0], 'run');
    assert.ok(calls.at(-1).args.includes('--maxWorkers=1'));
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});
