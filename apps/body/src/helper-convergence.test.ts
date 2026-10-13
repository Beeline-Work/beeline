import { createServer } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import * as service from './recovery.js';
import { runUpdateCommand } from './self-update-cli.js';
import { hostPlatformKey } from './self-update.js';

it('a current bundle still converges a dead helper', async () => {
  const home = await mkdtemp(join(tmpdir(), 'beeline-convergence-'));
  const lib = join(home, '.local/lib/beeline/lib/beeline');
  await mkdir(lib, { recursive: true });
  await writeFile(
    join(lib, 'bundle.json'),
    JSON.stringify({ commit: 'current', version: 'v1.0.0' }),
  );
  const server = createServer((_req, res) =>
    res.end(
      JSON.stringify({
        bundles: {
          [hostPlatformKey()]: {
            file: 'current.tar.gz',
            sha256: '0'.repeat(64),
            commit: 'current',
            version: 'v1.0.0',
          },
        },
      }),
    ),
  );
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  vi.spyOn(service, 'prepareMachineRelease').mockResolvedValue({
    releaseId: 'current',
    identity: { version: 'v1.0.0', commit: 'current' },
  });
  const ensure = vi
    .spyOn(service, 'convergeMachine')
    .mockResolvedValue({
      pid: 42,
      generation: 'fixture',
      processState: 'serving',
      loadedRelease: 'current',
      updatedAt: new Date().toISOString(),
      agents: {},
    });
  vi.stubEnv('HOME', home);
  vi.stubEnv('XDG_STATE_HOME', join(home, 'state'));
  vi.stubEnv('BEELINE_LIB_DIR', join(home, '.local/lib/beeline'));
  try {
    await runUpdateCommand([
      'update',
      '--manifest-url',
      `http://127.0.0.1:${(server.address() as { port: number }).port}/manifest.json`,
    ]);
    expect(ensure).toHaveBeenCalled();
  } finally {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await new Promise<void>((done) => server.close(() => done()));
    await rm(home, { recursive: true, force: true });
  }
});
