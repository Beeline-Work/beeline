import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DaemonApiClient } from './daemon-api-client.js';
import { identityFromKey, type AgentRuntimeRecord } from './runtime.js';
import { RoomRuntimeCoordinator } from './room-runtime.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/**
 * The phone-side model/effort change reaches the daemon as one `config-changed`
 * push over the live socket; `DaemonApiClient.setConfigChangedListener` is the
 * one registration and `RoomRuntimeCoordinator` is the one subscriber. This
 * pins that wiring: the coordinator must register the listener at construction
 * (like the rooms-changed wake) and its callback must route to the scheduler's
 * hot restart without throwing when nothing is live.
 */
describe('RoomRuntimeCoordinator config-change wake', () => {
  it('registers the config-changed listener and hot-restarts on it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'beeline-coordinator-config-wake-'));
    roots.push(root);
    const identity = identityFromKey('11'.repeat(32), 'Bee');
    const runtime = {
      agent: {
        name: 'Bee',
        publicKey: identity.publicKey,
        secretKeyHex: Buffer.from(identity.secretKey).toString('hex'),
      },
      rooms: [],
      supervisorRoot: root,
      transport: { kind: 'monolith', baseUrl: 'https://server.example', daemonToken: 'token' },
    } as unknown as AgentRuntimeRecord;

    let configChanged: (() => void) | undefined;
    const coordinator = new RoomRuntimeCoordinator(
      runtime,
      join(root, 'agent.json'),
      { workspaceRoot: root } as never,
      {
        daemonApi: {
          execute: vi.fn(),
          setRoomsChangedListener: vi.fn(),
          setConfigChangedListener: (listener: () => void) => {
            configChanged = listener;
          },
        } as unknown as DaemonApiClient,
      },
    );
    try {
      expect(configChanged).toBeTypeOf('function');
      // The wake must be safe with nothing live: an empty scheduler is the
      // ordinary case for a daemon that has not started any Room yet.
      expect(() => configChanged!()).not.toThrow();
      await vi.waitFor(() =>
        expect(coordinator.schedulerSnapshot().live).toBe(0),
      );
    } finally {
      await coordinator.shutdown();
    }
  });
});
