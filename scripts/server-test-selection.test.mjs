import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  buildMap, changedFunctions, describeChange, exportUsers, MAP_VERSION, parseHunks, readsSourceText, scriptsOnlyChange, selectTests,
  sourcePath, sourceTextTests, staleMapReason, unscannedSourceReaders,
} from '../apps/server/scripts/test-selection.mjs';

const ts = createRequire(import.meta.url)('typescript');
const script = new URL('../apps/server/scripts/test-selection.mjs', import.meta.url);

const guard = 'apps/server/src/system-messages-lock.test.ts';
const records = [
  { test: 'apps/server/src/a.test.ts', sources: { 'apps/server/src/rooms.ts': ['', 'createRoom', 'listRooms'] }, reads: [] },
  { test: 'apps/server/src/b.test.ts', sources: { 'apps/server/src/rooms.ts': ['', 'listRooms'], 'apps/server/src/wallet.ts': ['pay'] }, reads: ['docs/workflows/triage.json'] },
  { test: 'apps/server/src/c.test.ts', sources: { 'packages/nostr/dist/relay.js': ['connect'] }, reads: [] },
  { test: 'apps/server/src/d.test.ts', sources: { 'apps/server/src/rooms.ts': [] }, reads: [] },
  { test: guard, sources: {}, reads: ['apps/server/src/rooms.ts', 'apps/server/src/wallet.ts'] },
];
const testFiles = records.map((record) => record.test).sort();
// Tracked at the map's commit, though no test ran or read the last four.
const files = ['apps/server/src/rooms.ts', 'apps/server/src/wallet.ts', 'docs/workflows/triage.json',
  'apps/server/src/quiet.ts', 'knip.jsonc', '.github/workflows/desktop.yml', 'package.json'];
const map = buildMap(records, { commit: 'abc', createdAt: '2026-10-31T00:00:00Z', files,
  exists: (path) => path === 'packages/nostr/src/relay.ts' });
const select = (changes, alwaysRun = [guard], tests = testFiles) => selectTests({ map, changes, alwaysRun, testFiles: tests });
const modified = (path, names, fileLevel = false) => ({ path, status: 'M', names, fileLevel });

test('a function change runs only the tests that ran that function, plus source-text tests', () => {
  const selection = select([modified('apps/server/src/rooms.ts', ['createRoom'])]);
  assert.equal(selection.mode, 'subset');
  assert.deepEqual(selection.files, ['apps/server/src/a.test.ts', guard]);
  assert.deepEqual(select([modified('apps/server/src/rooms.ts', ['listRooms'])]).files,
    ['apps/server/src/a.test.ts', 'apps/server/src/b.test.ts', guard]);
});

test('exported or load-time changes, deletions and unknown function names use every test that loaded the file', () => {
  const loaders = ['apps/server/src/a.test.ts', 'apps/server/src/b.test.ts', 'apps/server/src/d.test.ts', guard];
  assert.deepEqual(select([modified('apps/server/src/rooms.ts', [], true)]).files, loaders);
  assert.deepEqual(select([{ path: 'apps/server/src/rooms.ts', status: 'D', names: [], fileLevel: true }]).files, loaders);
  assert.deepEqual(select([modified('apps/server/src/rooms.ts', ['get roomCount'])]).files, loaders);
});

test('a private module-level change runs every test that ran code in the file, not ones that only imported it', () => {
  const change = { path: 'apps/server/src/rooms.ts', status: 'M', names: [], fileLevel: false, moduleLevel: true };
  assert.deepEqual(select([change]).files, ['apps/server/src/a.test.ts', 'apps/server/src/b.test.ts', guard]);
});

test('test files main never ran have no coverage, so they always run', () => {
  const selection = select([modified('apps/server/src/rooms.ts', ['createRoom'])], [guard], [...testFiles, 'apps/server/src/new.test.ts'].sort());
  assert.deepEqual(selection.files, ['apps/server/src/a.test.ts', 'apps/server/src/new.test.ts', guard]);
  assert.match(selection.reasons['apps/server/src/new.test.ts'], /no coverage recorded on main/);
});

test('type-only edits and phone files outside the map run only the always-run set', () => {
  assert.deepEqual(select([modified('apps/server/src/rooms.ts', [])]).files, [guard]);
  assert.deepEqual(select([{ path: 'apps/mobile/sources/app.tsx', status: 'M', names: [], fileLevel: true }]).files, [guard]);
});

