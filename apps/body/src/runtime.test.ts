/**
 * `convergeRuntimeRecordFileModes` — see `runtime.ts`. File modes cannot
 * isolate agents that share one Unix account (that is `bwrap-sandbox.ts`'s
 * job); this is the narrower defense-in-depth convergence for an existing
 * runtime record that predates `writeRuntimeRecord`'s private modes.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { convergeRuntimeRecordFileModes } from './runtime.js';

describe('convergeRuntimeRecordFileModes', () => {
  const roots: string[] = [];
  afterEach(() => {
    while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
  });

  it('tightens a pre-existing record and its directory to private modes', async () => {
    const root = mkdtempSync(resolve(tmpdir(), 'runtime-modes-'));
    roots.push(root);
    const directory = resolve(root, 'beeline', 'agents', 'a'.repeat(64));
    mkdirSync(directory, { recursive: true, mode: 0o755 });
    const path = resolve(directory, 'runtime.json');
    writeFileSync(path, '{}\n', { mode: 0o644 });

    await convergeRuntimeRecordFileModes(path);

    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(directory).mode & 0o777).toBe(0o700);
  });

  it('is a no-op, not a throw, when the record does not exist yet', async () => {
    const root = mkdtempSync(resolve(tmpdir(), 'runtime-modes-missing-'));
    roots.push(root);
    await expect(
      convergeRuntimeRecordFileModes(resolve(root, 'beeline', 'agents', 'b'.repeat(64), 'runtime.json')),
    ).resolves.toBeUndefined();
  });

  it('is idempotent against a record already holding private modes', async () => {
    const root = mkdtempSync(resolve(tmpdir(), 'runtime-modes-idempotent-'));
    roots.push(root);
    const directory = resolve(root, 'beeline', 'agents', 'c'.repeat(64));
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const path = resolve(directory, 'runtime.json');
    writeFileSync(path, '{}\n', { mode: 0o600 });

    await convergeRuntimeRecordFileModes(path);
    await convergeRuntimeRecordFileModes(path);

    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(directory).mode & 0o777).toBe(0o700);
  });
});
