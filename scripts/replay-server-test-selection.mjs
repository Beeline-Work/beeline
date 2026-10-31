import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { selectTests, changedRanges } from '../apps/server/scripts/select-ci-tests.mjs';

const git = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
const measurementCommit = 'c642ee024c677dbfafa02a652b7e4c20ace09265';
const guards = new Set([3125, 3095, 3087, 3081, 3070, 3052, 3050]);
const index = process.argv[2] ? JSON.parse(readFileSync(process.argv[2], 'utf8')) : null;
const commits = git('log', measurementCommit, '--first-parent', '--max-count=50', '--format=%H%x09%s', '--', 'apps/server')
  .trim().split('\n');
const results = [];
for (const commit of commits) {
  const [head, title] = commit.split('\t');
  const number = Number(title.match(/\(#(\d+)\)$/)?.[1]);
  assert.ok(number, `Expected a merged PR: ${title}`);
  const base = git('rev-parse', `${head}^`).trim();
  const tests = git('ls-tree', '-r', '--name-only', base, '--', 'apps/server/src').trim().split('\n')
    .filter(file => /\.test\.tsx?$/.test(file));
  const files = git('diff', '--name-only', '--no-renames', base, head).trim().split('\n').filter(Boolean);
  const changes = files.map(file => ({ file, ranges: changedRanges(git('diff', '--no-ext-diff', '--no-renames', '--unified=0', base, head, '--', file)) }));
  const baseHashes = {};
  for (const file of Object.keys(index?.sources ?? {})) {
    try {
      baseHashes[file] = createHash('sha256').update(git('show', `${base}:${file}`)).digest('hex');
    } catch { /* Missing historical files make a map stale. */ }
  }
  const selection = selectTests({ index, base, tests, changes, baseHashes });
  if (guards.has(number)) assert.ok(selection.tests.includes('apps/server/src/system-messages-lock.test.ts'), `Guard missed on PR ${number}`);
  results.push({ number, base, head, mode: selection.mode, reason: selection.reason,
    fullTests: tests.length, selectedTests: selection.tests.length, recordedGuardRetained: guards.has(number) ? true : null });
}
assert.equal(results.filter(result => result.recordedGuardRetained).length, guards.size);
const allFull = results.every(result => result.mode === 'full');
console.log(JSON.stringify({
  measurementCommit,
  provenance: 'Reconstructed from the last 50 first-parent merged server PRs; original measurement bundle unavailable',
  scope: allFull ? 'fallback-only replay; does not establish optimized selection recall or savings' : 'coverage-map replay',
  prCount: results.length,
  retainedRecordedGuards: guards.size,
  medianTestTimeSavingsPercent: allFull ? 0 : null,
  p90TestTimeSavingsPercent: allFull ? 0 : null,
  medianPrWallTimeSavingsPercent: allFull ? 0 : null,
  p90PrWallTimeSavingsPercent: allFull ? 0 : null,
  savingsBasis: allFull ? 'All historical suites remain full; selection therefore removes no test or critical-path work' : 'Measured timing inputs required',
  results,
}, null, 2));