test('changed and new test files run themselves; deleted ones do not', () => {
  assert.deepEqual(select([{ path: 'apps/server/src/new.test.ts', status: 'A', names: [], fileLevel: true }], [guard],
    [...testFiles, 'apps/server/src/new.test.ts'].sort()).files, ['apps/server/src/new.test.ts', guard]);
  assert.deepEqual(select([{ path: 'apps/server/src/gone.test.ts', status: 'D', names: [], fileLevel: true }]).files, [guard]);
});

test('files a test read on main select that test; built package code maps back to its source', () => {
  assert.deepEqual(select([modified('docs/workflows/triage.json', [], true)]).files, ['apps/server/src/b.test.ts', guard]);
  assert.deepEqual(select([modified('packages/nostr/src/relay.ts', ['connect'])]).files, ['apps/server/src/c.test.ts', guard]);
  assert.equal(sourcePath('packages/nostr/dist/relay.js', () => false), 'packages/nostr/dist/relay.js');
});

test('the full suite runs for contract, CI, harness and dependency changes', () => {
  for (const path of ['packages/api-contract/src/phone.ts', '.github/workflows/checks.yml', '.github/actions/ci-workspace/action.yml',
    'apps/server/scripts/run-ci-shard.mjs', 'apps/server/vitest.config.ts', 'apps/server/src/test-support.ts',
    'apps/server/package.json', 'package-lock.json', 'package.json', 'tsconfig.base.json']) {
    const selection = select([modified('apps/server/src/rooms.ts', ['createRoom']), modified(path, [], true)]);
    assert.equal(selection.mode, 'full', path);
    assert.match(selection.reason, /changes how every server test runs/);
  }
});

test('workflows that do not run the server suite and npm scripts it never runs do not run everything', () => {
  assert.deepEqual(select([modified('.github/workflows/desktop.yml', [], true)]).files, [guard]);
  assert.deepEqual(select([{ ...modified('package.json', [], true), scriptsOnly: true }]).files, [guard]);
  const manifest = (scripts, extra = {}) => JSON.stringify({ name: 'buzzy', scripts, ...extra });
  assert.equal(scriptsOnlyChange(manifest({ build: 'turbo run build' }), manifest({ build: 'turbo run build', prove: 'node x.mjs' })), true);
  assert.equal(scriptsOnlyChange(manifest({ build: 'turbo run build' }), manifest({ build: 'turbo run build --force' })), false);
  assert.equal(scriptsOnlyChange(manifest({}), manifest({}, { overrides: { pg: '8' } })), false);
  assert.equal(scriptsOnlyChange('{', manifest({})), false);
});

test('a tracked file no test ran or read on main selects nothing beyond the always-run set', () => {
  for (const path of ['apps/server/src/quiet.ts', 'knip.jsonc']) assert.deepEqual(select([modified(path, [], true)]).files, [guard], path);
});

test('the full suite runs when a changed file is not in the coverage map', () => {
  for (const path of ['apps/server/src/never-loaded.ts', 'apps/server/src/fixtures/new-data.json', 'apps/auth/src/session.ts', 'infra/deploy.toml']) {
    const selection = select([modified(path, [], true)]);
    assert.equal(selection.mode, 'full', path);
    assert.match(selection.reason, /not in the coverage map/);
  }
  for (const path of ['apps/server/src/fixtures/new-data.json', 'apps/server/src/brand-new.ts', 'apps/server/src/routes/new-route.tsx']) {
    const selection = select([modified('apps/server/src/rooms.ts', ['createRoom']), { path, status: 'A', names: [], fileLevel: true }]);
    assert.equal(selection.mode, 'full', path);
    assert.match(selection.reason, /not in the coverage map/);
  }
});

