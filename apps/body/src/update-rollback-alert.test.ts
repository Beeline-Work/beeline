import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  reportUpdateRollback,
  queueUpdateRollbackAlert,
  updateRollbackAlertPath,
} from './update-rollback-alert.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('update rollback alert outbox', () => {
  it('retains rollback state locally without publishing a chat event', async () => {
    const runtimeDir = await mkdtemp(resolve(tmpdir(), 'beeline-update-alert-'));
    roots.push(runtimeDir);
    await queueUpdateRollbackAlert(runtimeDir, 'broken-release', 1_700_000_000_000);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(JSON.parse(await readFile(updateRollbackAlertPath(runtimeDir), 'utf8'))).toMatchObject({
      releaseId: 'broken-release',
    });

    await expect(
      reportUpdateRollback({ runtimeDir }),
    ).resolves.toBe(true);
    expect(error).toHaveBeenCalledWith(
      `[thin-core] UPDATE ROLLBACK: broken-release; durable operator record: ${updateRollbackAlertPath(runtimeDir)}`,
    );
    await expect(readFile(updateRollbackAlertPath(runtimeDir), 'utf8')).resolves.toContain('broken-release');
  });

  it('discards a legacy queued event instead of replaying its invalid shape', async () => {
    const runtimeDir = await mkdtemp(resolve(tmpdir(), 'beeline-update-alert-'));
    roots.push(runtimeDir);
    await writeFile(
      updateRollbackAlertPath(runtimeDir),
      `${JSON.stringify({
        version: 1,
        releaseId: 'broken-release',
        createdAt: 1_700_000_000_000,
        // Pre-retirement releases persisted the signed relay payload itself.
        event: { id: 'legacy-invalid-event', kind: 9, tags: [] },
      })}\n`,
    );
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(
      reportUpdateRollback({ runtimeDir }),
    ).resolves.toBe(true);

    expect(error).toHaveBeenCalledWith(
      `[thin-core] UPDATE ROLLBACK: broken-release; durable operator record: ${updateRollbackAlertPath(runtimeDir)}`,
    );
    await expect(readFile(updateRollbackAlertPath(runtimeDir), 'utf8')).resolves.toContain('legacy-invalid-event');
  });
});
