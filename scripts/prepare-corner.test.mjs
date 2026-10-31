import assert from 'node:assert/strict';
import { mkdtemp, writeFile, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const prepare = resolve('scripts/prepare-corner.mjs');
async function fixture(fn) {
  const cwd = await mkdtemp(join(tmpdir(), 'prepare-corner-'));
  try {
    await writeFile(join(cwd, 'package.json'), JSON.stringify({
      name: 'preparation-proof', version: '1.0.0',
      scripts: {
        'mobile:install': 'node -e "require(\'fs\').writeFileSync(\'mobile-ran\',\'yes\')"',
        build: 'node -e "require(\'fs\').writeFileSync(\'build-ran\',\'yes\')"',
      },
    }));
    await writeFile(join(cwd, 'package-lock.json'), JSON.stringify({
      name: 'preparation-proof', version: '1.0.0', lockfileVersion: 3,
      packages: { '': { name: 'preparation-proof', version: '1.0.0' } },
    }));
    await fn(cwd);
  } finally { await rm(cwd, { recursive: true, force: true }); }
}
const exists = (path) => access(path).then(() => true, () => false);
for (const options of [[], ['--mobile'], ['--build'], ['--mobile', '--build']]) {
  test(`preparation runs only requested stages: ${options.join(' ') || 'default'}`, async () => fixture(async (cwd) => {
    const result = spawnSync(process.execPath, [prepare, ...options], { cwd, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(await exists(join(cwd, 'mobile-ran')), options.includes('--mobile'));
    assert.equal(await exists(join(cwd, 'build-ran')), options.includes('--build'));
  }));
}
test('invalid options fail before installation', async () => fixture(async (cwd) => {
  await rm(join(cwd, 'package-lock.json'));
  const result = spawnSync(process.execPath, [prepare, '--moblie'], { cwd, encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Unknown preparation option/);
}));
