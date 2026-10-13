import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { expect, it } from 'vitest';
import { prepareReleaseInWorker } from './managed-update.js';
import { hostPlatformKey } from './self-update.js';

it('a rejected release worker exits promptly even with its owner IPC channel open', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'beeline-worker-refusal-'));
  const bootstrap = resolve(root, 'recovery.mjs');
  const server = createServer((request, response) =>
    response.end(
      request.url === '/bundle.tar.gz'
        ? 'bad checksum'
        : JSON.stringify({
            version: 'v1.0.0',
            sourceCommit: 'a'.repeat(40),
            bundles: { [hostPlatformKey()]: { file: 'bundle.tar.gz', sha256: '0'.repeat(64) } },
          }),
    ),
  );
  try {
    await build({
      entryPoints: [new URL('./recovery-cli.ts', import.meta.url).pathname],
      bundle: true,
      platform: 'node',
      format: 'esm',
      outfile: bootstrap,
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const began = Date.now();
    await expect(
      prepareReleaseInWorker(
        {
          ...process.env,
          HOME: root,
          XDG_CONFIG_HOME: resolve(root, 'config'),
          XDG_STATE_HOME: resolve(root, 'state'),
          BEELINE_LIB_DIR: resolve(root, '.local/lib/beeline'),
          BEELINE_UPDATE_MANIFEST_URL: `http://127.0.0.1:${(server.address() as { port: number }).port}/manifest.json`,
        },
        Date.now() + 5000,
        bootstrap,
      ),
    ).rejects.toThrow(/checksum/);
    expect(Date.now() - began).toBeLessThan(5000);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
    await rm(root, { recursive: true, force: true });
  }
});
