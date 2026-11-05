import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { it, expect, vi } from 'vitest';
import { withKernelLock } from './kernel-lock.js';
import { wrapAgentCommand } from './bwrap-sandbox.js';
import {
  prepareDependencyGeneration,
  installDependencyNpmGuard,
  collectUnusedGenerations,
  collectDependencyStore,
  dependencyFingerprint,
} from './dependency-generation.js';

it('serves warm and cold copies immediately while another owner holds the dependency store', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'generation-busy-'));
  const store = resolve(root, 'store'), cache = resolve(root, 'cache');
  const warm = resolve(root, 'warm'), cold = resolve(root, 'cold');
  const lock = JSON.stringify({ name: 'fixture', lockfileVersion: 3,
    packages: { '': { name: 'fixture' }, 'node_modules/proof': { version: '1.0.0' } } });
  const install = async (cwd: string) => {
    await mkdir(resolve(cwd, 'node_modules/proof'), { recursive: true });
    await writeFile(resolve(cwd, 'node_modules/proof/package.json'), '{"name":"proof","version":"1.0.0"}');
    await writeFile(resolve(cwd, 'node_modules/.package-lock.json'), '{"packages":{"node_modules/proof":{}}}');
  };
  for (const cwd of [warm, cold]) {
    await mkdir(cwd); await writeFile(resolve(cwd, 'package-lock.json'), lock);
  }
  await prepareDependencyGeneration({ root: warm, store, cache, npm: '/unused', install: () => install(warm) });
  let release!: () => void, entered!: () => void;
  const held = new Promise<void>(done => { entered = done; });
  const gate = new Promise<void>(done => { release = done; });
  const owner = withKernelLock(`dependency-store:${resolve(store)}`, async () => { entered(); await gate; });
  await held;
  const privateInstall = vi.fn(() => install(cold));
  let finished = false;
  const consumers = Promise.all([
    prepareDependencyGeneration({ root: warm, store, cache, npm: '/unused', install: async () => { throw new Error('warm copy reinstalled'); } }),
    prepareDependencyGeneration({ root: cold, store, cache, npm: '/unused', install: privateInstall }),
    collectDependencyStore(store),
  ]).then(result => { finished = true; return result; });
  try {
    await vi.waitFor(() => expect(finished).toBe(true), { timeout: 1_000 });
    expect(await consumers).toEqual([[resolve(warm, 'node_modules')], [resolve(cold, 'node_modules')], []]);
    expect(privateInstall).toHaveBeenCalledOnce();
  } finally {
    release(); await owner; await consumers;
    await rm(root, { recursive: true, force: true });
  }
});