test('the full suite runs when the coverage map is missing, from another version, unrelated, old or far behind', () => {
  const fresh = { version: MAP_VERSION, commit: 'abc', createdAt: '2026-10-30T00:00:00Z' };
  const now = Date.parse('2026-10-31T00:00:00Z');
  const ok = { now, isAncestor: () => true, distance: () => 3 };
  assert.equal(staleMapReason(fresh, ok), undefined);
  assert.match(staleMapReason(undefined, ok), /no coverage map/);
  assert.match(staleMapReason({ ...fresh, version: MAP_VERSION + 1 }, ok), /version/);
  assert.match(staleMapReason(fresh, { ...ok, isAncestor: () => false }), /not in this branch's history/);
  assert.match(staleMapReason({ ...fresh, createdAt: '2026-10-01T00:00:00Z' }, ok), /days old/);
  assert.match(staleMapReason(fresh, { ...ok, distance: () => 5000 }), /commits behind/);
  assert.equal(selectTests({ map: undefined, changes: [], alwaysRun: [], testFiles }).mode, 'full');
});

test('changed functions come from both sides of the diff and use the names V8 reports', () => {
  const before = [
    'export interface Room { id: string }',
    'const LIMIT = 10;',
    'export function createRoom() {',
    '  return [1].map((x) => x + 1);',
    '}',
    'export class Store {',
    '  constructor() { this.n = 1; }',
    '  get size() { return 1; }',
    '  load = () => 2;',
    '}',
    'export const listRooms = async () => {',
    '  // comment',
    '  return LIMIT;',
    '};',
    'export function removed() { return 0; }',
  ].join('\n');
  const names = (lines) => changedFunctions(ts, 'rooms.ts', before, lines);
  assert.deepEqual(names([4]), { fileLevel: false, moduleLevel: false, names: ['createRoom'] });
  assert.deepEqual(names([7, 8, 9]), { fileLevel: false, moduleLevel: false, names: ['Store', 'get size', 'load'] });
  assert.deepEqual(names([13]), { fileLevel: false, moduleLevel: false, names: ['listRooms'] });
  assert.deepEqual(names([1, 12]), { fileLevel: false, moduleLevel: false, names: [] });
  // A private constant counts as a change to the functions that use it; an
  // exported declaration is also a change to its importers.
  assert.deepEqual(names([2]), { fileLevel: false, moduleLevel: false, names: ['listRooms'] });
  assert.deepEqual(names([6]), { fileLevel: false, moduleLevel: false, names: [], exports: ['Store'] });
  const after = before.replace('\nexport function removed() { return 0; }', '').replace('x + 1', 'x + 2');
  const diff = '@@ -4 +4 @@\n-  return [1].map((x) => x + 1);\n+  return [1].map((x) => x + 2);\n@@ -15 +14,0 @@\n-export function removed() { return 0; }';
  assert.deepEqual(parseHunks(diff), [{ oldStart: 4, oldCount: 1, newStart: 4, newCount: 1 }, { oldStart: 15, oldCount: 1, newStart: 14, newCount: 0 }]);
  assert.deepEqual(describeChange(ts, { path: 'apps/server/src/rooms.ts', status: 'M', before, after, hunks: parseHunks(diff) }),
    { path: 'apps/server/src/rooms.ts', status: 'M', fileLevel: false, moduleLevel: false, names: ['createRoom', 'removed'] });
});

test('a changed import or private constant selects the functions that use it, through other constants', () => {
  const text = [
    "import { format } from './format.js';",
    "import { LIMIT as RAW } from './limits.js';",
    'const LIMIT = RAW * 2;',
    'const LABELS = { limit: LIMIT };',
    'function label() { return LABELS.limit; }',
    'export function show(value: number) { return format(value); }',
    "register('ping', () => LIMIT);",
    'const unused = 3;',
  ].join('\n');
  const names = (lines) => changedFunctions(ts, 'rooms.ts', text, lines);
  assert.deepEqual(names([1]), { fileLevel: false, moduleLevel: false, names: ['show'] });
  // RAW feeds LIMIT, which the label() constant and a top-level callback use.
  assert.deepEqual(names([2]), { fileLevel: false, moduleLevel: false, names: ['(anonymous)', 'label'] });
  const onImport = changedFunctions(ts, 'rooms.ts', 'const LIMIT = 2;\nregister(LIMIT);', [1]);
  assert.deepEqual(onImport, { fileLevel: true, moduleLevel: false, names: [] });
  assert.deepEqual(names([4]), { fileLevel: false, moduleLevel: false, names: ['label'] });
  assert.deepEqual(names([8]), { fileLevel: false, moduleLevel: false, names: [] });
  const callback = changedFunctions(ts, 'rooms.ts', "const LIMIT = 2;\nrouter.get('/', () => LIMIT);\nexport const ok = 1;", [1]);
  assert.deepEqual(callback, { fileLevel: false, moduleLevel: false, names: ['(anonymous)'] });
});

test('new declarations select loading tests; code added inside an old function still selects it', () => {
  const before = 'export function show() {\n  return 1;\n}\n';
  const after = 'export const STEP = 2;\nexport function added() { return STEP; }\nexport function show() {\n  const twice = () => STEP * 2;\n  return twice();\n}\n';
  const diff = '@@ -0,0 +1,2 @@\n+export const STEP = 2;\n+export function added() { return STEP; }\n@@ -2 +4,2 @@\n-  return 1;\n+  const twice = () => STEP * 2;\n+  return twice();';
  assert.deepEqual(describeChange(ts, { path: 'apps/server/src/rooms.ts', status: 'M', before, after, hunks: parseHunks(diff) }),
    { path: 'apps/server/src/rooms.ts', status: 'M', fileLevel: true, moduleLevel: false, names: ['show'] });
});

test('new module initializers select the importing test that catches their failure (INITIALIZER-1)', () => {
  const path = 'apps/server/src/rooms.ts';
  const before = 'export function show() { return 1; }\n';
  const loader = 'apps/server/src/rooms.test.ts';
  const coverage = buildMap([{ test: loader, sources: { [path]: ['show'] }, reads: [] }],
    { commit: 'abc', files: [path] });
  const directory = mkdtempSync(join(tmpdir(), 'selection-initializer-'));
  const module = join(directory, 'rooms.mjs');
  const importingTest = join(directory, 'rooms.test.mjs');
  writeFileSync(importingTest, "import assert from 'node:assert/strict';\nimport { show } from './rooms.mjs';\nassert.equal(show(), 1);\n");
  writeFileSync(module, before);
  assert.equal(spawnSync(process.execPath, [importingTest]).status, 0);
  for (const addition of ['const registered = JSON.parse("invalid");',
    'class Registered { static value = JSON.parse("invalid"); }']) {
    const after = before + addition + '\n';
    const change = describeChange(ts, { path, status: 'M', before, after, hunks: parseHunks('@@ -1,0 +2 @@') });
    const selection = selectTests({ map: coverage, changes: [change], alwaysRun: [], testFiles: [loader] });
    assert.deepEqual(selection.files, [loader], addition);
    writeFileSync(module, after);
    const result = spawnSync(process.execPath, [importingTest], { encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, /SyntaxError/);
  }
  const inert = describeChange(ts, { path, status: 'M', before,
    after: before + 'export function added() { return JSON.parse("invalid"); }\n',
    hunks: parseHunks('@@ -1,0 +2 @@') });
  assert.deepEqual(selectTests({ map: coverage, changes: [inert], alwaysRun: [], testFiles: [loader] }).files, []);
});

test('a changed export selects the importer functions that use it, and gives up on untraceable importers', () => {
  const files = {
    'apps/server/src/schema.ts': 'export const SCHEMA = 1;',
    'apps/server/src/database.ts': "import { SCHEMA as S } from './schema.js';\nexport async function migrate() { return S; }\nexport function other() {}",
    'apps/server/src/schema.test.ts': "import { SCHEMA } from './schema.js';\nit('x', () => SCHEMA);",
    'apps/server/src/unrelated.ts': 'const SCHEMA = 2;',
  };
  const read = (file) => files[file];
  const list = () => Object.keys(files);
  assert.deepEqual(exportUsers(ts, { path: 'apps/server/src/schema.ts', names: ['SCHEMA'], read, list }), [
    { path: 'apps/server/src/database.ts', names: ['migrate'] },
    { path: 'apps/server/src/schema.test.ts', test: true },
  ]);
  files['apps/server/src/mocked.test.ts'] = "import { SCHEMA } from './schema.js';\nvi.mock('./schema.js');";
  assert.equal(exportUsers(ts, { path: 'apps/server/src/schema.ts', names: ['SCHEMA'], read, list }), undefined);
  delete files['apps/server/src/mocked.test.ts'];
  files['apps/server/src/index.ts'] = "export { SCHEMA } from './schema.js';";
  assert.equal(exportUsers(ts, { path: 'apps/server/src/schema.ts', names: ['SCHEMA'], read, list }), undefined);
  assert.equal(exportUsers(ts, { path: 'packages/nostr/src/relay.ts', names: ['SCHEMA'], read, list }), undefined);

  const change = { path: 'apps/server/src/wallet.ts', status: 'M', fileLevel: false, names: [], exports: ['SCHEMA'],
    exportUsers: [{ path: 'apps/server/src/rooms.ts', names: ['listRooms'] }] };
  assert.deepEqual(select([change]).files, ['apps/server/src/a.test.ts', 'apps/server/src/b.test.ts', guard]);
  assert.deepEqual(select([{ ...change, path: 'apps/server/src/rooms.ts', exportUsers: undefined }]).files,
    ['apps/server/src/a.test.ts', 'apps/server/src/b.test.ts', 'apps/server/src/d.test.ts', guard]);
});

test('the source-text scan finds guards that read code and ignores tests that read data', () => {
  const reads = (text) => readsSourceText(ts, 'x.test.ts', text);
  assert.equal(reads("import { readFileSync } from 'node:fs';\nreadFileSync(new URL('./index.ts', import.meta.url), 'utf8');"), true);
  assert.equal(reads("import { readdirSync, readFileSync } from 'node:fs';\nreaddirSync(dir).filter((f) => f.endsWith('.ts')).map((f) => readFileSync(f));"), true);
  assert.equal(reads("import { readdirSync } from 'node:fs';\nreaddirSync(dir).filter((f) => /\\.[cm]?[jt]sx?$/.test(f));"), true);
  assert.equal(reads("import ts from 'typescript';\nimport { readFileSync } from 'node:fs';\nreadFileSync(lockPath, 'utf8');"), true);
  assert.equal(reads("import { readFile } from 'node:fs/promises';\nawait readFile(new URL('./fixture.json', import.meta.url));"), false);
  assert.equal(reads("import { thing } from './thing.js';\nvi.mock('./other.js');\nconst row = { file: 'apps/mobile/x.tsx' };"), false);
  assert.equal(reads("import { readFileSync } from 'node:fs';\nimport { x } from './x.ts';\nreadFileSync('data.txt');"), false);
});

test('the System guard and every current source scanner are in the always-run set', () => {
  const alwaysRun = sourceTextTests(ts);
  for (const file of [guard, 'apps/server/src/system-line.contract.test.ts', 'apps/server/src/system-dm-sites.test.ts',
    'apps/server/src/corner-state-lock.test.ts', 'apps/server/src/workspace-role-authority.test.ts']) {
    assert.ok(alwaysRun.includes(file), `${file} reads source but is not always run`);
  }
  assert.ok(!alwaysRun.includes('apps/server/src/integration.test.ts'));
});

test('a test seen reading source on main but missed by the scan fails the map check', () => {
  const directory = mkdtempSync(join(tmpdir(), 'coverage-map-'));
  const missed = buildMap([{ test: 'apps/server/src/sneaky.test.ts', sources: {}, reads: ['apps/server/src/index.ts'] }], { commit: 'abc', createdAt: '2026-10-31T00:00:00Z' });
  assert.deepEqual(unscannedSourceReaders(missed, []), ['apps/server/src/sneaky.test.ts']);
  writeFileSync(join(directory, 'map.json'), JSON.stringify(missed));
  const result = spawnSync(process.execPath, [script.pathname, 'check-map', join(directory, 'map.json')], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /sneaky\.test\.ts/);
  const clean = buildMap([{ test: guard, sources: {}, reads: ['apps/server/src/index.ts'] }], { commit: 'abc', createdAt: '2026-10-31T00:00:00Z' });
  writeFileSync(join(directory, 'clean.json'), JSON.stringify(clean));
  assert.equal(spawnSync(process.execPath, [script.pathname, 'check-map', join(directory, 'clean.json')]).status, 0);
});

test('replaying fifty past PRs selects every test file that really failed on them', () => {
  const replay = JSON.parse(readFileSync(new URL('../apps/server/scripts/test-selection-replay.json', import.meta.url), 'utf8'));
  assert.equal(replay.prs.length, 50);
  const misses = [];
  for (const pr of replay.prs) {
    const selection = selectTests({ map: replay.map, changes: pr.changes, alwaysRun: replay.alwaysRun, testFiles: replay.testFiles });
    const selected = selection.mode === 'full' ? replay.testFiles : selection.files;
    for (const file of pr.failed) if (!selected.includes(file)) misses.push(`#${pr.number} ${file}`);
  }
  assert.deepEqual(misses, []);
  assert.ok(replay.prs.filter((pr) => pr.failed.includes(guard)).length >= 7, 'the seven System guard failures stay in the replay');
});
