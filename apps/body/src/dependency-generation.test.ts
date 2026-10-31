import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { it, expect } from 'vitest';
import { wrapAgentCommand } from './bwrap-sandbox.js';
import {
  prepareDependencyGeneration,
  installDependencyNpmGuard,
  collectUnusedGenerations,
  dependencyFingerprint,
} from './dependency-generation.js';

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
