import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const [position, count] = process.argv[2]?.split('/').map(Number) ?? [];
if (
  !Number.isInteger(position) ||
  !Number.isInteger(count) ||
  position < 1 ||
  count < 1 ||
  count > 16 ||
  position > count
) {
  throw new Error('expected an integration shard such as 1/8');
}

const vitest = fileURLToPath(new URL('../../../node_modules/vitest/vitest.mjs', import.meta.url));
const testFile = 'src/integration.test.ts';
const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function listTests(args = []) {
  const result = spawnSync(process.execPath, [vitest, 'list', testFile, '--json', ...args], {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  if (result.status !== 0) throw new Error(`vitest list failed: ${result.status}`);
  return JSON.parse(result.stdout);
}

const all = listTests();
const selected = all.filter((_, index) => index % count === position - 1);
assert(selected.length > 0, 'integration shard has no tests');
const names = selected.map(({ name }) => name);
assert.equal(new Set(names).size, names.length, 'integration tests need unique full names');
const pattern = `^(?:${names.map((name) => escapeRegExp(name.replace(' > ', ' '))).join('|')})$`;
assert.deepEqual(
  listTests(['--testNamePattern', pattern]).map(({ name }) => name),
  names,
  'integration shard selector must match exactly its assigned tests',
);

console.log(`Integration shard ${position}/${count}: ${selected.length}/${all.length} tests`);
const run = spawnSync(
  process.execPath,
  [vitest, 'run', testFile, '--maxWorkers=1', '--minWorkers=1', '--testNamePattern', pattern],
  { stdio: 'inherit' },
);
if (run.error) throw run.error;
process.exit(run.status ?? 1);
