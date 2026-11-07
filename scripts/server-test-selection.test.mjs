import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  buildMap, fullSuiteReason, MAX_MAP_AGE_DAYS, MAX_MAP_DISTANCE, selectTests,
  staleMapReason, unscannedSourceReaders,
} from '../apps/server/scripts/test-selection.mjs';

const tests = ['apps/server/src/a.test.ts', 'apps/server/src/b.test.ts'];
const records = [{ test: tests[0], sources: { 'apps/server/src/a.ts': ['read'] }, reads: ['config.json'] },
  { test: tests[1], sources: { 'apps/server/src/a.ts': ['write'] }, reads: ['apps/server/src/source.ts'] }];
const now = Date.parse('2026-11-06T12:00:00Z');
const map = () => buildMap(records, { commit: 'released', createdAt: new Date(now).toISOString(), files: ['uncovered.json'] });

test('release records merge executions without losing function or file readers', () => {
  const built = buildMap([...records, { ...records[0], sources: { 'apps/server/src/extra.ts': ['extra'] } }],
    { provenance: { kind: 'release', runId: '5', commit: 'released' } });
  assert.deepEqual(built.tests, tests);
  assert.deepEqual(built.sources['apps/server/src/a.ts'].functions, { read: [0], write: [1] });
  assert.deepEqual(built.sources['apps/server/src/extra.ts'].tests, [0]);
  assert.deepEqual(built.provenance, { kind: 'release', runId: '5', commit: 'released' });
  assert.deepEqual(unscannedSourceReaders(built, []), [tests[1]]);
  assert.deepEqual(unscannedSourceReaders(built, [tests[1]]), []);
});

test('PR selection includes mapped functions, source scanners, new tests and file reads', () => {
  const newTest = 'apps/server/src/new.test.ts';
  const select = changes => selectTests({ map: map(), changes, alwaysRun: [], testFiles: [...tests, newTest] });
  assert.deepEqual(select([{ path: 'apps/server/src/a.ts', status: 'M', names: ['read'] }]).files, [...tests, newTest]);
  assert.deepEqual(select([{ path: 'config.json', status: 'M', fileLevel: true, names: [] }]).files, [...tests, newTest]);
  assert.deepEqual(select([{ path: 'uncovered.json', status: 'M', names: [] }]).files, [tests[1], newTest]);
  assert.equal(select([{ path: 'unknown.json', status: 'A', names: [] }]).mode, 'full');
  assert.equal(selectTests({ map: undefined }).mode, 'full');
  assert.ok(fullSuiteReason({ path: '.github/workflows/unified-release.yml' }));
});

test('maps from nonancestor, stale or distant release commits require full suites', () => {
  const options = { now, isAncestor: () => true, distance: () => 1 };
  assert.equal(staleMapReason(map(), options), undefined);
  assert.match(staleMapReason(map(), { ...options, isAncestor: () => false }), /not in this branch/);
  assert.match(staleMapReason(map(), { ...options, now: now + (MAX_MAP_AGE_DAYS + 1) * 86_400_000 }), /days old/);
  assert.match(staleMapReason(map(), { ...options, distance: () => MAX_MAP_DISTANCE + 1 }), /commits behind/);
  assert.match(staleMapReason({ ...map(), version: 0 }, options), /version/);
});

test('the map CLI stamps the release SHA and rejects foreign-commit provenance', () => {
  const directory = mkdtempSync(join(tmpdir(), 'release-map-'));
  const output = join(directory, 'map.json');
  const cli = join(directory, 'apps/server/scripts/test-selection.mjs');
  const nodePath = join(process.cwd(), 'node_modules');
  const git = args => execFileSync('git', args, { cwd: directory, encoding: 'utf8' }).trim();
  const run = args => execFileSync(process.execPath, args,
    { cwd: directory, env: { ...process.env, NODE_PATH: nodePath }, stdio: 'pipe' });
  try {
    mkdirSync(join(directory, 'apps/server/scripts'), { recursive: true });
    copyFileSync('apps/server/scripts/test-selection.mjs', cli);
    git(['init', '--quiet']);
    git(['config', 'user.name', 'Fixture']);
    git(['config', 'user.email', 'fixture@example.invalid']);
    git(['-c', 'commit.gpgsign=false', 'commit', '--quiet', '--allow-empty', '-m', 'previous release']);
    const previous = git(['rev-parse', 'HEAD']);
    git(['-c', 'commit.gpgsign=false', 'commit', '--quiet', '--allow-empty', '-m', 'current release']);
    writeFileSync(join(directory, 'record.json'), JSON.stringify(records[0]));
    const sha = git(['rev-parse', 'HEAD']);
    const args = [cli, 'build-map', '--records', directory,
      '--commit', sha, '--release-run', '123', '--out', output];
    run(args);
    const built = JSON.parse(readFileSync(output, 'utf8'));
    assert.equal(built.commit, sha);
    assert.deepEqual(built.provenance, { kind: 'release', runId: '123', commit: sha });
    rmSync(output);
    args[args.indexOf('--commit') + 1] = previous;
    assert.throws(() => run(args), /release coverage must describe the checked-out release SHA/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('PR selection includes changes merged since the release map, not just the PR diff', () => {
  const directory = mkdtempSync(join(tmpdir(), 'release-selection-'));
  const git = args => execFileSync('git', args, { cwd: directory, encoding: 'utf8' }).trim();
  const nodePath = join(process.cwd(), 'node_modules');
  try {
    mkdirSync(join(directory, 'apps/server/scripts'), { recursive: true });
    mkdirSync(join(directory, 'apps/server/src'));
    copyFileSync('apps/server/scripts/test-selection.mjs', join(directory, 'apps/server/scripts/test-selection.mjs'));
    const fixtureRecords = [];
    for (const name of ['a', 'b', 'c']) {
      writeFileSync(join(directory, `apps/server/src/${name}.ts`), `export function ${name}() { return 1; }\n`);
      writeFileSync(join(directory, `apps/server/src/${name}.test.ts`), '// fixture test\n');
      fixtureRecords.push({ test: `apps/server/src/${name}.test.ts`, sources: { [`apps/server/src/${name}.ts`]: [name] }, reads: [] });
    }
    git(['init', '--quiet']); git(['config', 'user.name', 'Fixture']); git(['config', 'user.email', 'fixture@example.invalid']);
    git(['add', '.']); git(['commit', '--quiet', '-m', 'released baseline']);
    const released = git(['rev-parse', 'HEAD']);
    const releaseMap = buildMap(fixtureRecords, { commit: released, createdAt: new Date().toISOString(), files: git(['ls-files']).split('\n') });
    writeFileSync(join(directory, 'map.json'), JSON.stringify(releaseMap));
    for (const name of ['a', 'b']) {
      writeFileSync(join(directory, `apps/server/src/${name}.ts`), `export function ${name}() { return 2; }\n`);
      git(['add', `apps/server/src/${name}.ts`]);
      git(['commit', '--quiet', '-m', name === 'a' ? 'merged since release' : 'PR change']);
    }
    execFileSync(process.execPath, ['apps/server/scripts/test-selection.mjs', 'select', '--map', 'map.json', '--out', 'selection.json'],
      { cwd: directory, env: { ...process.env, NODE_PATH: nodePath }, stdio: 'pipe' });
    const selection = JSON.parse(readFileSync(join(directory, 'selection.json'), 'utf8'));
    assert.equal(selection.mode, 'subset');
    assert.equal(selection.mapCommit, released);
    assert.deepEqual(selection.files, ['apps/server/src/a.test.ts', 'apps/server/src/b.test.ts']);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
