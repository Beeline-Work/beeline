import { execFile } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { writePrivateFileAtomically } from './atomic-private-file.js';
import { ordinaryDirectory, reclaimWholeStorageObject, storageObjectInUse, type WholeStorageOptions } from './helper-storage.js';

const exec = promisify(execFile);
const RETENTION_MS = 7 * 86400_000;

export async function cornerProofRetentionActive(checkout: string, cornerId: string, archivedAt: number | undefined, now = Date.now()): Promise<boolean> {
  try {
    const manifest = JSON.parse(await readFile(resolve(checkout, '.beeline-proof/manifest.json'), 'utf8'));
    return manifest.version === 1 && manifest.cornerId === cornerId && manifest.disposable === true &&
      (!Number.isFinite(archivedAt) || now - archivedAt! < RETENTION_MS);
  } catch { return false; }
}

/** Only this explicit declaration makes proof output disposable. */
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

/** The first observed archive starts retention; filesystem times cannot shorten it. */
export async function reclaimCornerProofOutput(checkout: string, cornerId: string, archivedAt: number, options: WholeStorageOptions = {}): Promise<void> {
  if (!Number.isFinite(archivedAt) || (options.now ?? Date.now()) - archivedAt < RETENTION_MS) return;
  const path = resolve(checkout, '.beeline-proof');
  if (!await ordinaryDirectory(path)) return;
  const valid = async () => {
    try {
      if (await storageObjectInUse(checkout, options)) return false;
      const manifest = JSON.parse(await readFile(resolve(path, 'manifest.json'), 'utf8'));
      if (manifest.version !== 1 || manifest.cornerId !== cornerId || manifest.disposable !== true) return false;
      await exec('git', ['-C', checkout, 'check-ignore', '-q', '--', '.beeline-proof/']);
      return !(await exec('git', ['-C', checkout, 'ls-files', '-z', '--', '.beeline-proof'])).stdout;
    } catch { return false; }
  };
  await reclaimWholeStorageObject(path, true, { ...options, beforeRemove: valid });
}
