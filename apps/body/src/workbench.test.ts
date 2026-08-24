import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  WORKBENCH_ENV,
  prepareSessionWorkbench,
  sweepSessionWorkbench,
  workbenchInstructions,
} from './workbench.js';
import { isAgentWorkbenchWritePermissionRequest } from './session-sandbox.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function workbench() {
  const root = await mkdtemp(join(tmpdir(), 'beeline-workbench-'));
  roots.push(root);
  return prepareSessionWorkbench(join(root, 'agent-private'));
}

describe('Room workbench capability', () => {
  it('creates a named private scratch directory and advertises the boundary rule', async () => {
    const prepared = await workbench();
    expect((await stat(prepared.dir)).isDirectory()).toBe(true);
    expect(prepared.dir).toMatch(/agent-private\/workbench$/);

    for (const mode of ['readonly', 'edit'] as const) {
      const prompt = workbenchInstructions(prepared, mode);
      expect(prompt).toContain(prepared.dir);
      expect(prompt).toContain(WORKBENCH_ENV);
      expect(prompt).toContain('NOT the repository');
      expect(prompt).toContain('Will this produce a repository change someone should review?');
      expect(prompt).toContain('Never open a corner merely to serve a file or build a tunnel.');
      expect(prompt).toContain('single-file v1');
      expect(prompt.toLowerCase()).toContain('network access');
      expect(prompt).toContain(mode === 'edit' ? 'this corner' : 'this Room');
    }
  });

  it('allows only absolute, path-pinned file operations inside the workbench', async () => {
    const prepared = await workbench();
    const edit = (path: string) => ({
      toolCall: { kind: 'edit', title: 'Write', rawInput: { file_path: path } },
    });
    expect(
      isAgentWorkbenchWritePermissionRequest(
        edit(join(prepared.dir, 'preview.html')),
        prepared.dir,
      ),
    ).toBe(true);
    expect(isAgentWorkbenchWritePermissionRequest(edit('preview.html'), prepared.dir)).toBe(false);
    expect(
      isAgentWorkbenchWritePermissionRequest(
        edit(join(prepared.dir, '../repo/file.ts')),
        prepared.dir,
      ),
    ).toBe(false);
    expect(
      isAgentWorkbenchWritePermissionRequest(
        { toolCall: { kind: 'execute', rawInput: { command: `echo x > ${prepared.dir}/x` } } },
        prepared.dir,
      ),
    ).toBe(false);
  });
});

describe('workbench garbage collection', () => {
  it('evicts TTL-expired files and then oldest files until the size cap is met', async () => {
    const prepared = await workbench();
    const expired = join(prepared.dir, 'expired.txt');
    const oldest = join(prepared.dir, 'oldest.txt');
    const newest = join(prepared.dir, 'newest.txt');
    await writeFile(expired, 'old');
    await writeFile(oldest, '1234');
    await writeFile(newest, '5678');
    const now = Date.now();
    await utimes(expired, new Date(now - 8_000), new Date(now - 8_000));
    await utimes(oldest, new Date(now - 2_000), new Date(now - 2_000));
    await utimes(newest, new Date(now - 1_000), new Date(now - 1_000));

    const result = await sweepSessionWorkbench(prepared, {
      now,
      ttlMs: 7_000,
      maxBytes: 4,
      maxEntries: 20,
      maxDeletes: 20,
    });

    expect(result).toMatchObject({ scannedFiles: 3, deletedFiles: 2, bytesAfter: 4 });
    await expect(readFile(expired)).rejects.toThrow();
    await expect(readFile(oldest)).rejects.toThrow();
    await expect(readFile(newest, 'utf8')).resolves.toBe('5678');
  });

  it('bounds each pass and reports when more entries remain', async () => {
    const prepared = await workbench();
    for (let index = 0; index < 5; index += 1) {
      await writeFile(join(prepared.dir, `${index}.txt`), 'x');
    }
    const result = await sweepSessionWorkbench(prepared, {
      maxEntries: 2,
      maxDeletes: 1,
      maxBytes: 0,
    });
    expect(result.truncated).toBe(true);
    expect(result.scannedFiles).toBe(2);
    expect(result.deletedFiles).toBe(1);
  });
});
