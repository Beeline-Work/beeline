import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { balanceFiles } from './ci-shards.mjs';
import { currentSelection } from './select-ci-tests.mjs';
import { collectionGroups, recordAlwaysRun } from './collect-ci-coverage.mjs';

const [position, count] = process.argv[2]?.split('/').map(Number) ?? [];
assert.ok(Number.isInteger(position) && Number.isInteger(count) && position > 0 && position <= count && count <= 16,
  'expected a server shard such as 1/4');
const root = fileURLToPath(new URL('../', import.meta.url));
const vitest = fileURLToPath(new URL('../../../node_modules/vitest/vitest.mjs', import.meta.url));
const selection = currentSelection();
const shouldRun = file => selection.tests.includes(`apps/server/${file}`);
// Wall-clock budgets and held voice playback must not compete with database
// migrations in another worker. Keep their coverage in the same required job.
const isolated = ['src/production-corpus-width.test.ts', 'src/voice-room-runtime.test.ts'];
const exclusions = ['src/production-corpus-hot-reads.test.ts', 'src/integration.test.ts', 'src/agent-command.scaling.test.ts', ...isolated]
  .flatMap((file) => ['--exclude', file]);
function list(files = [], exclude = exclusions) {
  const result = spawnSync(process.execPath, [vitest, 'list', ...files, '--filesOnly', '--json', ...exclude], {
    cwd: root, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'inherit'],
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, 'Vitest discovery must succeed');
  return JSON.parse(result.stdout).map(({ file }) => relative(root, file));
}
const files = list();
const timingData = JSON.parse(readFileSync(new URL('./ci-test-timings.json', import.meta.url), 'utf8'));
const shards = balanceFiles(files.filter(shouldRun), timingData.files, count);
const selected = shards[position - 1];
const isolatedFiles = position === Math.min(3, count) ? isolated.filter(shouldRun) : [];
assert.deepEqual(list(isolated, []).sort(), [...isolated].sort(), 'isolated suites must remain discoverable');
if (selected.files.length) assert.deepEqual(list(selected.files).sort(), [...selected.files].sort(), 'Vitest must select exactly the assigned files');
console.log(JSON.stringify({ shard: `${position}/${count}`, totalFiles: files.length + isolated.length,
  selection: { mode: selection.mode, reason: selection.reason }, ...selected, isolatedFiles }, null, 2));
if (!process.argv.includes('--list')) {
  let status = 0;
  function run(files, workers, exclude = []) {
    for (const group of collectionGroups(files)) {
      if (!group.files.length) continue;
      const result = spawnSync(process.execPath, [vitest, 'run', ...group.args, ...exclude, ...group.files,
        `--maxWorkers=${workers}`, `--minWorkers=${workers}`], { cwd: root, stdio: 'inherit' });
      if (result.error) throw result.error;
      if (result.status !== 0) status = result.status ?? 1;
      else if (group.marker) recordAlwaysRun(group.files);
    }
  }
  run(selected.files, 2, exclusions);
  for (const file of isolatedFiles) {
    run([file], 1);
  }
  process.exit(status);
}