it.skipIf(spawnSync('bwrap', ['--ro-bind', '/', '/', 'true']).status !== 0)(
  'shares generations, seals writes, and builds independently after a lockfile change',
  async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'generation-proof-'));
    const npm = execFileSync('which', ['npm'], { encoding: 'utf8' }).trim();
    const store = resolve(root, 'store');
    const cache = resolve(root, 'cache');
    const a = resolve(root, 'a');
    const b = resolve(root, 'b');
    try {
      // Real npm tarballs avoid relying on a registry or mocked installation.
      const tarballs: string[] = [];
      for (const version of ['1.0.0', '2.0.0']) {
        const pkg = resolve(root, version);
        await mkdir(pkg);
        await writeFile(
          resolve(pkg, 'package.json'),
          JSON.stringify({ name: 'generation-proof', version, main: 'index.js' }),
        );
        await writeFile(resolve(pkg, 'index.js'), `module.exports=${JSON.stringify(version)};`);
        const result = JSON.parse(
          execFileSync(npm, ['pack', '--json'], { cwd: pkg, encoding: 'utf8' }),
        );
        tarballs.push(resolve(pkg, result[0].filename));
      }
      for (const cwd of [a, b]) {
        await mkdir(cwd);
        await writeFile(
          resolve(cwd, 'package.json'),
          JSON.stringify({
            name: 'consumer',
            version: '1.0.0',
            dependencies: { 'generation-proof': `file:${tarballs[0]}` },
            scripts: {
              build: `node -e "require('fs').writeFileSync('built',require('generation-proof'))"`,
            },
          }),
        );
        execFileSync(npm, ['install', '--package-lock-only', '--ignore-scripts', '--no-audit'], {
          cwd,
        });
        await prepareDependencyGeneration({ root: cwd, store, npm, cache });
      }
      const dep = 'node_modules/generation-proof/index.js';
      expect((await stat(resolve(a, dep))).ino).toBe((await stat(resolve(b, dep))).ino);
      const seal = (cwd: string, command: string, args: string[]) => {
        const wrapped = wrapAgentCommand({
          bwrapPath: '/usr/bin/bwrap',
          spec: {
            mode: 'edit',
            cwd,
            worktreePath: cwd,
            protectedPaths: [root],
            dependencyPaths: [resolve(cwd, 'node_modules')],
          },
          command,
          args,
        });
        return spawnSync(wrapped.command, wrapped.args, { encoding: 'utf8' });
      };
      const write = seal(a, 'sh', ['-c', `chmod u+w ${dep} && echo corrupted > ${dep}`]);
      expect(write.status, write.stderr).not.toBe(0);
      expect(await readFile(resolve(b, dep), 'utf8')).toContain('1.0.0');
      const path = await installDependencyNpmGuard(resolve(root, 'home'), npm, process.env.PATH!);
      const refusal = spawnSync('npm', ['install'], {
        cwd: a,
        env: { ...process.env, PATH: path },
        encoding: 'utf8',
      });
      expect(refusal.status).toBe(1);
      expect(refusal.stderr).toContain('--package-lock-only');
      const before = await dependencyFingerprint(a);
      const update = seal(a, resolve(root, 'home/dependency-bin/npm'), [
        'install',
        '--package-lock-only',
        `file:${tarballs[1]}`,
        '--no-audit',
      ]);
      expect(update.status, update.stderr).toBe(0);
      expect(await dependencyFingerprint(a)).not.toBe(before);
      await prepareDependencyGeneration({ root: a, store, npm, cache });
      expect((await stat(resolve(a, dep))).ino).not.toBe((await stat(resolve(b, dep))).ino);
      for (const [cwd, version] of [
        [a, '2.0.0'],
        [b, '1.0.0'],
      ]) {
        const build = seal(cwd!, npm, ['run', 'build']);
        expect(build.status, build.stderr).toBe(0);
        expect(await readFile(resolve(cwd!, 'built'), 'utf8')).toBe(version);
      }
      expect(await collectUnusedGenerations(store)).toEqual([]);
      await rm(resolve(b, 'node_modules'), { recursive: true });
      expect(await collectUnusedGenerations(store)).toHaveLength(1);
      expect(await readFile(resolve(a, dep), 'utf8')).toContain('2.0.0');
      await rm(resolve(a, 'node_modules'), { recursive: true });
      expect(await collectUnusedGenerations(store)).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  60_000,
);

it('a hung private install never holds the shared dependency store against another agent', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'generation-concurrent-'));
  const store = resolve(root, 'store');
  const cache = resolve(root, 'cache');
  const a = resolve(root, 'a'), b = resolve(root, 'b');
  const lock = JSON.stringify({ name: 'fixture', lockfileVersion: 3,
    packages: { '': { name: 'fixture' }, 'node_modules/proof': { version: '1.0.0' } } });
  const install = async (cwd: string) => {
    await mkdir(resolve(cwd, 'node_modules/proof'), { recursive: true });
    await writeFile(resolve(cwd, 'node_modules/proof/package.json'), '{"name":"proof","version":"1.0.0"}');
    await writeFile(resolve(cwd, 'node_modules/proof/index.js'), 'module.exports=1;');
    await writeFile(resolve(cwd, 'node_modules/.package-lock.json'), '{"packages":{"node_modules/proof":{}}}');
  };
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(done => { release = done; });
  const started = new Promise<void>(done => { entered = done; });
  for (const cwd of [a, b]) {
    await mkdir(cwd);
    await writeFile(resolve(cwd, 'package-lock.json'), lock);
  }
  const first = prepareDependencyGeneration({ root: a, store, cache, npm: '/unused',
    install: async () => { entered(); await gate; await install(a); } });
  await started;
  const second = prepareDependencyGeneration({ root: b, store, cache, npm: '/unused', install: () => install(b) });
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([second, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('another agent is blocked by the hung install')), 2_000);
    })]);
    expect(await readFile(resolve(b, 'node_modules/proof/index.js'), 'utf8')).toBe('module.exports=1;');
  } finally {
    if (timer) clearTimeout(timer);
    release();
    await Promise.all([first, second]);
    await rm(root, { recursive: true, force: true });
  }
});

