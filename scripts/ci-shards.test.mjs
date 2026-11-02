import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, symlinkSync, rmSync } from 'node:fs';
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

test('isolated latency and voice suites remain covered exactly once outside parallel workers', () => {
  const shards = Array.from({ length: 8 }, (_, index) => index + 1).map(position => {
    const result = spawnSync(process.execPath, ['apps/server/scripts/run-ci-shard.mjs', `${position}/8`, '--list'], {
      encoding: 'utf8', maxBuffer: 4 * 1024 * 1024,
    });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  });
  const isolated = ['src/production-corpus-width.test.ts', 'src/voice-room-runtime.test.ts',
    'src/phone-service.read-room-latency.test.ts'];
  isolated.forEach((file, index) => assert.deepEqual(shards[index].isolatedFiles, [file]));
  const files = shards.flatMap(shard => [...shard.files, ...shard.isolatedFiles]);
  assert.equal(new Set(files).size, files.length);
  assert.equal(files.length, shards[0].totalFiles);
  for (const shard of shards) {
    for (const file of isolated) assert.equal(shard.files.includes(file), false);
  }
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
