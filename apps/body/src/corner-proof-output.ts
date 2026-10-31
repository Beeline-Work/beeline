import { mkdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { writePrivateFileAtomically } from './atomic-private-file.js';
import { ordinaryDirectory } from './helper-storage.js';

/** Label proof output with its corner; this never exempts it from deletion on close. */
export async function declareCornerProofOutput(checkout: string, cornerId: string): Promise<string> {
  if (!/^[a-zA-Z0-9-]{1,80}$/.test(cornerId)) throw new Error('invalid proof owner');
  const path = resolve(checkout, '.beeline-proof');
  await mkdir(path, { recursive: true, mode: 0o700 });
  if (!await ordinaryDirectory(path)) throw new Error('proof output must be an ordinary directory');
  const manifest = resolve(path, 'manifest.json');
  const existing = await readFile(manifest, 'utf8').then(JSON.parse, () => undefined);
  if (existing && (existing.version !== 1 || existing.cornerId !== cornerId)) throw new Error('proof output owner mismatch');
  if (!existing) await writePrivateFileAtomically(manifest, JSON.stringify({ version: 1, cornerId, disposable: true }));
  return path;
}

