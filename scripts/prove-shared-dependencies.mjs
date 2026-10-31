// Narrow built-helper proof: real npm installs and builds inside the helper's sandbox.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import {
  prepareDependencyGeneration,
  installDependencyNpmGuard,
  collectDependencyStore,
} from '../apps/body/dist/dependency-generation.js';
import { wrapAgentCommand } from '../apps/body/dist/bwrap-sandbox.js';
const root = await mkdtemp(resolve(tmpdir(), 'shared-dependency-proof-'));
const npm = execFileSync('which', ['npm'], { encoding: 'utf8' }).trim();
const store = resolve(root, 'store');
const cache = resolve(root, 'cache');
const corners = [resolve(root, 'a'), resolve(root, 'b')];
try {
  await mkdir(cache);
  const prepare = (cwd) =>
    prepareDependencyGeneration({
      root: cwd,
      store,
      npm,
      cache,
      install: async () => {
        const result = run(cwd, npm, ['ci', '--no-audit', '--no-fund'], false);
        assert.equal(result.status, 0, result.stderr);
      },
    });
  const archives = [];
  for (const version of ['1.0.0', '2.0.0']) {
    const pkg = resolve(root, version);
    await mkdir(pkg);
    await writeFile(
      resolve(pkg, 'package.json'),
      JSON.stringify({ name: 'shared-proof', version, main: 'index.js' }),
    );
    await writeFile(resolve(pkg, 'index.js'), `module.exports='${version}';`);
    const packed = JSON.parse(
      execFileSync(npm, ['pack', '--json'], { cwd: pkg, encoding: 'utf8' }),
    );
    archives.push(resolve(pkg, packed[0].filename));
  }
  for (const cwd of corners) {
    await mkdir(cwd);
    await writeFile(
      resolve(cwd, 'package.json'),
      JSON.stringify({
        name: 'consumer',
        version: '1.0.0',
        dependencies: { 'shared-proof': `file:${archives[0]}` },
        scripts: {
          build: `node -e "require('fs').writeFileSync('built',require('shared-proof'))"`,
        },
      }),
    );
    execFileSync(npm, ['install', '--package-lock-only', '--no-audit', '--ignore-scripts'], {
      cwd,
      stdio: 'pipe',
    });
    await prepare(cwd);
  }
  const dep = 'node_modules/shared-proof/index.js';
  const [first, second] = await Promise.all(corners.map((cwd) => stat(resolve(cwd, dep))));
  assert.equal(first.ino, second.ino);
  function run(cwd, command, args, sealed = true) {
    const wrapped = wrapAgentCommand({
      bwrapPath: '/usr/bin/bwrap',
      spec: {
        mode: 'edit',
        cwd,
        worktreePath: cwd,
        protectedPaths: [root],
        additionalWritablePaths: [cache],
        dependencyPaths: sealed ? [resolve(cwd, 'node_modules')] : [],
      },
      command,
      args,
    });
    return spawnSync(wrapped.command, wrapped.args, { encoding: 'utf8' });
  }
  const write = run(corners[0], 'sh', ['-c', `chmod u+w ${dep} && echo broken > ${dep}`]);
  assert.notEqual(write.status, 0);
  const path = await installDependencyNpmGuard(resolve(root, 'home'), npm, process.env.PATH);
  const refused = spawnSync('npm', ['install'], {
    cwd: corners[0],
    env: { ...process.env, PATH: path },
    encoding: 'utf8',
  });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /--package-lock-only/);
  const update = run(corners[0], resolve(root, 'home/dependency-bin/npm'), [
    'install',
    '--package-lock-only',
    `file:${archives[1]}`,
    '--no-audit',
  ]);
  assert.equal(update.status, 0, update.stderr);
  await prepare(corners[0]);
  for (const [index, cwd] of corners.entries()) {
    const result = run(cwd, npm, ['run', 'build']);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(await readFile(resolve(cwd, 'built'), 'utf8'), index === 0 ? '2.0.0' : '1.0.0');
  }
  assert.deepEqual(await collectDependencyStore(store), []);
  await rm(resolve(corners[1], 'node_modules'), { recursive: true });
  assert.equal((await collectDependencyStore(store)).length, 1);
  assert.match(await readFile(resolve(corners[0], dep), 'utf8'), /2.0.0/);
  await rm(resolve(corners[0], 'node_modules'), { recursive: true });
  assert.equal((await collectDependencyStore(store)).length, 1);
  console.log(
    JSON.stringify(
      {
        proof: 'DEPENDENCY-GENERATION-1',
        sameInode: true,
        writeDenied: true,
        npmDiagnostic: true,
        builds: ['2.0.0', '1.0.0'],
        unusedGenerationsCollected: 2,
        dependencyPayloadBytes: {
          codexShared: first.size,
          beelinePrivateBefore: first.size * 2,
          beelineSharedAfter: first.size,
        },
      },
      null,
      2,
    ),
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
