import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { newIdentity } from '@beeline/gate';
import type { NostrEvent } from '@beeline/nostr';
import type { BodyConfig } from './config.js';
import { DurableBodyState } from './durable-state.js';
import { createWorkspaceSnapshot } from '@beeline/buzz-client';
import { readRuntimeRecord, type AgentRuntimeRecord } from './runtime.js';

const mocks = vi.hoisted(() => ({
  createBuzzClient: vi.fn(),
  bodyStarts: [] as Array<{ roomId: string; statePath: string }>,
}));
vi.mock('@beeline/buzz-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@beeline/buzz-client')>()),
  createBuzzClient: mocks.createBuzzClient,
}));
vi.mock('./body.js', () => ({
  Body: class {
    readonly services: { statePath: string };

    constructor(
      _config: unknown,
      _body: unknown,
      _agent: unknown,
      _worker: unknown,
      services: { statePath: string },
    ) {
      this.services = services;
    }

    runRepositoryRoomLoop(
      _workspaceId: string,
      roomId: string,
      _repo: unknown,
      options: { signal: AbortSignal },
    ): Promise<void> {
      mocks.bodyStarts.push({ roomId, statePath: this.services.statePath });
      return new Promise((resolveLoop) => {
        if (options.signal.aborted) resolveLoop();
        else options.signal.addEventListener('abort', () => resolveLoop(), { once: true });
      });
    }

    runConversationRoomLoop(): Promise<void> {
      return Promise.resolve();
    }

    isBusy(): boolean {
      return false;
    }

    async forceRecoverRoom(): Promise<void> {}
    async dispose(): Promise<void> {}
  },
}));

import { ThinDaemonCore } from './thin-core.js';

const roots: string[] = [];

function stored(name: string) {
  const identity = newIdentity(name);
  return {
    name,
    secretKeyHex: Buffer.from(identity.secretKey).toString('hex'),
    publicKey: identity.publicKey,
  };
}

afterEach(async () => {
  mocks.createBuzzClient.mockReset();
  mocks.bodyStarts.splice(0);
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('thin-core swap compatibility', () => {
  it('boots the v2 runtime and preserves existing Room/corner/approval durable records in place', async () => {
    const root = await mkdtemp(join(tmpdir(), 'beeline-swap-compat-'));
    roots.push(root);
    const roomRoot = resolve(root, 'rooms/room-1');
    await mkdir(roomRoot, { recursive: true });
    const runtime: AgentRuntimeRecord = {
      version: 2,
      communityId: '11111111-1111-4111-8111-111111111111',
      pairedBy: 'a'.repeat(64),
      agent: stored('compat-agent'),
      body: stored('compat-body'),
      rooms: [
        {
          channelId: 'room-1',
          root: roomRoot,
          repo: {
            root: resolve(root, 'repo'),
            gitCommonDir: resolve(root, 'repo/.git'),
            targetBranch: 'main',
            repository: { key: 'repo-key', name: 'repo', localOnly: true },
          },
          membershipSince: 7,
          discoveredAt: new Date(0).toISOString(),
        },
      ],
      supervisorRoot: root,
      relayBaseUrl: 'http://relay.invalid',
      agentBinary: '/bin/true',
      mcpBinary: '/bin/true',
      createdAt: new Date(0).toISOString(),
    };
    const configPath = resolve(root, 'runtime.json');
    await writeFile(configPath, `${JSON.stringify(runtime, null, 2)}\n`);

    const durablePath = resolve(roomRoot, 'body-state.json');
    const durable = new DurableBodyState(durablePath);
    const approval: NostrEvent = {
      id: 'b'.repeat(64),
      pubkey: runtime.pairedBy,
      created_at: 8,
      kind: 9,
      tags: [
        ['t', 'merge-approval'],
        ['h', 'corner-1'],
      ],
      content: 'LAND',
      sig: 'c'.repeat(128),
    };
    await durable.enqueue('corner-1', [approval]);
    await durable.replaceReadModel('corner-1', createWorkspaceSnapshot({ workspaceId: 'room-1' }));

    const loaded = await readRuntimeRecord(configPath);
    const before = await readFile(durablePath, 'utf8');
    const socket = { connected: true, subscribe: vi.fn(() => () => undefined) };
    const client = {
      socket,
      connect: vi.fn(async () => undefined),
      isMember: vi.fn(async () => true),
      listMyChannels: vi.fn(async () => [
        { channelId: 'room-1', event: { created_at: runtime.rooms[0]!.membershipSince } },
      ]),
      resolveRoomRepositoryState: vi.fn(async () => ({ kind: 'unverified', reason: 'fixture' })),
      getChannelMetadata: vi.fn(async () => ({ archived: false })),
      disconnect: vi.fn(),
    };
    mocks.createBuzzClient.mockReturnValue(client);
    const core = new ThinDaemonCore(loaded, configPath, {} as BodyConfig) as unknown as {
      roomRuntime: {
        roomRoot(id: string, room?: unknown): string;
        resolveServingRepo(room: unknown): Promise<unknown>;
      };
      run(options: unknown): Promise<string>;
    };
    core.roomRuntime.resolveServingRepo = vi.fn(async () => ({
      repo: 'repo',
      targetBranch: 'refs/heads/main',
      localPath: runtime.rooms[0]!.repo.root,
      repositoryKey: 'repo-key',
      localOnly: true,
    }));

    expect(core.roomRuntime.roomRoot('room-1', loaded.rooms[0])).toBe(roomRoot);
    const controller = new AbortController();
    let established = false;
    expect(
      await core.run({
        signal: controller.signal,
        pollMs: 1,
        onEstablished: () => {
          established = true;
        },
        onProgress: () => controller.abort(),
      }),
    ).toBe('aborted');
    expect(established).toBe(true);
    expect(mocks.bodyStarts).toEqual([{ roomId: 'room-1', statePath: durablePath }]);
    expect((await durable.pending('corner-1'))[0]?.id).toBe(approval.id);
    expect((await durable.readModel('corner-1'))?.workspaceId).toBe('room-1');
    expect(await readFile(durablePath, 'utf8')).toBe(before);
    expect(ThinDaemonCore.name).toBe('ThinDaemonCore');
  });
});
