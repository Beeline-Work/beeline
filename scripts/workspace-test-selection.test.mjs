import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { selectWorkspaceTests } from './workspace-test-selection.mjs';

function fixture(entries) {
  const root = mkdtempSync(join(tmpdir(), 'workspace-selection-'));
  for (const [file, text] of Object.entries(entries)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), text);
  }
  const testFiles = Object.fromEntries(['server', 'body', 'mobile'].map(group => [group,
    Object.keys(entries).filter(file => file.startsWith(`apps/${group}/`) && /\.test\.tsx?$/.test(file))]));
  const select = (paths, extra = {}) => selectWorkspaceTests({ root, trackedFiles: Object.keys(entries), testFiles,
    changes: paths.map(path => ({ path, status: 'M' })), ...extra });
  return { select, clean: () => rmSync(root, { recursive: true, force: true }) };
}

const inputs = {
  'apps/server/src/reader.ts': 'export const value = 1;',
  'apps/server/src/unrelated.ts': 'export const other = 2;',
  'apps/server/src/reader.test.ts': "import { value } from './reader.js';",
  'apps/server/src/unrelated.test.ts': "import { other } from './unrelated.js';",
  'apps/body/src/bridge.ts': "export { value } from '../../server/src/reader.js';",
  'apps/body/src/bridge.test.ts': "import './bridge.js';",
  'apps/body/src/unrelated.test.ts': 'export {};',
  'apps/mobile/sources/Screen.tsx': 'export const Screen = 1;',
  'apps/mobile/sources/screen.browser.test.ts': "const virtualEntry = `import { Screen } from '@/Screen';`;",
  'apps/mobile/sources/server.test.ts': "import '../../server/src/reader';",
  'apps/mobile/sources/unrelated.test.ts': 'export {};',
};

test('a server edit selects actual cross-workspace users, not every client test', () => {
  const { select, clean } = fixture(inputs);
  try {
    const result = select(['apps/server/src/reader.ts']);
    assert.equal(result.mode, 'subset');
    assert.deepEqual(result.groups.server, ['apps/server/src/reader.test.ts']);
    assert.deepEqual(result.groups.body, ['apps/body/src/bridge.test.ts']);
    assert.deepEqual(result.groups.mobile, ['apps/mobile/sources/server.test.ts']);
  } finally { clean(); }
});

test('virtual browser entry imports and re-exports participate in reverse dependencies', () => {
  const { select, clean } = fixture(inputs);
  try {
    const result = select(['apps/mobile/sources/Screen.tsx']);
    assert.deepEqual(result.groups.mobile, ['apps/mobile/sources/screen.browser.test.ts']);
    assert.deepEqual(result.groups.body, []);
    assert.deepEqual(result.groups.server, []);
  } finally { clean(); }
});

test('opaque loaders, interpolated virtual imports and indirect source readers cannot disappear', () => {
  const entries = { ...inputs,
    'apps/mobile/sources/loader.ts': 'export const load = name => import(name);',
    'apps/mobile/sources/loader.test.ts': "import './loader';",
    'apps/mobile/sources/opaque.browser.test.ts': 'const entry = `import foo from ${target};`;',
    'apps/body/src/scan.ts': "import {readFileSync} from 'node:fs'; export const text=readFileSync('src/reader.ts','utf8');",
    'apps/body/src/scan.test.ts': "import './scan';",
  };
  const { select, clean } = fixture(entries);
  try {
    const result = select(['apps/server/src/unrelated.ts']);
    assert.ok(result.groups.mobile.includes('apps/mobile/sources/loader.test.ts'));
    assert.ok(result.groups.mobile.includes('apps/mobile/sources/opaque.browser.test.ts'));
    assert.ok(result.groups.body.includes('apps/body/src/scan.test.ts'));
  } finally { clean(); }
});

test('configured required verdict tests survive an otherwise unrelated mobile selection', () => {
  const { select, clean } = fixture(inputs);
  try {
    assert.ok(select(['apps/mobile/sources/Screen.tsx'], { requiredMobile: ['apps/mobile/sources/unrelated.test.ts'] })
      .groups.mobile.includes('apps/mobile/sources/unrelated.test.ts'));
  } finally { clean(); }
});

test('regular-expression exec is ordinary code; imported process execution stays conservative', () => {
  const { select, clean } = fixture({ ...inputs,
    'apps/mobile/sources/regex.ts': "export const parse = text => /x/.exec(text);",
    'apps/mobile/sources/regex.test.ts': "import './regex';",
    'apps/body/src/process.ts': "import {execFile as run} from 'node:child_process'; export {run};",
    'apps/body/src/process.test.ts': "import './process';",
  });
  try {
    const result = select(['apps/server/src/unrelated.ts']);
    assert.ok(!result.groups.mobile.includes('apps/mobile/sources/regex.test.ts'));
    assert.ok(result.groups.body.includes('apps/body/src/process.test.ts'));
  } finally { clean(); }
});

