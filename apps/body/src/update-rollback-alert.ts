import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

interface UpdateRollbackAlert {
  version: 1;
  releaseId: string;
  createdAt: number;
}

const REPORT_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Per-process, per-runtimeDir throttle state for the loud log line. A fresh
 * process always starts empty, so the first drain after start still logs
 * immediately; every drain after that within the hour is silent.
 */
const lastLogged = new Map<string, { releaseId: string; loggedAt: number }>();

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
 * Delete the durable alert unconditionally (if one exists). Called at the
 * moment this process itself proves a release healthy through the update
 * gate — a fresh confirmation supersedes any stale rollback record,
 * whichever release it names.
 */
export async function clearUpdateRollbackAlert(runtimeDir: string): Promise<boolean> {
  const existing = await readUpdateRollbackAlert(runtimeDir);
  if (!existing) return false;
  await unlink(updateRollbackAlertPath(runtimeDir)).catch(() => undefined);
  lastLogged.delete(runtimeDir);
  return true;
}

/**
 * Clear the durable alert only if the release it names is the one this
 * daemon just confirmed loaded/active. Meant to run once at startup, before
 * this process has had a chance to queue an alert of its own — otherwise a
 * process that itself just rolled back would immediately "confirm" and
 * erase the record it just wrote.
 */
export async function clearUpdateRollbackAlertIfConfirmed(
  runtimeDir: string,
  loadedRelease: string | undefined,
): Promise<boolean> {
  if (!loadedRelease) return false;
  const existing = await readUpdateRollbackAlert(runtimeDir);
  if (!existing || existing.releaseId !== loadedRelease) return false;
  await unlink(updateRollbackAlertPath(runtimeDir)).catch(() => undefined);
  lastLogged.delete(runtimeDir);
  return true;
}

/**
 * Report, but never consume, the operator-local rollback record. This is the
 * loud durable fact for a release that was reverted before it served a turn.
 * We intentionally do not revive daemon diagnostic chat for it. Logs once
 * per process start, then at most once per hour while the alert remains
 * genuinely pending — clearing (see `clearUpdateRollbackAlert` and
 * `clearUpdateRollbackAlertIfConfirmed`) is the only thing that stops it
 * sooner.
 */
export async function reportUpdateRollback(input: {
  runtimeDir: string;
  now?: number;
}): Promise<boolean> {
  const pending = await readUpdateRollbackAlert(input.runtimeDir);
  if (!pending) {
    lastLogged.delete(input.runtimeDir);
    return false;
  }
  const now = input.now ?? Date.now();
  const last = lastLogged.get(input.runtimeDir);
  if (last && last.releaseId === pending.releaseId && now - last.loggedAt < REPORT_INTERVAL_MS) {
    return false;
  }
  console.error(
    `[thin-core] UPDATE ROLLBACK: ${pending.releaseId}; durable operator record: ` +
      updateRollbackAlertPath(input.runtimeDir),
  );
  lastLogged.set(input.runtimeDir, { releaseId: pending.releaseId, loggedAt: now });
  return true;
}
