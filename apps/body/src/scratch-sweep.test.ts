import { existsSync, mkdirSync, mkdtempSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_SCRATCH_TTL_HOURS,
  discoverAttachScratchRoots,
  scratchTtlMs,
  sweepAttachScratchRoots,
} from './scratch-sweep.js';

const HOUR_MS = 60 * 60 * 1000;

function touch(path: string, ageMs: number, now: number): void {
  const at = new Date(now - ageMs);
  utimesSync(path, at, at);
}

describe('scratch-sweep', () => {
  afterEach(() => {
    // Temp dirs are disposable; no cleanup needed on tmpdir.
  });

  it('defaults the TTL to 72 hours and honors the env override', () => {
    expect(scratchTtlMs({})).toBe(DEFAULT_SCRATCH_TTL_HOURS * HOUR_MS);
    expect(scratchTtlMs({ BEELINE_SCRATCH_TTL_HOURS: '2' })).toBe(2 * HOUR_MS);
    expect(scratchTtlMs({ BEELINE_SCRATCH_TTL_HOURS: 'not-a-number' })).toBe(
      DEFAULT_SCRATCH_TTL_HOURS * HOUR_MS,
    );
  });

  it('discovers every rooms/*/agent-home directory and skips a symlinked one', async () => {
    const runtimeDir = mkdtempSync(join(tmpdir(), 'scratch-runtime-'));
    const roomA = resolve(runtimeDir, 'rooms', 'room-a', 'agent-home');
    mkdirSync(roomA, { recursive: true });
    const roomB = resolve(runtimeDir, 'rooms', 'room-b');
    mkdirSync(roomB, { recursive: true });
    const realHome = resolve(runtimeDir, 'elsewhere-home');
    mkdirSync(realHome, { recursive: true });
    symlinkSync(realHome, resolve(roomB, 'agent-home'));

    const roots = await discoverAttachScratchRoots(runtimeDir);
    expect(roots).toEqual([roomA]);
  });

  it('removes only old regular files, never a symlink, never a harness-state sibling, and prunes empty dirs', async () => {
    const now = Date.now();
    const root = mkdtempSync(join(tmpdir(), 'scratch-root-'));

    // Old file directly under the scratch root (e.g. write_scratch_file).
    const oldLoose = join(root, 'old-loose.txt');
    writeFileSync(oldLoose, 'stale');
    touch(oldLoose, 73 * HOUR_MS, now);

    // Fresh file under tmp/beeline-attachments (a recent delivered attachment).
    const tmpDir = join(root, 'tmp', 'beeline-attachments', 'msg-1');
    mkdirSync(tmpDir, { recursive: true });
    const freshFile = join(tmpDir, 'photo.png');
    writeFileSync(freshFile, 'fresh');
    touch(freshFile, 1 * HOUR_MS, now);

    // Old file under tmp that should be swept, leaving its parent dir empty
    // and prunable.
    const oldTmpDir = join(root, 'tmp', 'beeline-attachments', 'msg-old');
    mkdirSync(oldTmpDir, { recursive: true });
    const oldTmpFile = join(oldTmpDir, 'stale.png');
    writeFileSync(oldTmpFile, 'stale');
    touch(oldTmpFile, 100 * HOUR_MS, now);

    // A symlink inside tmp must never be followed or deleted as a stale
    // entry, regardless of what its target looks like.
    const symlinkTarget = join(root, 'tmp', 'link-target.txt');
    writeFileSync(symlinkTarget, 'target');
    const symlinkPath = join(root, 'tmp', 'a-symlink.txt');
    symlinkSync(symlinkTarget, symlinkPath);

    // A nested empty directory under tmp with no files at all.
    const emptyNested = join(root, 'tmp', 'empty-nested', 'deeper');
    mkdirSync(emptyNested, { recursive: true });

    // Harness state siblings: old files that must NEVER be listed or removed,
    // even though their mtime alone would qualify them.
    const harnessStateFile = join(root, 'claude', 'session.json');
    mkdirSync(join(root, 'claude'), { recursive: true });
    writeFileSync(harnessStateFile, '{}');
    touch(harnessStateFile, 500 * HOUR_MS, now);
    const homeCredential = join(root, 'user', '.gitconfig');
    mkdirSync(join(root, 'user'), { recursive: true });
    writeFileSync(homeCredential, '[user]\n');
    touch(homeCredential, 500 * HOUR_MS, now);

    const summary = await sweepAttachScratchRoots([root], 72 * HOUR_MS, now);

    expect(summary.removedFiles).toBe(2);
    expect(existsSync(oldLoose)).toBe(false);
    expect(existsSync(oldTmpFile)).toBe(false);
    expect(existsSync(oldTmpDir)).toBe(false);
    expect(existsSync(freshFile)).toBe(true);
    expect(existsSync(symlinkPath)).toBe(true);
    expect(existsSync(symlinkTarget)).toBe(true);
    expect(existsSync(emptyNested)).toBe(false);
    expect(existsSync(join(root, 'tmp', 'empty-nested'))).toBe(false);
    expect(existsSync(harnessStateFile)).toBe(true);
    expect(existsSync(homeCredential)).toBe(true);
  });
});
