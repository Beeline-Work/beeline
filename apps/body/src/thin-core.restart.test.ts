import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DaemonApiClient } from './daemon-api-client.js';
import { identityFromKey, type AgentRuntimeRecord } from './runtime.js';
import { ThinDaemonCore } from './thin-core.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function core(): Promise<ThinDaemonCore> {
  const root = await mkdtemp(join(tmpdir(), 'beeline-restart-'));
  roots.push(root);
  const identity = identityFromKey('11'.repeat(32), 'Bee');
  const runtime = {
    agent: {
      name: 'Bee',
      publicKey: identity.publicKey,
      secretKeyHex: Buffer.from(identity.secretKey).toString('hex'),
    },
    rooms: [],
    communityId: 'workspace',
    supervisorRoot: root,
    transport: { kind: 'monolith', baseUrl: 'https://server.example', daemonToken: 'token' },
  } as unknown as AgentRuntimeRecord;
  return new ThinDaemonCore(runtime, join(root, 'agent.json'), { workspaceRoot: root } as never, {
    daemonApi: { execute: vi.fn(), setRoomsChangedListener: vi.fn() } as unknown as DaemonApiClient,
  });
}

describe('/restart', () => {
  it('cancels a running turn within seconds instead of draining it', async () => {
    const daemon = await core();
    let busy = true;
    let finish = () => {};
    const forceRecoverRoom = vi.fn(async () => {
      busy = false;
      finish();
    });
    (daemon as unknown as { roomRuntime: { running: Map<string, unknown> } }).roomRuntime.running.set(
      'room-1',
      {
        body: { isBusy: () => busy, prepareForForcedUpdateRestart: vi.fn(), forceRecoverRoom },
        controller: new AbortController(),
        // The turn never ends on its own: only a cancel finishes it.
        promise: new Promise<void>((resolve) => {
          finish = resolve;
        }),
        lastPollAt: Date.now(),
        backoffUntil: 0,
        recovering: false,
      },
    );

    const startedAt = Date.now();
    await expect(daemon.cancelActiveWorkForRestart()).resolves.toBe(true);
    const stopping = new AbortController();
    stopping.abort();
    await expect(daemon.run({ signal: stopping.signal })).resolves.toBe('aborted');

    expect(forceRecoverRoom).toHaveBeenCalledOnce();
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  });

  it('reports no active work when every Room is idle', async () => {
    const daemon = await core();
    await expect(daemon.cancelActiveWorkForRestart()).resolves.toBe(false);
  });
});
