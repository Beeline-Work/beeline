import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { newIdentity } from '@beeline/gate';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  publishPendingUpdateRollbackAlert,
  queueUpdateRollbackAlert,
  UPDATE_ROLLBACK_ALERT_TEXT,
  updateRollbackAlertPath,
} from './update-rollback-alert.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('update rollback alert outbox', () => {
  it('retries one exact signed plain-language event after ambiguous publish failure', async () => {
    const runtimeDir = await mkdtemp(resolve(tmpdir(), 'beeline-update-alert-'));
    roots.push(runtimeDir);
    const identity = newIdentity('rollback-alert');
    await queueUpdateRollbackAlert(runtimeDir, 'broken-release', 1_700_000_000_000);
    const events: Array<{ id: string; content: string }> = [];
    const publishEvent = vi.fn(async (event: { id: string; content: string }) => {
      events.push({ id: event.id, content: event.content });
      if (events.length === 1) throw new Error('ambiguous relay response');
    });

    await expect(
      publishPendingUpdateRollbackAlert({
        runtimeDir,
        channelId: 'room-1',
        identity,
        publishEvent,
      }),
    ).rejects.toThrow('ambiguous relay response');
    expect(JSON.parse(await readFile(updateRollbackAlertPath(runtimeDir), 'utf8'))).toMatchObject({
      releaseId: 'broken-release',
      event: { id: events[0]!.id, content: UPDATE_ROLLBACK_ALERT_TEXT },
    });

    await expect(
      publishPendingUpdateRollbackAlert({
        runtimeDir,
        channelId: 'room-1',
        identity,
        publishEvent,
      }),
    ).resolves.toBe(true);
    expect(events).toEqual([
      { id: events[0]!.id, content: UPDATE_ROLLBACK_ALERT_TEXT },
      { id: events[0]!.id, content: UPDATE_ROLLBACK_ALERT_TEXT },
    ]);
    await expect(readFile(updateRollbackAlertPath(runtimeDir), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
});
