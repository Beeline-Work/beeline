import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  reportUpdateRollback,
  queueUpdateRollbackAlert,
  updateRollbackAlertPath,
  clearUpdateRollbackAlert,
  clearUpdateRollbackAlertIfConfirmed,
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

  describe('clearing a resolved alert', () => {
    it('clears when the release it names is the one this daemon just confirmed loaded', async () => {
      const runtimeDir = await mkdtemp(resolve(tmpdir(), 'beeline-update-alert-'));
      roots.push(runtimeDir);
      // The literal incident: a release that failed a successor probe on
      // one attempt later became the active release fleet-wide.
      await queueUpdateRollbackAlert(runtimeDir, 'd7107967', 1_700_000_000_000);

      await expect(
        clearUpdateRollbackAlertIfConfirmed(runtimeDir, 'd7107967'),
      ).resolves.toBe(true);
      await expect(readFile(updateRollbackAlertPath(runtimeDir), 'utf8')).rejects.toThrow();

      const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      await expect(reportUpdateRollback({ runtimeDir })).resolves.toBe(false);
      expect(error).not.toHaveBeenCalled();
    });

    it('does not clear when a different release is merely loaded (a plain rollback restart)', async () => {
      const runtimeDir = await mkdtemp(resolve(tmpdir(), 'beeline-update-alert-'));
      roots.push(runtimeDir);
      await queueUpdateRollbackAlert(runtimeDir, 'broken-release', 1_700_000_000_000);

      await expect(
        clearUpdateRollbackAlertIfConfirmed(runtimeDir, 'previous-good-release'),
      ).resolves.toBe(false);
      await expect(readFile(updateRollbackAlertPath(runtimeDir), 'utf8')).resolves.toContain(
        'broken-release',
      );
    });

    it('clears unconditionally once a fresh update gate pass confirms the daemon healthy again', async () => {
      const runtimeDir = await mkdtemp(resolve(tmpdir(), 'beeline-update-alert-'));
      roots.push(runtimeDir);
      await queueUpdateRollbackAlert(runtimeDir, 'broken-release', 1_700_000_000_000);

      await expect(clearUpdateRollbackAlert(runtimeDir)).resolves.toBe(true);
      await expect(readFile(updateRollbackAlertPath(runtimeDir), 'utf8')).rejects.toThrow();
      // Idempotent: nothing left to clear the second time.
      await expect(clearUpdateRollbackAlert(runtimeDir)).resolves.toBe(false);
    });
  });

  describe('log cadence', () => {
    it('logs once per process start, then at most once per hour while pending', async () => {
      const runtimeDir = await mkdtemp(resolve(tmpdir(), 'beeline-update-alert-'));
      roots.push(runtimeDir);
      await queueUpdateRollbackAlert(runtimeDir, 'broken-release', 1_700_000_000_000);
      const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

      const t0 = 1_700_000_100_000;
      await expect(reportUpdateRollback({ runtimeDir, now: t0 })).resolves.toBe(true);
      expect(error).toHaveBeenCalledTimes(1);

      // Repeated drains a few seconds apart (the real ~5s cadence) stay silent.
      for (let i = 1; i <= 5; i += 1) {
        await expect(
          reportUpdateRollback({ runtimeDir, now: t0 + i * 5_000 }),
        ).resolves.toBe(false);
      }
      expect(error).toHaveBeenCalledTimes(1);

      // Just under an hour later: still silent.
      await expect(
        reportUpdateRollback({ runtimeDir, now: t0 + 59 * 60_000 }),
      ).resolves.toBe(false);
      expect(error).toHaveBeenCalledTimes(1);

      // An hour later: loud again, exactly once.
      const t1 = t0 + 60 * 60_000 + 1;
      await expect(reportUpdateRollback({ runtimeDir, now: t1 })).resolves.toBe(true);
      expect(error).toHaveBeenCalledTimes(2);
      await expect(reportUpdateRollback({ runtimeDir, now: t1 + 5_000 })).resolves.toBe(false);
      expect(error).toHaveBeenCalledTimes(2);
    });

    it('logs immediately for a newly queued alert even inside another alert’s throttle window', async () => {
      const runtimeDir = await mkdtemp(resolve(tmpdir(), 'beeline-update-alert-'));
      roots.push(runtimeDir);
      const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

      await queueUpdateRollbackAlert(runtimeDir, 'release-a', 1_700_000_000_000);
      await expect(
        reportUpdateRollback({ runtimeDir, now: 1_700_000_000_000 }),
      ).resolves.toBe(true);
      expect(error).toHaveBeenCalledTimes(1);

      await queueUpdateRollbackAlert(runtimeDir, 'release-b', 1_700_000_001_000);
      await expect(
        reportUpdateRollback({ runtimeDir, now: 1_700_000_001_000 }),
      ).resolves.toBe(true);
      expect(error).toHaveBeenCalledTimes(2);
    });
  });
});
