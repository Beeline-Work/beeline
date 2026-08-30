import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

interface PendingUpdateRollbackAlert {
  version: 1;
  releaseId: string;
  createdAt: number;
}

export function updateRollbackAlertPath(runtimeDir: string): string {
  return resolve(runtimeDir, 'update-rollback-alert.json');
}

async function writeAlert(runtimeDir: string, alert: PendingUpdateRollbackAlert): Promise<void> {
  const path = updateRollbackAlertPath(runtimeDir);
  const staged = `${path}.${process.pid}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(staged, `${JSON.stringify(alert, null, 2)}\n`, { mode: 0o600 });
  await rename(staged, path);
}

export async function queueUpdateRollbackAlert(
  runtimeDir: string,
  releaseId: string,
  now = Date.now(),
): Promise<void> {
  const existing = await readUpdateRollbackAlert(runtimeDir);
  if (existing?.releaseId === releaseId) return;
  await writeAlert(runtimeDir, { version: 1, releaseId, createdAt: now });
}

async function readUpdateRollbackAlert(
  runtimeDir: string,
): Promise<PendingUpdateRollbackAlert | undefined> {
  try {
    const value = JSON.parse(
      await readFile(updateRollbackAlertPath(runtimeDir), 'utf8'),
    ) as PendingUpdateRollbackAlert;
    if (value.version !== 1 || typeof value.releaseId !== 'string') return undefined;
    return value;
  } catch {
    return undefined;
  }
}

/** Drain the operator-local rollback record without adding daemon prose to chat. */
export async function publishPendingUpdateRollbackAlert(input: {
  runtimeDir: string;
}): Promise<boolean> {
  const pending = await readUpdateRollbackAlert(input.runtimeDir);
  if (!pending) return false;
  console.error(`[thin-core] update rollback retained as operator state: ${pending.releaseId}`);
  await rm(updateRollbackAlertPath(input.runtimeDir), { force: true });
  return true;
}