// Reproduction REVIEW-DEPS-1: an exact-head tree has no mounted dependencies.
it('allows npm ci in a fresh private review tree while protecting mounted trees', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'review-guard-'));
  try {
    const home = resolve(root, 'home'), review = resolve(root, 'review');
    await mkdir(review);
    await writeFile(resolve(review, 'package.json'), '{"name":"review-proof","version":"1.0.0"}');
    const npm = execFileSync('which', ['npm'], { encoding: 'utf8' }).trim();
    execFileSync(npm, ['install', '--package-lock-only', '--ignore-scripts'], { cwd: review });
    const sealed = resolve(root, 'sealed');
    await mkdir(resolve(sealed, 'packages/nested/node_modules'), { recursive: true });
    const path = await installDependencyNpmGuard(home, npm, process.env.PATH!, [resolve(sealed, 'packages/nested/node_modules')]);
    for (const target of [sealed, resolve(sealed, 'packages/nested/node_modules')]) {
      const refusal = spawnSync('npm', ['ci', '--prefix', target], {
        env: { ...process.env, PATH: path }, encoding: 'utf8',
      });
      expect(refusal.status).toBe(1);
      expect(refusal.stderr).toContain('Beeline dependencies are read-only');
    }
    const result = spawnSync('npm', ['ci', '--prefix', review], {
      cwd: root, env: { ...process.env, PATH: path }, encoding: 'utf8',
    });
    expect(result.status, result.stderr).toBe(0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

import { it as m17_it, expect as m17_expect } from 'vitest';

import { mkdtemp as m17_mkdtemp, mkdir as m17_mkdir, writeFile as m17_writeFile, rm as m17_rm, symlink as m17_symlink } from 'node:fs/promises';

import { tmpdir as m17_tmpdir } from 'node:os';

import { resolve as m17_resolve } from 'node:path';

import { spawnSync as m17_spawnSync } from 'node:child_process';

import { extraDependencyRoots as m17_extraDependencyRoots, dependencyFingerprint as m17_dependencyFingerprint } from "./dependency-generation.js";
import { describe as mergedDescribe17 } from 'vitest';
mergedDescribe17("extra-dependencies.test.ts", () => {


m17_it('registers disposable copies without installing and replaces the session fingerprint', async () => {
  const root = await m17_mkdtemp(m17_resolve(m17_tmpdir(), 'extra-request-'));
  const script = m17_resolve('../../scripts/prepare-corner.mjs');
  try {
    const corner = m17_resolve(root, 'corner');
    const home = m17_resolve(root, 'home');
    await m17_mkdir(corner); await m17_mkdir(home);
    const before = await m17_dependencyFingerprint(corner, home);
    for (const extra of [m17_resolve(corner, '.verification'), m17_resolve(home, 'temp-rig')]) {
      await m17_mkdir(extra);
      // No package.json: an accidental npm ci would fail.
      const result = m17_spawnSync(process.execPath, [script, '--extra', extra], { cwd: corner, encoding: 'utf8' });
      m17_expect(result.status, result.stderr).toBe(0);
    }
    m17_expect(await m17_extraDependencyRoots(corner, home)).toHaveLength(2);
    m17_expect(await m17_dependencyFingerprint(corner, home)).not.toBe(before);
    await m17_rm(m17_resolve(home, 'temp-rig'), { recursive: true });
    m17_expect(await m17_extraDependencyRoots(corner, home)).toEqual([m17_resolve(corner, '.verification')]);
    const outside = m17_resolve(root, 'outside'); await m17_mkdir(outside);
    await m17_symlink(outside, m17_resolve(home, 'temp-rig'));
    await m17_expect(m17_extraDependencyRoots(corner, home)).rejects.toThrow('inside this corner');
  } finally { await m17_rm(root, { recursive: true, force: true }); }
});


m17_it('rejects redirected registries and oversized requests', async () => {
  const root = await m17_mkdtemp(m17_resolve(m17_tmpdir(), 'extra-invalid-'));
  try {
    const registry = m17_resolve(root, '.beeline-extra-dependencies');
    await m17_symlink(m17_tmpdir(), registry);
    await m17_expect(m17_extraDependencyRoots(root)).rejects.toThrow('Invalid extra dependency registry');
    await m17_rm(registry); await m17_mkdir(registry);
    await m17_writeFile(m17_resolve(registry, 'a'.repeat(64)), 'x'.repeat(8193));
    await m17_expect(m17_extraDependencyRoots(root)).rejects.toThrow('Invalid extra dependency request');
  } finally { await m17_rm(root, { recursive: true, force: true }); }
});
});
