import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { hasCornerPrepareScript } from './corner-prepare-script.js';

const roots: string[] = [];

async function checkout(packageJson?: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'corner-prepare-script-'));
  roots.push(root);
  if (packageJson !== undefined) await writeFile(join(root, 'package.json'), packageJson);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('hasCornerPrepareScript', () => {
  it('is true only for a checkout that defines the script', async () => {
    expect(
      await hasCornerPrepareScript(
        await checkout(JSON.stringify({ scripts: { 'corner:prepare': 'npm run build' } })),
      ),
    ).toBe(true);
  });

  it('is false when the script is absent, the file is missing, or the manifest is malformed', async () => {
    expect(await hasCornerPrepareScript(await checkout(JSON.stringify({ scripts: {} })))).toBe(false);
    expect(
      await hasCornerPrepareScript(await checkout(JSON.stringify({ scripts: { build: 'tsc' } }))),
    ).toBe(false);
    expect(await hasCornerPrepareScript(await checkout())).toBe(false);
    expect(await hasCornerPrepareScript(await checkout('{ not json'))).toBe(false);
  });

  it('is false for a non-string script value and for a missing checkout', async () => {
    expect(
      await hasCornerPrepareScript(await checkout(JSON.stringify({ scripts: { 'corner:prepare': 1 } }))),
    ).toBe(false);
    expect(await hasCornerPrepareScript(join(tmpdir(), 'corner-prepare-script-absent'))).toBe(false);
  });

  it('recognizes this repository as one that defines the script', async () => {
    const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
    expect(await hasCornerPrepareScript(repoRoot)).toBe(true);
  });
});
