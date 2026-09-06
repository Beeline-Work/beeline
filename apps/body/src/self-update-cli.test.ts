/**
 * `npx usebeeline update` runs from a throwaway npm cache — never through
 * the installed `<prefix>/bin/beeline` wrapper — so `BEELINE_LIB_DIR` is
 * absent from its environment (captain evidence: it refused outright,
 * quoting `requireLayout()`'s installer-layout error, which means nothing
 * to an npx caller). `requireLayout()` now locates the installed bundle the
 * way the installer itself lays it out and delegates the update to it, only
 * refusing (with a useful next step) when no install exists at all.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdir, mkdtemp as mkdtempFs, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { requireLayout, runUpdateCommand } from './self-update-cli.js';
import { hostPlatformKey } from './self-update.js';

const tempDirs: string[] = [];
async function tempDir(prefix: string): Promise<string> {
  const created = await mkdtempFs(join(tmpdir(), `${prefix}-`));
  tempDirs.push(created);
  return created;
}

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const dir of tempDirs.splice(0))
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
});

/** A release-shaped install: `bundle.json` nested exactly as a real bundle ships it. */
async function writeStubInstall(prefix: string, identity: { commit: string; version: string }) {
  const bundleDir = join(prefix, 'lib', 'beeline');
  await mkdir(join(bundleDir, 'lib', 'beeline'), { recursive: true });
  await writeFile(
    join(bundleDir, 'lib', 'beeline', 'bundle.json'),
    `${JSON.stringify({ schemaVersion: 1, platform: hostPlatformKey(), ...identity })}\n`,
  );
}

function simulateNpxEnvironment(home: string): void {
  // Exactly what `npx usebeeline update` sees: no BEELINE_LIB_DIR, because
  // it never ran through the installed wrapper that would have exported it.
  vi.stubEnv('BEELINE_LIB_DIR', '');
  vi.stubEnv('BEELINE_INSTALL_DIR', '');
  vi.stubEnv('BEELINE_INSTALL_LIB_DIR', '');
  vi.stubEnv('HOME', home);
}

describe('requireLayout (npx usebeeline update, no BEELINE_LIB_DIR in the environment)', () => {
  it('delegates to the installed bundle at the installer default ($HOME/.local) when one is present', async () => {
    const home = await tempDir('npx-default-');
    await writeStubInstall(join(home, '.local'), { commit: 'abc123', version: '0.0.56' });
    simulateNpxEnvironment(home);

    const layout = await requireLayout();
    expect(layout.libDir).toBe(join(home, '.local', 'lib', 'beeline'));
  });

  it('honors BEELINE_INSTALL_DIR the way the installer does when the bin dir was overridden', async () => {
    const root = await tempDir('npx-custom-bindir-');
    const binDir = join(root, 'custom', 'bin');
    await writeStubInstall(join(root, 'custom'), { commit: 'def456', version: '0.0.57' });
    simulateNpxEnvironment(join(root, 'unused-home'));
    vi.stubEnv('BEELINE_INSTALL_DIR', binDir);

    const layout = await requireLayout();
    expect(layout.libDir).toBe(join(root, 'custom', 'lib', 'beeline'));
  });

  it('honors BEELINE_INSTALL_LIB_DIR directly when the anchor itself was overridden', async () => {
    const root = await tempDir('npx-custom-anchor-');
    const anchor = join(root, 'somewhere', 'else');
    await mkdir(join(anchor, 'lib', 'beeline'), { recursive: true });
    await writeFile(
      join(anchor, 'lib', 'beeline', 'bundle.json'),
      `${JSON.stringify({ commit: 'ghi789', version: '0.0.58' })}\n`,
    );
    simulateNpxEnvironment(join(root, 'unused-home'));
    vi.stubEnv('BEELINE_INSTALL_LIB_DIR', anchor);

    const layout = await requireLayout();
    expect(layout.libDir).toBe(anchor);
  });

  it('refuses with the connect-first message, not the old installer-layout error, when no install exists', async () => {
    const home = await tempDir('npx-no-install-');
    simulateNpxEnvironment(home);

    await expect(requireLayout()).rejects.toThrow(
      'this host has no Beeline install; run `npx usebeeline connect` first.',
    );
  });
});

describe('runUpdateCommand end-to-end under a simulated npx environment', () => {
  function serveManifest(body: Record<string, unknown>): Promise<{ url: string; close(): Promise<void> }> {
    const server: Server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    });
    return new Promise((resolveListen) => {
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        if (!address || typeof address === 'string') throw new Error('no address');
        resolveListen({
          url: `http://127.0.0.1:${address.port}/manifest.json`,
          close: () => new Promise((done) => server.close(() => done())),
        });
      });
    });
  }

  it('--check succeeds (reaches the manifest compare) once an install is delegated to, no download or swap', async () => {
    const home = await tempDir('npx-check-');
    await writeStubInstall(join(home, '.local'), { commit: 'abc123', version: '0.0.56' });
    simulateNpxEnvironment(home);
    const platform = hostPlatformKey();
    const manifest = await serveManifest({
      schemaVersion: 1,
      bundles: {
        [platform]: { file: 'beeline-current.tar.gz', sha256: '0'.repeat(64), commit: 'abc123', version: '0.0.56' },
      },
    });
    const logs: string[] = [];
    const log = vi.spyOn(console, 'log').mockImplementation((line: string) => {
      logs.push(line);
    });
    try {
      await runUpdateCommand(['--check', '--manifest-url', manifest.url]);
    } finally {
      log.mockRestore();
      await manifest.close();
    }
    // Never reached the old refusal, and reached far enough to report the
    // installed identity and a real comparison verdict — proof the layout
    // discovered from $HOME/.local was the one actually used.
    expect(logs.some((line) => line.includes('installed bundle: 0.0.56'))).toBe(true);
    expect(logs.some((line) => line.includes('installed bundle is current'))).toBe(true);
  });
});
