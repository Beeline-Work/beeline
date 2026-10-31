import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Exercise the published collector -> map -> PR selector -> Vitest path in an
// isolated repository. No fixture can alter this checkout's git pointers.
const repository = fileURLToPath(new URL('../', import.meta.url));
const fixture = mkdtempSync(join(tmpdir(), 'server-selection-proof-'));
const server = join(fixture, 'apps/server');
const run = (command, args, options = {}) => execFileSync(command, args, { cwd: fixture, encoding: 'utf8', ...options });
const source = 'export function first() { return 1; }\nexport function second() { return 2; }\n';
try {
  mkdirSync(join(server, 'src'), { recursive: true });
  mkdirSync(join(server, 'scripts'));
  symlinkSync(resolve(repository, 'node_modules'), join(fixture, 'node_modules'), 'dir');
  writeFileSync(join(fixture, 'package.json'), '{"type":"module"}');
  for (const file of ['scripts/select-ci-tests.mjs', 'scripts/function-coverage-provider.mjs', 'scripts/observe-source-reads.mjs', 'vitest.function-coverage.config.ts']) {
    copyFileSync(join(repository, 'apps/server', file), join(server, file));
  }
  writeFileSync(join(server, 'src/service.ts'), source);
  for (const [name, expected] of [['first', 1], ['second', 2]]) {
    writeFileSync(join(server, `src/${name}.test.ts`),
      `import { it, expect } from 'vitest';\nimport { ${name} } from './service.js';\nit('${name}', () => expect(${name}()).toBe(${expected}));\n`);
  }
  writeFileSync(join(server, 'src/other.spec.js'),
    "import {it, expect} from 'vitest';\nimport {second} from './service.ts';\nit('JS spec', () => expect(second()).toBe(2));\n");
  writeFileSync(join(server, 'src/guard.test.ts'),
    "import { it, expect } from 'vitest';\nimport { sourceText } from './guard-helper.js';\nit('source guard', () => expect(sourceText()).not.toContain('return 99'));\n");
  writeFileSync(join(server, 'src/guard-helper.ts'),
    "import { readFileSync as load } from 'node:fs';\nexport function sourceText() { return load('src/service.ts','utf8'); }\n");
  run('git', ['init', '-q']);
  run('git', ['add', '.']);
  run('git', ['-c', 'user.name=Selection proof', '-c', 'user.email=proof@example.invalid', 'commit', '-qm', 'Fixture baseline']);
  const base = run('git', ['rev-parse', 'HEAD']).trim();
  const packets = join(fixture, 'packets');
  const vitest = join(fixture, 'node_modules/vitest/vitest.mjs');
  run(process.execPath, [vitest, 'run', '--config', 'vitest.function-coverage.config.ts', '--maxWorkers=1', '--minWorkers=1'], {
    cwd: server, env: { ...process.env, BEELINE_FUNCTION_COVERAGE_DIR: packets },
  });
  const map = join(fixture, 'coverage-index.json');
  run(process.execPath, ['apps/server/scripts/select-ci-tests.mjs', 'merge', packets, map]);
  const env = { ...process.env, GITHUB_EVENT_NAME: 'pull_request', BEELINE_TEST_BASE: base, BEELINE_TEST_COVERAGE_MAP: map };
  const select = () => JSON.parse(run(process.execPath, ['apps/server/scripts/select-ci-tests.mjs'], { env }));
  const commit = () => {
    run('git', ['add', 'apps/server/src/service.ts']);
    run('git', ['-c', 'user.name=Selection proof', '-c', 'user.email=proof@example.invalid', 'commit', '-qm', 'Change first function']);
  };
  writeFileSync(join(server, 'src/service.ts'), source.replace('return 1', 'return 99'));
  commit();
  const selected = select();
  assert.equal(selected.mode, 'selected');
  assert.deepEqual(selected.tests, ['apps/server/src/first.test.ts', 'apps/server/src/guard.test.ts']);
  const execute = () => spawnSync(process.execPath, [vitest, 'run', ...select().tests.map(file => file.replace('apps/server/', '')),
    '--maxWorkers=1', '--minWorkers=1'], { cwd: server, encoding: 'utf8' });
  assert.equal(execute().status, 1, 'selection must expose the changed function and source guard failures');
  writeFileSync(join(server, 'src/service.ts'), source.replace('return 1', 'return (1)'));
  commit();
  const passing = execute();
  assert.equal(passing.status, 0, passing.stdout + passing.stderr);
  const stale = JSON.parse(readFileSync(map, 'utf8'));
  stale.revision = 'stale';
  writeFileSync(map, JSON.stringify(stale));
  assert.equal(select().mode, 'full');
  assert.equal(select().tests.length, 4);
  console.log(JSON.stringify({ proof: 'SERVER-SELECTION-1', capturedTests: 4, selected: selected.tests,
    brokenResult: 'both changed-function and source-guard failures caught', fixedResult: 'selected tests pass', staleMap: 'full suite' }, null, 2));
} finally {
  rmSync(fixture, { recursive: true, force: true });
}
