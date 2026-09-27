import { open, readFile, stat, unlink, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { beelineInstallLayout } from './self-update.js';

const STALE_MS = 4 * 60_000;
const WAIT_MS = 3 * 60_000;

export function adapterInstallLockPath(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const layout = beelineInstallLayout(env);
  return layout && resolve(layout.releasesRoot, '.state', 'adapter-install.lock');
}

async function waitForUnlock(path: string, deadline: number): Promise<void> {
  for (;;) {
    const current = await stat(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (!current) return;
    if (Date.now() - current.mtimeMs > STALE_MS) {
      // Recheck the inode before takeover so a newly acquired lock is not
      // mistaken for the stale file observed above.
      const latest = await stat(path).catch(() => undefined);
      if (latest && latest.ino === current.ino && Date.now() - latest.mtimeMs > STALE_MS) {
        await unlink(path).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error;
        });
      }
      continue;
    }
    if (Date.now() >= deadline) throw new Error('timed out waiting for adapter install lock');
    await new Promise((done) => setTimeout(done, 100));
  }
}

export async function withAdapterInstallLock<T>(
  work: () => Promise<T> | T,
  env: NodeJS.ProcessEnv = process.env,
  waitMs = WAIT_MS,
): Promise<T> {
  const path = adapterInstallLockPath(env);
  if (!path) return await work();
  await mkdir(dirname(path), { recursive: true });
  const deadline = Date.now() + waitMs;
  const token = `${process.pid}:${Date.now()}:${Math.random()}`;
  for (;;) {
    try {
      const handle = await open(path, 'wx');
      try {
        await handle.writeFile(token);
      } finally {
        await handle.close();
      }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      await waitForUnlock(path, deadline);
    }
  }
  try {
    return await work();
  } finally {
    if ((await readFile(path, 'utf8').catch(() => undefined)) === token) await unlink(path);
  }
}
