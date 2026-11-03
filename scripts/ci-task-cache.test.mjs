import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

test('task outputs survive a commit boundary but config and external build inputs invalidate them', () => {
  const root = mkdtempSync(join(tmpdir(), 'ci-task-cache-'));
  const git = (...args) => execFileSync('git', ['-c', 'user.name=CI fixture', '-c', 'user.email=ci@example.invalid', ...args], { cwd: root });
  const put = (file, value) => writeFileSync(join(root, file), typeof value === 'string' ? value : JSON.stringify(value));
  const turbo = fileURLToPath(new URL('../node_modules/turbo/bin/turbo', import.meta.url));
  const run = () => spawnSync(process.execPath, [turbo, 'run', 'build', 'typecheck', '--concurrency=1'], {
    cwd: root, encoding: 'utf8', env: { ...process.env, TURBO_TELEMETRY_DISABLED: '1' },
  });
  try {
    mkdirSync(join(root, 'packages/lib'), { recursive: true });
    mkdirSync(join(root, 'scripts'));
    put('package.json', { name: 'cache-fixture', private: true, packageManager: 'npm@10.9.0', workspaces: ['packages/*'] });
    put('package-lock.json', { name: 'cache-fixture', lockfileVersion: 3, packages: {
      '': { name: 'cache-fixture', workspaces: ['packages/*'] },
      'packages/lib': { name: '@fixture/lib', version: '1.0.0' },
      'node_modules/@fixture/lib': { resolved: 'packages/lib', link: true },
    } });
    put('packages/lib/package.json', { name: '@fixture/lib', version: '1.0.0', scripts: {
      build: 'node ../../scripts/build-usebeeline-package.mjs', typecheck: 'node ../../scripts/build-usebeeline-package.mjs check',
    } });
    put('turbo.json', readFileSync(new URL('../turbo.json', import.meta.url), 'utf8'));
    put('.gitignore', 'node_modules\n.turbo\n**/dist\nruns.log\n');
    put('tsconfig.base.json', { valid: true });
    put('scripts/build-usebeeline-package.mjs', `import fs from 'node:fs';
const config=JSON.parse(fs.readFileSync('../../tsconfig.base.json'));
fs.appendFileSync('../../runs.log', process.argv[2] ? 'check\\n' : 'build\\n');
if(process.argv[2] && !config.valid) process.exit(7);
fs.mkdirSync('dist',{recursive:true}); fs.writeFileSync('dist/output',JSON.stringify(config));
`);
    git('init', '-q'); git('add', '.'); git('commit', '-qm', 'First head');
    let result = run();
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(readFileSync(join(root, 'runs.log'), 'utf8').trim().split('\n').length, 2);
    git('commit', '-q', '--allow-empty', '-m', 'Another commit with identical inputs');
    rmSync(join(root, 'packages/lib/dist'), { recursive: true });
    result = run();
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(readFileSync(join(root, 'runs.log'), 'utf8').trim().split('\n').length, 2, 'unchanged inputs reuse both tasks across commits');
    assert.equal(JSON.parse(readFileSync(join(root, 'packages/lib/dist/output'), 'utf8')).valid, true);
    put('scripts/build-usebeeline-package.mjs', readFileSync(join(root, 'scripts/build-usebeeline-package.mjs'), 'utf8') + '\n// changed external builder\n');
    result = run();
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(readFileSync(join(root, 'runs.log'), 'utf8').trim().split('\n').length, 4, 'external builder invalidates both task hashes');
    put('tsconfig.base.json', { valid: false });
    result = run();
    assert.notEqual(result.status, 0, 'a changed root config must execute and expose the new typecheck failure');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
