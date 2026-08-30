import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  publishPendingUpdateRollbackAlert,
  queueUpdateRollbackAlert,
  updateRollbackAlertPath,
} from './update-rollback-alert.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('update rollback alert outbox', () => {
  it('drains rollback state locally without publishing a chat event', async () => {
    const runtimeDir = await mkdtemp(resolve(tmpdir(), 'beeline-update-alert-'));
    roots.push(runtimeDir);
    await queueUpdateRollbackAlert(runtimeDir, 'broken-release', 1_700_000_000_000);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(JSON.parse(await readFile(updateRollbackAlertPath(runtimeDir), 'utf8'))).toMatchObject({
      releaseId: 'broken-release',
    });

    await expect(
      publishPendingUpdateRollbackAlert({ runtimeDir }),
    ).resolves.toBe(true);
    expect(error).toHaveBeenCalledWith(
      '[thin-core] update rollback retained as operator state: broken-release',
    );
    await expect(readFile(updateRollbackAlertPath(runtimeDir), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
});
