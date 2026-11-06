import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, delimiter, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const npm = resolve(dirname(process.execPath), 'npm');
const environment = cwd => ({ ...process.env, BEELINE_READONLY_DEPENDENCIES: '0', PATH: join(cwd, 'bin') + delimiter + process.env.PATH });
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
    await mkdir(join(cwd, 'bin'));
    await writeFile(join(cwd, 'bin/npm'), `#!${process.execPath}
const fs=require('node:fs'),{spawnSync}=require('node:child_process');
const args=process.argv.slice(2);
if(args.includes('turbo')) {
 fs.mkdirSync('node_modules/shared/dist',{recursive:true});
 fs.writeFileSync('node_modules/shared/package.json',JSON.stringify({name:'shared',exports:'./dist/index.js'}));
 fs.writeFileSync('node_modules/shared/dist/index.js','module.exports="ready";');
} else {
 const result=spawnSync(${JSON.stringify(npm)},args,{stdio:'inherit'});
 if(result.error) throw result.error;
 process.exit(result.status??1);
}
`, {mode:0o755});
    await fn(cwd);
  } finally { await rm(cwd, { recursive: true, force: true }); }
}
const exists = (path) => access(path).then(() => true, () => false);
for (const options of [[], ['--mobile'], ['--build'], ['--mobile', '--build']]) {
  test(`Reproduction COLD-EXPORT: preparation builds shared exports and requested application stages: ${options.join(' ') || 'default'}`, async () => fixture(async (cwd) => {
    const result = spawnSync(process.execPath, [prepare, ...options], { cwd, encoding: 'utf8', env: environment(cwd) });
    assert.equal(result.status, 0, result.stderr);
    const imported = spawnSync(process.execPath, ['-e', 'process.stdout.write(require("shared"))'], {cwd,encoding:'utf8'});
    assert.equal(imported.status,0,imported.stderr);
    assert.equal(imported.stdout,'ready');
    assert.equal(await exists(join(cwd, 'mobile-ran')), options.includes('--mobile'));
    assert.equal(await exists(join(cwd, 'build-ran')), options.includes('--build'));
  }));
}
test('invalid options fail before installation', async () => fixture(async (cwd) => {
  await rm(join(cwd, 'package-lock.json'));
  const result = spawnSync(process.execPath, [prepare, '--moblie'], { cwd, encoding: 'utf8', env: environment(cwd) });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Unknown preparation option/);
}));

test('managed preparation preserves mounted trees and requests mobile for the next turn', async () => fixture(async (cwd) => {
  await rm(join(cwd, 'package-lock.json'));
  const result = spawnSync(process.execPath, [prepare, '--mobile', '--build'], {
    cwd, encoding: 'utf8', env: { ...environment(cwd), BEELINE_READONLY_DEPENDENCIES: '1' },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(await exists(join(cwd, 'mobile-ran')), false);
  assert.equal(await exists(join(cwd, '.beeline-dependency-request')), true);
  assert.equal(await exists(join(cwd, 'build-ran')), true);
  assert.match(result.stdout, /automatically at the next turn/);
}));
