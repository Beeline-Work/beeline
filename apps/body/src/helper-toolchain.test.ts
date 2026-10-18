import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const platform = `${process.platform}-${process.arch}`;
const fixture = vi.hoisted(() => ({ manifest: {} as any }));
// Keep the real release manifest available for its completeness assertion.
vi.mock('./helper-toolchain-manifest.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('./helper-toolchain-manifest.js')>();
  return { ...original, HELPER_TOOLCHAIN_MANIFEST: fixture.manifest };
});
import {
  ensureHelperToolchain,
  helperToolchainRoot,
  helperToolchainBins,
} from './helper-toolchain.js';

let root: string;
let env: NodeJS.ProcessEnv;
let nodeArchive: Buffer;
let binary: Buffer;
let fetchMock: ReturnType<typeof vi.fn>;
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'beeline-toolchain-test-'));
  env = { HOME: root, PATH: '/usr/bin:/bin' };
  const node = join(root, 'fixture/node/bin/node');
  await mkdir(join(node, '..'), { recursive: true });
  await writeFile(node, '#!/bin/sh\nexit 0\n');
  await chmod(node, 0o755);
  execFileSync('tar', ['-czf', join(root, 'node.tgz'), '-C', join(root, 'fixture'), 'node']);
  nodeArchive = await readFile(join(root, 'node.tgz'));
  binary = Buffer.from('#!/bin/sh\necho goose-fixture\n');
  Object.assign(fixture.manifest, {
    platforms: [platform],
    node: {
      version: '1.0.0',
      platforms: { [platform]: { url: 'https://fixture/node', sha256: sha(nodeArchive) } },
    },
    npm: {},
    native: {
      goose: {
        version: '1.0.0',
        platforms: {
          [platform]: {
            url: 'https://fixture/goose',
            sha256: sha(binary),
            format: 'binary',
            binary: 'goose',
          },
        },
      },
    },
  });
  fetchMock = vi.fn(
    async (url: string) => new Response(url.endsWith('/node') ? nodeArchive : binary),
  );
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await rm(root, { recursive: true, force: true });
});

describe('managed helper dependency installation', () => {
  it('rejects a mismatching checksum without publishing any install', async () => {
    fixture.manifest.node.platforms[platform].sha256 = '0'.repeat(64);
    await expect(ensureHelperToolchain('goose', env)).rejects.toThrow(
      'Node 1.0.0: SHA-256 checksum mismatch',
    );
    expect(await readdir(helperToolchainRoot(env))).toEqual([]);
  });
  it('installs atomically, skips the current pin, and replaces version drift', async () => {
    expect(await ensureHelperToolchain('goose', env)).toBe(true);
    expect(helperToolchainBins(env)).toHaveLength(2);
    expect(await ensureHelperToolchain('goose', env)).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    fixture.manifest.native.goose.version = '2.0.0';
    expect(await ensureHelperToolchain('goose', env)).toBe(true);
    expect(
      (await readdir(helperToolchainRoot(env))).filter((name) => name.startsWith('goose-')),
    ).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
  it('keeps recorded launcher Node paths usable after replacing old runtime bytes', async () => {
    await ensureHelperToolchain('goose', env);
    const previous = (await readdir(helperToolchainRoot(env))).find((name) =>
      name.startsWith('node-'),
    )!;
    fixture.manifest.node.version = '2.0.0';
    await ensureHelperToolchain('goose', env);
    const alias = join(helperToolchainRoot(env), previous);
    expect(await readlink(alias)).toMatch(/^node-2\.0\.0-/);
    expect(await readFile(join(alias, 'bin/node'), 'utf8')).toContain('exit 0');
    await ensureHelperToolchain('goose', env);
    expect(await readlink(alias)).toMatch(/^node-2\.0\.0-/);
  });
  it('preserves the working generation when an upgrade fails', async () => {
    await ensureHelperToolchain('goose', env);
    const before = await readdir(helperToolchainRoot(env));
    fixture.manifest.native.goose.version = '2.0.0';
    fixture.manifest.native.goose.platforms[platform].sha256 = '0'.repeat(64);
    await expect(ensureHelperToolchain('goose', env)).rejects.toThrow(
      'goose 2.0.0: SHA-256 checksum mismatch',
    );
    expect(await readdir(helperToolchainRoot(env))).toEqual(before);
  });
  it('locks concurrent cold installations even without an installed helper layout', async () => {
    const results = await Promise.all([
      ensureHelperToolchain('goose', env),
      ensureHelperToolchain('goose', env),
    ]);
    expect(results.sort()).toEqual([false, true]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
