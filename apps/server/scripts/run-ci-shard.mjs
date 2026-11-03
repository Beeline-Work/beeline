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
const workers = Number(process.env.CI_TEST_WORKERS || 2);
assert.ok(Number.isInteger(workers) && workers >= 1 && workers <= 2, 'CI_TEST_WORKERS must be 1 or 2');
const root = fileURLToPath(new URL('../', import.meta.url));
const vitest = fileURLToPath(new URL('../../../node_modules/vitest/vitest.mjs', import.meta.url));
// On PRs, wall-clock budgets run in the existing hosted replay gate, outside
// the shared CPU quota. Merge/dispatch runs retain them in their hosted shards.
const isolated = ['src/production-corpus-width.test.ts', 'src/voice-room-runtime.test.ts',
  'src/phone-service.read-room-latency.test.ts', 'src/daemon-service.completion-latency.test.ts',
  'src/durable-live.integration.test.ts'];
// Fresh worker processes give socket replay and completion timing independent
// engine/clock lifetimes. Replay remains on squire; the latency budget joins
// the existing hosted wall-clock proofs on PRs.
const timingFiles = [isolated[0], isolated[2], isolated[3]];
const hostedTiming = process.env.SERVER_HOSTED_TIMING || 'false';
assert.ok(['true', 'false'].includes(hostedTiming), 'SERVER_HOSTED_TIMING must be true or false');
assert.ok(hostedTiming === 'false' || process.env.GITHUB_EVENT_NAME === 'pull_request',
  'only PRs can move timing coverage to the required hosted replay gate');
const exclusions = ['src/production-corpus-hot-reads.test.ts', 'src/integration.test.ts', 'src/agent-command.scaling.test.ts', ...isolated]
  .flatMap((file) => ['--exclude', file]);
function list(files = [], exclude = exclusions) {
  const result = spawnSync(process.execPath, [vitest, 'list', '--maxWorkers=1', '--minWorkers=1', ...files, '--filesOnly', '--json', ...exclude], {
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
const hostedFiles = hostedTiming === 'true' ? timingFiles.filter(file => chosen(selection, file)) : [];
const isolatedFor = shard => isolated.filter((file, index) => !hostedFiles.includes(file)
  && shard === index % count + 1 && chosen(selection, file));
// Account for work that runs after the ordinary files too. Previously the
// voice shard and the slower integration batches received a full ordinary load.
const reservedMilliseconds = Array.from({ length: count }, (_, index) =>
  isolatedFor(index + 1).reduce((sum, file) => sum + (timingData.files[file] || 0), 0)
  + (count === 8 && chosen(selection, 'src/integration.test.ts')
    ? timingData.integrationBatches?.[index + 1] || 0 : 0));
const shards = balanceFiles(files, timingData.files, count, reservedMilliseconds);
const selected = shards[position - 1];
const isolatedFiles = isolatedFor(position);
assert.deepEqual(list(isolated, []).sort(), [...isolated].sort(), 'isolated suites must remain discoverable');
if (selection.mode === 'full') assert.ok(selected.files.length > 0, 'server shard has no files');
if (selected.files.length) assert.deepEqual(list(selected.files).sort(), [...selected.files].sort(), 'Vitest must select exactly the assigned files');
console.log(JSON.stringify({ shard: `${position}/${count}`, totalFiles: discovered.length + isolated.length, selection: selection.mode,
  ...selected, reservedMilliseconds: reservedMilliseconds[position - 1], isolatedFiles, hostedFiles }, null, 2));
if (!process.argv.includes('--list')) {
  let status = 0;
  if (selected.files.length) {
    const result = spawnSync(process.execPath, [vitest, 'run', ...exclusions, ...selected.files,
      `--maxWorkers=${workers}`, '--minWorkers=1', '--poolOptions.forks.singleFork', '--isolate'], { cwd: root, stdio: 'inherit' });
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
