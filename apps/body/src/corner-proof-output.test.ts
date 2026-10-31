import { mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { declareCornerProofOutput } from './corner-proof-output.js';
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
it('records proof ownership without granting retention after close', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'proof-label-')); roots.push(root);
  const proof = await declareCornerProofOutput(root, 'corner');
  expect(JSON.parse(await readFile(resolve(proof, 'manifest.json'), 'utf8')).cornerId).toBe('corner');
  await expect(declareCornerProofOutput(root, 'different')).rejects.toThrow('owner mismatch');
});
it('refuses linked proof directories', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'proof-link-')); roots.push(root);
  const external = await mkdtemp(resolve(tmpdir(), 'proof-external-')); roots.push(external);
  await symlink(external, resolve(root, '.beeline-proof'));
  await expect(declareCornerProofOutput(root, 'corner')).rejects.toThrow('ordinary');
});