test('shared contracts, configuration, migrations, unknown paths and structural diffs force full suites', () => {
  const { select, clean } = fixture(inputs);
  try {
    for (const path of ['packages/api-contract/src/phone.ts', '.github/workflows/checks.yml',
      'apps/server/src/database.ts', 'apps/server/migrations/new.sql', 'apps/mobile/tsconfig.json',
      'package-lock.json', 'scripts/setup.mjs', 'unknown.bin']) assert.equal(select([path]).mode, 'full', path);
    for (const status of ['A', 'D', 'R100']) assert.equal(select([], { changes: [{ path: 'apps/server/src/reader.ts', status }] }).mode, 'full', status);
    assert.equal(select([], { changes: undefined }).mode, 'full');
  } finally { clean(); }
});

test('unmodeled data/asset reads force full, while documentation remains quiet', () => {
  const { select, clean } = fixture({ ...inputs, 'apps/mobile/sources/data.json': '{}', 'docs/note.md': 'Note' });
  try {
    assert.equal(select(['apps/mobile/sources/data.json']).mode, 'full');
    assert.deepEqual(select(['docs/note.md']).groups, { server: [], body: [], mobile: [] });
  } finally { clean(); }
});

test('public-package dependencies include non-mirrored exports without importing provider tests into runtime edges', () => {
  const { select, clean } = fixture({ ...inputs,
    'packages/helper/package.json': JSON.stringify({ name: '@beeline/helper', exports: { './api': './dist/unusual.js' } }),
    'packages/helper/src/api.ts': 'export const unrelated = 1;',
    'packages/helper/src/unusual.ts': 'export const value = 1;',
    'packages/helper/src/api.test.ts': "import {execFile} from 'node:child_process';",
    'apps/mobile/sources/sdk.test.ts': "import {value} from '@beeline/helper/api';",
  });
  try {
    assert.ok(!select(['apps/server/src/unrelated.ts']).groups.mobile.includes('apps/mobile/sources/sdk.test.ts'));
    assert.ok(select(['packages/helper/src/unusual.ts']).groups.mobile.includes('apps/mobile/sources/sdk.test.ts'));
  } finally { clean(); }
});

test('implicit global test setup changes cannot become empty selections', () => {
  const paths = ['apps/mobile/sources/test/setupUnistyles.ts', 'apps/body/test-isolation.ts', 'apps/server/scripts/test-database-setup.ts'];
  const { select, clean } = fixture({ ...inputs, ...Object.fromEntries(paths.map(path => [path, 'export {};'])) });
  try { for (const path of paths) assert.equal(select([path]).mode, 'full', path); }
  finally { clean(); }
});

test('a discovered new regression test always runs without treating it as new production code', () => {
  const file = 'apps/mobile/sources/new.test.ts';
  const { select, clean } = fixture({ ...inputs, [file]: 'export {};' });
  try {
    const result = select([], { changes: [{ path: file, status: 'A' }] });
    assert.equal(result.mode, 'subset');
    assert.ok(result.groups.mobile.includes(file));
    assert.equal(select([], { changes: [{ path: file, status: 'A' }], testFiles: { server: [], body: [], mobile: [] } }).mode, 'full');
  } finally { clean(); }
});

test('the CLI emits full GHA outputs on a diff failure and for every non-PR event', () => {
  const directory = mkdtempSync(join(tmpdir(), 'selector-cli-'));
  try {
    for (const event of ['pull_request', 'push', 'merge_group']) {
      const out = join(directory, event + '.json'), output = join(directory, event + '.output');
      const result = spawnSync(process.execPath, [fileURLToPath(new URL('./workspace-test-selection.mjs', import.meta.url)), '--out', out], {
        cwd: fileURLToPath(new URL('../', import.meta.url)), encoding: 'utf8',
        env: { ...process.env, GITHUB_EVENT_NAME: event, CI_BASE_SHA: 'unavailable', GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: '' },
      });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(JSON.parse(readFileSync(out, 'utf8')).mode, 'full');
      for (const group of ['server', 'body', 'mobile']) assert.ok(readFileSync(output, 'utf8').includes(`${group}=true\n`));
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('workspace documentation and fixture readers remain affected tests', () => {
  const { select, clean } = fixture({ ...inputs,
    'apps/body/README.md': 'Body documentation',
    'apps/body/src/readme.test.ts': "import {readFileSync} from 'node:fs'; const text=readFileSync('README.md','utf8');",
    'apps/body/unknown.md': 'Unmodeled read',
  });
  try {
    assert.ok(select(['apps/body/README.md']).groups.body.includes('apps/body/src/readme.test.ts'));
    assert.equal(select(['apps/body/unknown.md']).mode, 'full');
  } finally { clean(); }
});
