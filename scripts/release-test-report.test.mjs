import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildMap } from '../apps/server/scripts/test-selection.mjs';
import { coveredFiles, failingTests, releaseTestReport } from './release-test-report.mjs';

const testFile = 'apps/server/src/identity-live.e2e.test.ts';
const coverage = () => buildMap([{ test: testFile,
  sources: { 'apps/server/src/identity.ts': ['save'] }, reads: ['fixtures.json'] }]);

test('extract failing file paths and test titles from completed Vitest and TAP logs', () => {
  const result = failingTests('\u001b[31m2026-11-06 FAIL  src/identity-live.e2e.test.ts > saves identity\u001b[0m\n× saves identity\nnot ok 3 - identity\nPASS src/passing.test.ts', 'release_checks / SERVER SUITE SHARD 1');
  assert.deepEqual(result.files, [testFile]);
  assert.equal(result.lines.length, 3);
  assert.deepEqual(failingTests('FAIL tests/seams/server-db.test.ts > hands off', 'SERVER CLAIM LATENCY').files, ['tests/seams/server-db.test.ts']);
  assert.deepEqual(failingTests('FAIL sources/x.test.tsx > render', 'MOBILE SUITE').files, ['apps/mobile/sources/x.test.tsx']);
  assert.deepEqual(failingTests("not ok 1 - guards selection\n  location: '/repo/scripts/selection.test.mjs:12:3'", 'ACTIONLINT').files, ['scripts/selection.test.mjs']);
  assert.deepEqual(failingTests('FAIL src/codec.test.ts > decode', 'SHARED PACKAGE TESTS', ['packages/net/src/codec.test.ts']).files, ['packages/net/src/codec.test.ts']);
  assert.deepEqual(coveredFiles(coverage(), testFile), [testFile, 'apps/server/src/identity.ts', 'fixtures.json']);
});

test('attribute failing tests only to commits since the previous release touching their coverage', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'release-culprits-'));
  const git = args => execFileSync('git', args, { cwd: directory, encoding: 'utf8' }).trim();
  try {
    git(['init', '--quiet']);
    git(['config', 'user.name', 'Fixture']); git(['config', 'user.email', 'fixture@example.invalid']);
    writeFileSync(join(directory, 'fixtures.json'), '{}');
    git(['add', '.']); git(['commit', '--quiet', '-m', 'previous release']);
    const previous = git(['rev-parse', 'HEAD']);
    writeFileSync(join(directory, 'unrelated.txt'), 'unrelated');
    git(['add', '.']); git(['commit', '--quiet', '-m', 'unrelated change']);
    writeFileSync(join(directory, 'fixtures.json'), '{"broken":true}');
    git(['add', '.']); git(['commit', '--quiet', '-m', 'culprit fixture change']);
    const sha = git(['rev-parse', 'HEAD']);
    const calls = [];
    const report = await releaseTestReport({ previous, sha, map: coverage(),
      jobs: [{ id: 1, name: 'SERVER SUITE SHARD 1', conclusion: 'failure' }, { id: 2, name: 'passing', conclusion: 'success' }],
      log: id => { assert.equal(id, 1); return 'FAIL src/identity-live.e2e.test.ts > saves identity'; },
      commits: (base, head, files) => {
        calls.push({ base, head, files });
        return git(['log', '--format=%h %s', `${base}..${head}`, '--', ...files]).split('\n').filter(Boolean);
      },
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].base, previous); assert.equal(calls[0].head, sha);
    assert.match(report, /saves identity/); assert.match(report, /culprit fixture change/);
    assert.doesNotMatch(report, /unrelated change|previous release\n/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('missing records, first release, setup failure and unavailable logs remain explicit', async () => {
  const base = { map: buildMap([]), previous: '', sha: 'release', commits: () => { throw new Error('must not attribute without baseline'); } };
  const report = await releaseTestReport({ ...base, jobs: [{ id: 1, name: 'MOBILE SUITE', conclusion: 'failure' }], log: () => 'FAIL sources/x.test.ts > render' });
  assert.match(report, /No runtime coverage record/); assert.match(report, /No previous release SHA/);
  const unavailable = await releaseTestReport({ ...base, jobs: [{ id: 1, name: 'TYPECHECK', conclusion: 'failure' }], log: () => { throw new Error('logs unavailable'); } });
  assert.match(unavailable, /logs unavailable/);
  const setup = await releaseTestReport({ ...base, jobs: [], log: () => '' });
  assert.match(setup, /coverage-map validation/);
});
