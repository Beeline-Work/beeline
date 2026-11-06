import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { it } from 'node:test';

it('assigns every moved integration suite once and honors a selected subset', () => {
  const root = path.resolve('apps/server');
  const files = readdirSync(path.join(root, 'src/integration')).filter(file => file.endsWith('.test.ts'))
    .map(file => `src/integration/${file}`).sort();
  const directory = mkdtempSync(path.join(tmpdir(), 'integration-selection-'));
  const selection = path.join(directory, 'selection.json');
  const assignments = mode => {
    writeFileSync(selection, JSON.stringify(mode));
    return Array.from({length: 8}, (_, index) => {
      const result = execFileSync(process.execPath, ['scripts/run-integration-shard.mjs', `${index + 1}/8`, '--list'], {
        cwd: root, encoding: 'utf8', env: {...process.env, SERVER_TEST_SELECTION: selection},
      });
      return JSON.parse(result.trim().split('\n').at(-1));
    }).flat().sort();
  };
  try {
    assert.ok(files.length > 0);
    assert.deepEqual(assignments({mode: 'full'}), files);
    assert.deepEqual(assignments({mode: 'subset', files: [`apps/server/${files[0]}`]}), [files[0]]);
    assert.deepEqual(assignments({mode: 'subset', files: []}), []);
    assert.match(readFileSync(path.join(root, 'scripts/run-ci-shard.mjs'), 'utf8'), /'src\/integration\/\*\.test\.ts'/);
  } finally { rmSync(directory, {recursive: true, force: true}); }
});
