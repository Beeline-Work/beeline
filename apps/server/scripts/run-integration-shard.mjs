import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readSelection, selected as runs } from './selected-tests.mjs';

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

if (!runs(readSelection(), 'src/integration.test.ts')) {
  console.log(`Integration shard ${position}/${count}: skipped, this PR changes nothing the integration file runs`);
  process.exit(0);
}

const vitest = fileURLToPath(new URL('../../../node_modules/vitest/vitest.mjs', import.meta.url));
const testFile = 'src/integration.test.ts';
const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Vitest writes the list to a file: global setup logs migrations to stdout.
function listTests(args = []) {
  const directory = mkdtempSync(join(tmpdir(), 'integration-shard-'));
  const output = join(directory, 'tests.json');
  try {
    const result = spawnSync(process.execPath, [vitest, 'list', testFile, `--json=${output}`, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'ignore', 'inherit'],
    });
    if (result.status !== 0) throw new Error(`vitest list failed: ${result.status}`);
    return JSON.parse(readFileSync(output, 'utf8'));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
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
if (process.argv.includes('--list')) {
  console.log(JSON.stringify(names));
  process.exit(0);
}
const run = spawnSync(
  process.execPath,
  [vitest, 'run', testFile, '--maxWorkers=1', '--minWorkers=1', '--testNamePattern', pattern],
  { stdio: 'inherit' },
);
if (run.error) throw run.error;
process.exit(run.status ?? 1);
