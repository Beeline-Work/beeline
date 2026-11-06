import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { balanceFiles } from './ci-shards.mjs';
import { readSelection, selected as runs } from './selected-tests.mjs';

const [position, count] = process.argv[2]?.split('/').map(Number) ?? [];
assert.ok(Number.isInteger(position) && Number.isInteger(count) &&
  position >= 1 && position <= count && count <= 16,
'expected an integration shard such as 1/8');

const root = fileURLToPath(new URL('../', import.meta.url));
const selection = readSelection();
const files = readdirSync(join(root, 'src/integration'))
  .filter(file => file.endsWith('.test.ts'))
  .map(file => `src/integration/${file}`)
  .filter(file => runs(selection, file));
const timings = JSON.parse(readFileSync(new URL('./ci-test-timings.json', import.meta.url), 'utf8'));
// The former monolith now has ordinary per-domain files. Use the same file
// balancer as the main server suite; every selected file belongs to one shard.
const selected = balanceFiles(files, timings.files, count)[position - 1].files;
console.log(`Integration shard ${position}/${count}: ${selected.length}/${files.length} files`);
if (process.argv.includes('--list')) {
  console.log(JSON.stringify(selected));
  process.exit(0);
}
if (!selected.length) {
  console.log('No selected integration files for this shard.');
  process.exit(0);
}
const vitest = fileURLToPath(new URL('../../../node_modules/vitest/vitest.mjs', import.meta.url));
const run = spawnSync(process.execPath,
  [vitest, 'run', ...selected, '--maxWorkers=1', '--minWorkers=1'],
  { cwd: root, stdio: 'inherit' });
if (run.error) throw run.error;
process.exit(run.status ?? 1);
