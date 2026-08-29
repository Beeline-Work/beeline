import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { Identity } from '@beeline/gate';
import type { NostrEvent } from '@beeline/nostr';
import { buildAgentMessage } from './activity.js';

export const UPDATE_ROLLBACK_ALERT_TEXT =
  'Beeline found that an update could not start a working agent session, restored the previous version automatically, and paused that broken release.';

interface PendingUpdateRollbackAlert {
  version: 1;
  releaseId: string;
  createdAt: number;
  event?: NostrEvent;
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

/**
 * Publish one durable, content-safe rollback notice. If HTTP completion is
 * ambiguous, the signed event stays in the outbox and the successor retries
 * the exact same id, so relay deduplication prevents duplicate messages.
 */
export async function publishPendingUpdateRollbackAlert(input: {
  runtimeDir: string;
  channelId: string;
  identity: Identity;
  publishEvent: (event: NostrEvent) => Promise<unknown>;
}): Promise<boolean> {
  let pending = await readUpdateRollbackAlert(input.runtimeDir);
  if (!pending) return false;
  if (!pending.event) {
    pending = {
      ...pending,
      event: buildAgentMessage(
        input.channelId,
        input.identity,
        UPDATE_ROLLBACK_ALERT_TEXT,
        undefined,
        [],
        [['t', 'beeline-update-rollback']],
        undefined,
        Math.floor(pending.createdAt / 1_000),
      ),
    };
    await writeAlert(input.runtimeDir, pending);
  }
  const event = pending.event;
  if (!event) throw new Error('update rollback alert event was not materialized');
  await input.publishEvent(event);
  await rm(updateRollbackAlertPath(input.runtimeDir), { force: true });
  return true;
}
