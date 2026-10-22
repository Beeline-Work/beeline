import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { balanceFiles } from './ci-shards.mjs';

const [position, count] = process.argv[2]?.split('/').map(Number) ?? [];
assert.ok(Number.isInteger(position) && Number.isInteger(count) && position > 0 && position <= count && count <= 16,
  'expected a server shard such as 1/4');
const root = fileURLToPath(new URL('../', import.meta.url));
const vitest = fileURLToPath(new URL('../../../node_modules/vitest/vitest.mjs', import.meta.url));
const exclusions = ['src/production-corpus-hot-reads.test.ts', 'src/integration.test.ts', 'src/agent-command.scaling.test.ts']
  .flatMap((file) => ['--exclude', file]);
function list(files = []) {
  const result = spawnSync(process.execPath, [vitest, 'list', '--filesOnly', '--json', ...exclusions, ...files], {
    cwd: root, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'inherit'],
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, 'Vitest discovery must succeed');
  return JSON.parse(result.stdout).map(({ file }) => relative(root, file));
}
const files = list();
const timingData = JSON.parse(readFileSync(new URL('./ci-test-timings.json', import.meta.url), 'utf8'));
const shards = balanceFiles(files, timingData.files, count);
const selected = shards[position - 1];
assert.ok(selected.files.length > 0, 'server shard has no files');
assert.deepEqual(list(selected.files).sort(), [...selected.files].sort(), 'Vitest must select exactly the assigned files');
console.log(JSON.stringify({ shard: `${position}/${count}`, totalFiles: files.length, ...selected }, null, 2));
if (!process.argv.includes('--list')) {
  const result = spawnSync(process.execPath, [vitest, 'run', ...exclusions, ...selected.files,
    '--maxWorkers=2', '--minWorkers=2'], { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
}
