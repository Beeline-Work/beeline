import { it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { extraDependencyRoots, dependencyFingerprint } from './dependency-generation.js';

it('registers disposable copies without installing and replaces the session fingerprint', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'extra-request-'));
  const script = resolve('../../scripts/prepare-corner.mjs');
  try {
    const corner = resolve(root, 'corner');
    const home = resolve(root, 'home');
    await mkdir(corner); await mkdir(home);
    const before = await dependencyFingerprint(corner, home);
    for (const extra of [resolve(corner, '.verification'), resolve(home, 'temp-rig')]) {
      await mkdir(extra);
      // No package.json: an accidental npm ci would fail.
      const result = spawnSync(process.execPath, [script, '--extra', extra], { cwd: corner, encoding: 'utf8' });
      expect(result.status, result.stderr).toBe(0);
    }
    expect(await extraDependencyRoots(corner, home)).toHaveLength(2);
    expect(await dependencyFingerprint(corner, home)).not.toBe(before);
    await rm(resolve(home, 'temp-rig'), { recursive: true });
    expect(await extraDependencyRoots(corner, home)).toEqual([resolve(corner, '.verification')]);
    const outside = resolve(root, 'outside'); await mkdir(outside);
    await symlink(outside, resolve(home, 'temp-rig'));
    await expect(extraDependencyRoots(corner, home)).rejects.toThrow('inside this corner');
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('rejects redirected registries and oversized requests', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'extra-invalid-'));
  try {
    const registry = resolve(root, '.beeline-extra-dependencies');
    await symlink(tmpdir(), registry);
    await expect(extraDependencyRoots(root)).rejects.toThrow('Invalid extra dependency registry');
    await rm(registry); await mkdir(registry);
    await writeFile(resolve(registry, 'a'.repeat(64)), 'x'.repeat(8193));
    await expect(extraDependencyRoots(root)).rejects.toThrow('Invalid extra dependency request');
  } finally { await rm(root, { recursive: true, force: true }); }
});
