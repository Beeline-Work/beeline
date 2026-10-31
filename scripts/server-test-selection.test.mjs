import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { selectTests, changedRanges, readsOutsideCoverage } from '../apps/server/scripts/select-ci-tests.mjs';
import { collectionGroups } from '../apps/server/scripts/collect-ci-coverage.mjs';

const prefix = 'apps/server/src/';
const tests = ['affected', 'unrelated', 'system-messages-lock', 'unlinked'].map(name => `${prefix}${name}.test.ts`);
const file = `${prefix}service.ts`;
const index = {
  version: 1, revision: 'base', sources: { [file]: 'digest' }, alwaysRun: [tests[2]],
  tests: {
    [tests[0]]: [{ file, start: 10, end: 20 }],
    [tests[1]]: [{ file, start: 30, end: 40 }],
    [tests[2]]: [], [tests[3]]: [],
  },
};
const choose = overrides => selectTests({ index, tests, base: 'base', baseHashes: { [file]: 'digest' },
  changes: [{ file, ranges: [[15, 15]] }], ...overrides });

test('a function change keeps its owner and source guards while omitting an unrelated function owner', () => {
  assert.deepEqual(choose().tests, [tests[0], tests[2], tests[3]].sort());
  assert.equal(choose().mode, 'selected');
});

test('missing, stale, incomplete and source-mismatched maps all run the full suite', () => {
  for (const overrides of [{ index: null }, { base: 'new-base' }, { baseHashes: {} },
    { tests: [...tests, `${prefix}new.test.ts`] }]) {
    assert.equal(choose(overrides).mode, 'full');
  }
});

test('setup, dependencies, test edits, renamed files and new top-level code fail closed', () => {
  for (const changed of ['package-lock.json', 'packages/api-contract/src/daemon.ts',
    'apps/server/vitest.config.ts', `${prefix}test-support.ts`, tests[0], `${prefix}new.ts`]) {
    assert.equal(choose({ changes: [{ file: changed, ranges: [[1, 1]] }] }).mode, 'full', changed);
  }
  for (const ranges of [[[1, 2]], [[19, 31]], [[21, 22]], []]) {
    assert.equal(choose({ changes: [{ file, ranges }] }).mode, 'full');
  }
});

test('insertions check both adjacent old lines and multi-line hunks cannot hide unowned code', () => {
  assert.deepEqual(changedRanges('@@ -19,0 +20,2 @@\n+x\n+y\n@@ -30,2 +32 @@'), [[19, 20], [30, 31]]);
  assert.equal(choose({ changes: [{ file, ranges: [[20, 21]] }] }).mode, 'full');
});

test('every recorded guard miss is retained even when no runtime function changes', () => {
  const guard = resolve('apps/server/src/system-messages-lock.test.ts');
  assert.equal(readsOutsideCoverage(guard, file => readFileSync(file, 'utf8')), true);
  for (const pr of [3125, 3095, 3087, 3081, 3070, 3052, 3050]) {
    assert.ok(choose({ changes: [] }).tests.includes(tests[2]), `PR ${pr}`);
  }
});

test('source reads hidden behind local helpers and subprocess/browser tests remain always-run', () => {
  const sources = {
    '/test.ts': "import { read } from './helper.js';",
    '/helper.ts': "import { readFile } from 'node:fs/promises';",
  };
  assert.equal(readsOutsideCoverage('/test.ts', file => sources[file]), true);
  assert.equal(readsOutsideCoverage('/test.ts', () => "import { spawn } from 'node:child_process';"), true);
  assert.equal(readsOutsideCoverage('/test.ts', () => "import { chromium } from 'playwright';"), true);
});

test('collection runs the real source scanner without profiling and instruments only prunable tests', () => {
  const previous = process.env.BEELINE_FUNCTION_COVERAGE_DIR;
  try {
    process.env.BEELINE_FUNCTION_COVERAGE_DIR = 'coverage';
    const groups = collectionGroups(['src/system-messages-lock.test.ts', 'src/live-replay.test.ts']);
    assert.deepEqual(groups, [
      { files: ['src/system-messages-lock.test.ts'], args: [], marker: true },
      { files: ['src/live-replay.test.ts'], args: ['--config', 'vitest.function-coverage.config.ts'], marker: false },
    ]);
  } finally {
    if (previous === undefined) delete process.env.BEELINE_FUNCTION_COVERAGE_DIR;
    else process.env.BEELINE_FUNCTION_COVERAGE_DIR = previous;
  }
});
