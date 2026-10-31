import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { readsOutsideCoverage } from './select-ci-tests.mjs';

const server = fileURLToPath(new URL('../', import.meta.url));

export function collectionGroups(files) {
  if (!process.env.BEELINE_FUNCTION_COVERAGE_DIR) return [{ files, args: [], marker: false }];
  const external = files.filter(file => readsOutsideCoverage(resolve(server, file), path => readFileSync(path, 'utf8'), new Set(), false));
  return [
    { files: external, args: [], marker: true },
    { files: files.filter(file => !external.includes(file)), args: ['--config', 'vitest.function-coverage.config.ts'], marker: false },
  ].filter(group => group.files.length);
}

export function recordAlwaysRun(files) {
  const directory = process.env.BEELINE_FUNCTION_COVERAGE_DIR;
  const key = createHash('sha256').update(JSON.stringify(files)).digest('hex');
  mkdirSync(directory, { recursive: true });
  writeFileSync(resolve(directory, `always-${key}-${process.pid}.json`), JSON.stringify(files.map(file => ({
    test: `apps/server/${file}`, functions: [],
  }))));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const files = process.argv.slice(2);
  if (!files.length) throw new Error('Expected server test files');
  let status = 0;
  for (const group of collectionGroups(files)) {
    const result = spawnSync(process.execPath, [resolve(server, '../../node_modules/vitest/vitest.mjs'), 'run',
      ...group.args, ...group.files, '--maxWorkers=1', '--minWorkers=1'], { cwd: server, stdio: 'inherit' });
    if (result.error) throw result.error;
    if (result.status !== 0) status = result.status ?? 1;
    else if (group.marker) recordAlwaysRun(group.files);
  }
  process.exit(status);
}
