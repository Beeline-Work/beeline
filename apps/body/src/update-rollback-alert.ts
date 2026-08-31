import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

interface UpdateRollbackAlert {
  version: 1;
  releaseId: string;
  createdAt: number;
}

export function updateRollbackAlertPath(runtimeDir: string): string {
  return resolve(runtimeDir, 'update-rollback-alert.json');
}

async function writeAlert(runtimeDir: string, alert: UpdateRollbackAlert): Promise<void> {
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
): Promise<UpdateRollbackAlert | undefined> {
  try {
    const value = JSON.parse(
      await readFile(updateRollbackAlertPath(runtimeDir), 'utf8'),
    ) as UpdateRollbackAlert;
    if (value.version !== 1 || typeof value.releaseId !== 'string') return undefined;
    return value;
  } catch {
    return undefined;
  }
}

/**
 * Report, but never consume, the operator-local rollback record. This is the
 * loud durable fact for a release that was reverted before it served a turn.
 * We intentionally do not revive daemon diagnostic chat for it.
 */
export async function reportUpdateRollback(input: {
  runtimeDir: string;
}): Promise<boolean> {
  const pending = await readUpdateRollbackAlert(input.runtimeDir);
  if (!pending) return false;
  console.error(
    `[thin-core] UPDATE ROLLBACK: ${pending.releaseId}; durable operator record: ` +
      updateRollbackAlertPath(input.runtimeDir),
  );
  return true;
}
