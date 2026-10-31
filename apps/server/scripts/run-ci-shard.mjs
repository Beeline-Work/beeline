import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { balanceFiles } from './ci-shards.mjs';
import { readSelection, selected as chosen } from './selected-tests.mjs';

const [position, count] = process.argv[2]?.split('/').map(Number) ?? [];
assert.ok(Number.isInteger(position) && Number.isInteger(count) && position > 0 && position <= count && count <= 16,
  'expected a server shard such as 1/4');
const root = fileURLToPath(new URL('../', import.meta.url));
const vitest = fileURLToPath(new URL('../../../node_modules/vitest/vitest.mjs', import.meta.url));
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
// On a PR, only the files test-selection.mjs picked; otherwise every file.
const selection = readSelection();
const discovered = list();
const files = discovered.filter((file) => chosen(selection, file));
const timingData = JSON.parse(readFileSync(new URL('./ci-test-timings.json', import.meta.url), 'utf8'));
const shards = balanceFiles(files, timingData.files, count);
const selected = shards[position - 1];
const isolatedFiles = (position === Math.min(3, count) ? isolated : []).filter((file) => chosen(selection, file));
assert.deepEqual(list(isolated, []).sort(), [...isolated].sort(), 'isolated suites must remain discoverable');
if (selection.mode === 'full') assert.ok(selected.files.length > 0, 'server shard has no files');
if (selected.files.length) assert.deepEqual(list(selected.files).sort(), [...selected.files].sort(), 'Vitest must select exactly the assigned files');
console.log(JSON.stringify({ shard: `${position}/${count}`, totalFiles: discovered.length + isolated.length, selection: selection.mode,
  ...selected, isolatedFiles }, null, 2));
if (!process.argv.includes('--list')) {
  let status = 0;
  if (selected.files.length) {
    const result = spawnSync(process.execPath, [vitest, 'run', ...exclusions, ...selected.files,
      '--maxWorkers=2', '--minWorkers=2'], { cwd: root, stdio: 'inherit' });
    if (result.error) throw result.error;
    status = result.status ?? 1;
  } else {
    console.log('No selected server test files for this shard.');
  }
  for (const file of isolatedFiles) {
    const isolatedResult = spawnSync(process.execPath, [vitest, 'run', file, '--maxWorkers=1', '--minWorkers=1'], { cwd: root, stdio: 'inherit' });
    if (isolatedResult.error) throw isolatedResult.error;
    if (isolatedResult.status !== 0) status = isolatedResult.status ?? 1;
  }
  process.exit(status);
}
