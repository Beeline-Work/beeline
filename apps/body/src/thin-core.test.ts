import { mkdtemp as move6_mkdtemp, rm as move6_rm } from 'node:fs/promises';

import { tmpdir as move6_tmpdir } from 'node:os';

import { join as move6_join } from 'node:path';

import { afterEach as move6_afterEach, describe as move6_describe, expect as move6_expect, it as move6_it, vi as move6_vi } from 'vitest';

import type { DaemonApiClient as move6_DaemonApiClient } from "./daemon-api-client.js";

import { identityFromKey as move6_identityFromKey, type AgentRuntimeRecord as move6_AgentRuntimeRecord } from "./runtime.js";

import { ThinDaemonCore as move6_ThinDaemonCore } from "./thin-core.js";
import { describe as movedDescribe6 } from 'vitest';
movedDescribe6("thin-core.restart.test.ts", () => {


const roots: string[] = [];

move6_afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => move6_rm(root, { recursive: true, force: true })));
});


async function core(): Promise<move6_ThinDaemonCore> {
  const root = await move6_mkdtemp(move6_join(move6_tmpdir(), 'beeline-restart-'));
  roots.push(root);
  const identity = move6_identityFromKey('11'.repeat(32), 'Bee');
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
  } as unknown as move6_AgentRuntimeRecord;
  return new move6_ThinDaemonCore(runtime, move6_join(root, 'agent.json'), { workspaceRoot: root } as never, {
    daemonApi: { execute: move6_vi.fn(), setRoomsChangedListener: move6_vi.fn() } as unknown as move6_DaemonApiClient,
  });
}


move6_describe('/restart', () => {
  move6_it('cancels a running turn within seconds instead of draining it', async () => {
    const daemon = await core();
    let busy = true;
    let finish = () => {};
    const forceRecoverRoom = move6_vi.fn(async () => {
      busy = false;
      finish();
    });
    (daemon as unknown as { roomRuntime: { running: Map<string, unknown> } }).roomRuntime.running.set(
      'room-1',
      {
        body: { isBusy: () => busy, prepareForForcedUpdateRestart: move6_vi.fn(), forceRecoverRoom },
        controller: new AbortController(),
        // The turn never ends on its own: only a cancel finishes it.
        promise: new Promise<void>((resolve) => {
          finish = resolve;
        }),
      },
    );

    const startedAt = Date.now();
    await move6_expect(daemon.cancelActiveWorkForRestart()).resolves.toBe(true);
    const stopping = new AbortController();
    stopping.abort();
    await move6_expect(daemon.run({ signal: stopping.signal })).resolves.toBe('aborted');

    move6_expect(forceRecoverRoom).toHaveBeenCalledOnce();
    move6_expect(Date.now() - startedAt).toBeLessThan(5_000);
  });

  move6_it('reports no active work when every Room is idle', async () => {
    const daemon = await core();
    await move6_expect(daemon.cancelActiveWorkForRestart()).resolves.toBe(false);
  });
});
});
