import { lstat, mkdir, open, readdir, rename, rm, stat, statfs } from 'node:fs/promises';
import { resolve } from 'node:path';

export const SHARED_ASSET_FREE_FLOOR_BYTES = 2 * 1024 ** 3;
export const PRIVATE_RECOVERY_RESERVE_BYTES = 128 * 1024 ** 2;

export class SharedAssetCapacityError extends Error {
  constructor() { super('insufficient free space for Workspace shared assets'); }
}

export function privateRecoveryReservePath(supervisorRoot: string): string {
  return resolve(supervisorRoot, 'beeline/helper/private-recovery-reserve');
}

export async function availableBytes(path: string): Promise<bigint> {
  const fs = await statfs(path, { bigint: true });
  return fs.bavail * fs.bsize;
}

export async function apparentTreeBytes(path: string): Promise<number> {
  const info = await lstat(path);
  if (!info.isDirectory()) return info.isFile() ? info.size : 0;
  let bytes = 0;
  for (const entry of await readdir(path)) bytes += await apparentTreeBytes(resolve(path, entry));
  return bytes;
}

/** Allocate real blocks before optional shared downloads can consume the disk. */
export async function ensurePrivateRecoveryReserve(
  supervisorRoot: string,
  bytes: number = PRIVATE_RECOVERY_RESERVE_BYTES,
): Promise<void> {
  const target = privateRecoveryReservePath(supervisorRoot);
  await mkdir(resolve(target, '..'), { recursive: true, mode: 0o700 });
  if ((await stat(target).catch(() => undefined))?.size === bytes) return;
  const lock = `${target}.lock`;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { await mkdir(lock, { mode: 0o700 }); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (attempt === 99) throw new Error('timed out allocating private recovery reserve');
      await new Promise((done) => setTimeout(done, 100));
    }
  }
  const stage = `${target}.${process.pid}.tmp`;
  try {
    if ((await stat(target).catch(() => undefined))?.size === bytes) return;
    const file = await open(stage, 'wx', 0o600);
    try {
      const block = Buffer.alloc(Math.min(bytes, 1024 * 1024));
      for (let written = 0; written < bytes;) {
        const result = await file.write(block, 0, Math.min(block.length, bytes - written));
        written += result.bytesWritten;
      }
      await file.sync();
    } finally { await file.close(); }
    await rename(stage, target);
  } finally {
    await rm(stage, { force: true });
    await rm(lock, { recursive: true, force: true });
  }
}

export async function releasePrivateRecoveryReserve(supervisorRoot: string): Promise<boolean> {
  const target = privateRecoveryReservePath(supervisorRoot);
  if (!(await stat(target).catch(() => undefined))) return false;
  await rm(target, { force: true });
  return true;
}

/** Release capacity before an external harness's next private transcript write. */
export async function checkPrivateRecoveryReserve(
  supervisorRoot: string,
  freeBytes: () => Promise<bigint> = () => availableBytes(supervisorRoot),
): Promise<boolean> {
  const reserve = await stat(privateRecoveryReservePath(supervisorRoot)).catch(() => undefined);
  if (!reserve) return false;
  if ((await freeBytes()) >= BigInt(reserve.size + 256 * 1024 ** 2)) return false;
  return releasePrivateRecoveryReserve(supervisorRoot);
}

export function monitorPrivateRecoveryReserve(supervisorRoot: string): () => void {
  const timer = setInterval(() => {
    void checkPrivateRecoveryReserve(supervisorRoot).catch((error) =>
      console.warn('[helper] private recovery reserve check failed:', error));
  }, 500);
  timer.unref();
  return () => clearInterval(timer);
}

/** A floor blocks new shared writers and releases the reserve for private state. */
export async function admitSharedAssets(
  supervisorRoot: string,
  estimatedBytes = 0,
  options: { floorBytes?: number; reserveBytes?: number; freeBytes?: () => Promise<bigint> } = {},
): Promise<boolean> {
  const floor = options.floorBytes ?? SHARED_ASSET_FREE_FLOOR_BYTES;
  const free = options.freeBytes ?? (() => availableBytes(supervisorRoot));
  const current = await free();
  if (current < BigInt(floor + estimatedBytes)) {
    if (current < BigInt(floor)) await releasePrivateRecoveryReserve(supervisorRoot);
    return false;
  }
  try {
    await ensurePrivateRecoveryReserve(supervisorRoot, options.reserveBytes);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOSPC') return false;
    throw error;
  }
  return (await free()) >= BigInt(floor + estimatedBytes);
}

export async function releaseReserveOnEnospc(supervisorRoot: string, error: unknown): Promise<void> {
  if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOSPC')
    await releasePrivateRecoveryReserve(supervisorRoot);
}
