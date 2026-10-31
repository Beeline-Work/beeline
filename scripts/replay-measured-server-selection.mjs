import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { selectTests, readsOutsideCoverage } from '../apps/server/scripts/select-ci-tests.mjs';

const [bundleArg, outputArg, checkoutArg] = process.argv.slice(2);
assert.ok(bundleArg && outputArg && checkoutArg, 'Expected bundle, output directory and measurement checkout');
const bundle = resolve(bundleArg), output = resolve(outputArg), checkout = resolve(checkoutArg);
assert.ok(output !== bundle && !output.startsWith(`${bundle}/`), 'Measurement input must remain read-only');
const read = (directory, file) => JSON.parse(readFileSync(join(directory, file), 'utf8'));
const run = (command, args) => execFileSync(command, args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
const git = (...args) => run('git', ['-C', checkout, ...args]);
const packed = read(bundle, 'coverage-index.json');
assert.equal(git('rev-parse', 'HEAD').trim(), packed.sourceCommit, 'Use the original measurement checkout');
git('diff', '--exit-code', 'HEAD', '--', 'apps/server/src', 'apps/body/src', 'apps/auth/src', 'packages');
mkdirSync(output, { recursive: true });

// Reuse the original collectors/replay, copying only inputs that their
// comparison script reads or rewrites. Never write into the delivered bundle.
const baseline = join(output, 'baseline'), fixes = join(output, 'verified-fixes');
for (const directory of [baseline, fixes]) {
  mkdirSync(directory, { recursive: true });
  for (const file of ['failure-history.json', 'timings.json', 'test-case-counts.json', 'integration-discovery.json']) {
    if (existsSync(join(bundle, file))) copyFileSync(join(bundle, file), join(directory, file));
  }
}
for (const file of ['import-closure.json', 'current-functions.json', 'pr-diffs.json', 'selected-prs.json']) {
  copyFileSync(join(bundle, file), join(baseline, file));
}
const verified = read(bundle, 'verified-fixes.json');
const fixNumbers = [...new Set(verified.map(fix => fix.pr))];
writeFileSync(join(fixes, 'pr-numbers.json'), JSON.stringify(fixNumbers));
if (!existsSync(join(fixes, 'selected-prs.json'))) {
  run('python3', [join(bundle, 'prepare-prs.py'), '--prs', join(fixes, 'pr-numbers.json'), '--out', join(fixes, 'selected-prs.json')]);
}
assert.deepEqual(read(fixes, 'selected-prs.json').map(pr => pr.number).sort(), [...fixNumbers].sort());
run(process.execPath, [join(bundle, 'selection.mjs'), '--repo', checkout, '--out', fixes, '--prs', join(fixes, 'selected-prs.json')]);
for (const directory of [baseline, fixes]) {
  run('python3', [join(bundle, 'compare-selection.py'), '--root', directory, '--repo', checkout,
    '--coverage-index', join(bundle, 'coverage-index.json')]);
}
assert.deepEqual(read(baseline, 'selection-results.json'), read(bundle, 'selection-results.json'), 'Original indexed replay must reproduce exactly');

const index = { version: 1, revision: packed.sourceCommit, tests: {}, sources: {}, alwaysRun: [] };
for (const [test, entry] of Object.entries(packed.tests)) {
  index.tests[test] = entry.functionIds.map(id => packed.functions[id]).filter(fn => packed.sources[fn.source].startsWith('apps/server/src/'))
    .map(fn => ({ file: packed.sources[fn.source], start: fn.location.start.line, end: fn.location.end.line }));
  if (!index.tests[test].length || entry.variantExits.some(exit => exit !== 0) ||
      readsOutsideCoverage(join(checkout, test), file => readFileSync(file, 'utf8'))) index.alwaysRun.push(test);
}
for (const fn of Object.values(index.tests).flat()) {
  if (!index.sources[fn.file]) index.sources[fn.file] = createHash('sha256').update(readFileSync(join(checkout, fn.file))).digest('hex');
}
const rows = [...read(baseline, 'pr-diffs.json'), ...read(fixes, 'pr-diffs.json')];
const selections = rows.map(pr => {
  assert.ok(!pr.error, `PR ${pr.number}: ${pr.error}`);
  const tests = git('ls-tree', '-r', '--name-only', pr.head, '--', 'apps/server/src').trim().split('\n').filter(file => /\.test\.tsx?$/.test(file));
  const selection = selectTests({ index, base: pr.base, tests, changes: [], baseHashes: {} });
  // The frozen map is not historical execution coverage. The actual deployed
  // freshness gate must reject it before consulting projected function IDs.
  assert.equal(selection.mode, 'full', `Unexpected historical-map acceptance: PR ${pr.number}`);
  return { pr: pr.number, mode: selection.mode, reason: selection.reason, tests: selection.tests };
});
const byPr = new Map(selections.map(row => [row.pr, row]));
const guardPrs = [3125, 3095, 3087, 3081, 3070, 3052, 3050];
for (const pr of guardPrs) assert.ok(byPr.get(pr).tests.includes('apps/server/src/system-messages-lock.test.ts'), `Guard miss: PR ${pr}`);
const realEvents = read(bundle, 'server-failure-history.json').filter(event => event.classification === 'real');
assert.equal(realEvents.length, 8, 'Expected the original confirmed-real ledger');
for (const event of realEvents) {
  assert.ok(event.prNumbers.some(pr => byPr.get(pr)?.tests.includes(event.file)), `Real failure omitted: ${event.file}`);
}
const cohort = new Set(rows.slice(0, 50).map(pr => pr.number));
const runs = read(bundle, 'ci-runs.json').filter(run => run.event === 'pull_request' && run.conclusion === 'success' && run.prNumbers?.some(pr => cohort.has(pr)));
const baselineSeconds = runs.map(run => (Date.parse(run.updated_at) - Date.parse(run.run_started_at)) / 1000).sort((a, b) => a - b);
const median = values => values.length % 2 ? values[(values.length - 1) / 2] : (values[values.length / 2 - 1] + values[values.length / 2]) / 2;
const summary = {
  sourceCommit: packed.sourceCommit,
  originalIndexedReplayIdentical: true,
  measuredPrs: 50, supplementalVerifiedFixPrs: fixNumbers, selectedPrs: selections.length,
  confirmedRealEvents: realEvents.length, confirmedRealMisses: 0, guardPrs, guardMisses: 0,
  fullFallbackPrs: selections.filter(row => row.mode === 'full').length,
  medianTestWorkSavingsPercent: 0, p90TestWorkSavingsPercent: 0,
  medianPrWallSavingsPercent: 0, p90PrWallSavingsPercent: 0,
  successfulObservedRuns: runs.length,
  observedMedianPrWallSeconds: median(baselineSeconds),
  observedP90PrWallSeconds: baselineSeconds[Math.ceil(baselineSeconds.length * 0.9) - 1],
  interpretation: 'The measurement map is stale for every historical base. Production selection retains all work, including the longest shard and all other CI paths. Zero potential time savings; new map-restore overhead is not measured.',
  projectionLimit: 'The original 70.5% median is a current-map projection, not valid historical coverage. It must not be presented as deployed-policy savings.',
};
writeFileSync(join(output, 'report.json'), JSON.stringify(summary, null, 2));
writeFileSync(join(output, 'selections.json'), JSON.stringify(selections, null, 2));
console.log(JSON.stringify(summary, null, 2));
