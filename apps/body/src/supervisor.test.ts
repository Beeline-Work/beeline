import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { newIdentity } from '@beeline/gate';
import type { BodyConfig } from './config.js';
import type { AgentRuntimeRecord } from './runtime.js';

const mocks = vi.hoisted(() => ({
  createBuzzClient: vi.fn(),
}));

vi.mock('@beeline/buzz-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@beeline/buzz-client')>()),
  createBuzzClient: mocks.createBuzzClient,
}));

import { WorkspaceSupervisor } from './supervisor.js';

afterEach(() => {
  vi.restoreAllMocks();
  mocks.createBuzzClient.mockReset();
});

function storedIdentity(name: string) {
  const identity = newIdentity(name);
  return {
    identity,
    stored: {
      name,
      secretKeyHex: Buffer.from(identity.secretKey).toString('hex'),
      publicKey: identity.publicKey,
    },
  };
}

describe('WorkspaceSupervisor removal lease', () => {
  it('returns agent-removed when the Workspace membership projection drops the agent', async () => {
    const agent = storedIdentity('agent');
    const body = storedIdentity('body');
    const disconnect = vi.fn();
    mocks.createBuzzClient.mockReturnValue({
      isMember: vi.fn().mockResolvedValue(false),
      disconnect,
    });
    const runtime: AgentRuntimeRecord = {
      version: 2,
      communityId: '11111111-1111-4111-8111-111111111111',
      pairedBy: 'a'.repeat(64),
      agent: agent.stored,
      body: body.stored,
      rooms: [],
      supervisorRoot: '/tmp/beeline-test',
      relayBaseUrl: 'http://relay.test',
      agentBinary: '/bin/true',
      mcpBinary: '/bin/true',
      createdAt: new Date(0).toISOString(),
    };
    const supervisor = new WorkspaceSupervisor(
      runtime,
      `/tmp/beeline/agents/${agent.identity.publicKey}/runtime.json`,
      {} as BodyConfig,
    );

    await expect(supervisor.run({ pollMs: 1 })).resolves.toBe('agent-removed');
    expect(supervisor.activeRoomIds()).toEqual([]);
    expect(disconnect).toHaveBeenCalledOnce();
  });
});

describe('WorkspaceSupervisor unbound channel policy', () => {
  function runtimeWithExistingRepo(): AgentRuntimeRecord {
    const agent = storedIdentity('policy-agent');
    const body = storedIdentity('policy-body');
    return {
      version: 2,
      communityId: '11111111-1111-4111-8111-111111111111',
      pairedBy: 'a'.repeat(64),
      agent: agent.stored,
      body: body.stored,
      rooms: [
        {
          channelId: 'oldest-repository-room',
          repo: { root: '/tmp/oldest-repo' } as never,
          membershipSince: 10,
          discoveredAt: new Date(0).toISOString(),
        },
      ],
      supervisorRoot: '/tmp/beeline-policy-test',
      relayBaseUrl: 'http://relay.test',
      agentBinary: '/bin/true',
      mcpBinary: '/bin/true',
      createdAt: new Date(0).toISOString(),
    };
  }

  it('serves a DM as strictly read-only without borrowing an existing repository Room', async () => {
    const runtime = runtimeWithExistingRepo();
    const disconnect = vi.fn();
    mocks.createBuzzClient.mockReturnValue({
      isMember: vi.fn().mockResolvedValue(true),
      listMyChannels: vi
        .fn()
        .mockResolvedValue([{ channelId: 'dm-channel', event: { created_at: 20 } }]),
      getChannelCommunityId: vi.fn().mockResolvedValue(runtime.communityId),
      getParentChannelId: vi.fn().mockResolvedValue(null),
      getChannelRepositoryBinding: vi.fn().mockResolvedValue(null),
      getDirectMessage: vi.fn().mockResolvedValue({
        participants: [runtime.agent.publicKey, 'b'.repeat(64)],
      }),
      disconnect,
    });
    const supervisor = new WorkspaceSupervisor(
      runtime,
      `/tmp/beeline/agents/${runtime.agent.publicKey}/runtime.json`,
      {} as BodyConfig,
    );
    const startConversation = vi
      .spyOn(supervisor as never, 'startConversationRoom' as never)
      .mockImplementation(() => undefined as never);
    const startRepository = vi
      .spyOn(supervisor as never, 'startRepositoryRoom' as never)
      .mockImplementation(() => undefined as never);

    await expect(supervisor.reconcile()).resolves.toBe(true);

    expect(startConversation).toHaveBeenCalledWith('dm-channel', 'direct-message');
    expect(startRepository).not.toHaveBeenCalled();
    expect(disconnect).toHaveBeenCalledOnce();
  });

  it('serves an ordinary repo-less Room with named-repository corner capability', async () => {
    const runtime = runtimeWithExistingRepo();
    mocks.createBuzzClient.mockReturnValue({
      isMember: vi.fn().mockResolvedValue(true),
      listMyChannels: vi
        .fn()
        .mockResolvedValue([{ channelId: 'repo-less-room', event: { created_at: 20 } }]),
      getChannelCommunityId: vi.fn().mockResolvedValue(runtime.communityId),
      getParentChannelId: vi.fn().mockResolvedValue(null),
      getChannelRepositoryBinding: vi.fn().mockResolvedValue(null),
      getDirectMessage: vi.fn().mockResolvedValue(null),
      disconnect: vi.fn(),
    });
    const supervisor = new WorkspaceSupervisor(
      runtime,
      `/tmp/beeline/agents/${runtime.agent.publicKey}/runtime.json`,
      {} as BodyConfig,
    );
    const startConversation = vi
      .spyOn(supervisor as never, 'startConversationRoom' as never)
      .mockImplementation(() => undefined as never);

    await expect(supervisor.reconcile()).resolves.toBe(true);

    expect(startConversation).toHaveBeenCalledWith('repo-less-room', 'named-repository');
  });
});

describe('WorkspaceSupervisor Room watchdog', () => {
  function runtimeWithRooms(): AgentRuntimeRecord {
    const agent = storedIdentity('watchdog-agent');
    const body = storedIdentity('watchdog-body');
    const room = (channelId: string) => ({
      channelId,
      repo: {
        root: `/tmp/${channelId}`,
        repository: { name: channelId, key: channelId, localOnly: true },
        targetBranch: 'main',
      } as never,
      membershipSince: 1,
      discoveredAt: new Date(0).toISOString(),
    });
    return {
      version: 2,
      communityId: '11111111-1111-4111-8111-111111111111',
      pairedBy: 'a'.repeat(64),
      agent: agent.stored,
      body: body.stored,
      rooms: [room('stale-room'), room('healthy-room')],
      supervisorRoot: '/tmp/beeline-watchdog-test',
      relayBaseUrl: 'http://relay.test',
      agentBinary: '/bin/true',
      mcpBinary: '/bin/true',
      createdAt: new Date(0).toISOString(),
    };
  }

  it('restarts only a stale Room while its sibling remains served', async () => {
    let now = 100_000;
    const runtime = runtimeWithRooms();
    const supervisor = new WorkspaceSupervisor(
      runtime,
      `/tmp/beeline/agents/${runtime.agent.publicKey}/runtime.json`,
      {} as BodyConfig,
      { now: () => now, watchdogStaleMs: 1_000 },
    );
    const staleController = new AbortController();
    const healthyController = new AbortController();
    const staleBody = { forceRecoverRoom: vi.fn().mockResolvedValue(undefined) };
    const healthyBody = { forceRecoverRoom: vi.fn().mockResolvedValue(undefined) };
    const running = (supervisor as never).running as Map<string, unknown>;
    running.set('stale-room', {
      body: staleBody,
      controller: staleController,
      promise: Promise.resolve(),
      lastPollAt: 1,
      lastPresenceAt: 1,
      presence: 'offline',
      backoffUntil: 0,
      recovering: false,
    });
    running.set('healthy-room', {
      body: healthyBody,
      controller: healthyController,
      promise: Promise.resolve(),
      lastPollAt: now,
      lastPresenceAt: now,
      presence: 'online',
      backoffUntil: 0,
      recovering: false,
    });

    await (supervisor as never).watchdog();

    expect(staleBody.forceRecoverRoom).toHaveBeenCalledWith('stale-room');
    expect(staleController.signal.aborted).toBe(true);
    expect(healthyBody.forceRecoverRoom).not.toHaveBeenCalled();
    expect(healthyController.signal.aborted).toBe(false);
    expect(supervisor.activeRoomIds()).toEqual(['healthy-room', 'stale-room']);
    now += 1;
  });

  it('does not reset a rate-limited Room while its relay-directed delay is active', async () => {
    let now = 100_000;
    const runtime = runtimeWithRooms();
    const supervisor = new WorkspaceSupervisor(
      runtime,
      `/tmp/beeline/agents/${runtime.agent.publicKey}/runtime.json`,
      {} as BodyConfig,
      { now: () => now, watchdogStaleMs: 1_000 },
    );
    const controller = new AbortController();
    const body = { forceRecoverRoom: vi.fn().mockResolvedValue(undefined) };
    const running = (supervisor as never).running as Map<string, unknown>;
    running.set('rate-limited-room', {
      body,
      controller,
      promise: Promise.resolve(),
      lastPollAt: 1,
      lastPresenceAt: 1,
      presence: 'offline',
      backoffUntil: now + 120_000,
      recovering: false,
    });

    await (supervisor as never).watchdog();
    expect(body.forceRecoverRoom).not.toHaveBeenCalled();
    expect(controller.signal.aborted).toBe(false);

    now += 120_001;
    await (supervisor as never).watchdog();
    expect(body.forceRecoverRoom).toHaveBeenCalledWith('rate-limited-room');
    expect(controller.signal.aborted).toBe(true);
  });

  it('starts every configured repository Room again after a supervisor restart', async () => {
    const runtime = runtimeWithRooms();
    const disconnect = vi.fn();
    mocks.createBuzzClient.mockReturnValue({
      isMember: vi.fn().mockResolvedValue(true),
      listMyChannels: vi
        .fn()
        .mockResolvedValue(
          runtime.rooms.map((room) => ({ channelId: room.channelId, event: { created_at: 1 } })),
        ),
      disconnect,
    });
    const supervisor = new WorkspaceSupervisor(
      runtime,
      `/tmp/beeline/agents/${runtime.agent.publicKey}/runtime.json`,
      {} as BodyConfig,
    );
    const start = vi
      .spyOn(supervisor as never, 'startRepositoryRoom' as never)
      .mockImplementation(() => undefined as never);

    await expect(supervisor.reconcile()).resolves.toBe(true);

    expect(start).toHaveBeenCalledWith(runtime.rooms[0], 'stale-room');
    expect(start).toHaveBeenCalledWith(runtime.rooms[1], 'healthy-room');
    expect(disconnect).toHaveBeenCalledOnce();
  });
});

describe('WorkspaceSupervisor transient relay resilience', () => {
  function runtimeMinimal(name: string): AgentRuntimeRecord {
    const agent = storedIdentity(name);
    const body = storedIdentity(`${name}-body`);
    return {
      version: 2,
      communityId: '11111111-1111-4111-8111-111111111111',
      pairedBy: 'a'.repeat(64),
      agent: agent.stored,
      body: body.stored,
      rooms: [],
      supervisorRoot: '/tmp/beeline-transient-test',
      relayBaseUrl: 'http://relay.test',
      agentBinary: '/bin/true',
      mcpBinary: '/bin/true',
      createdAt: new Date(0).toISOString(),
    };
  }

  function transient502(): Error {
    // Mirrors what packages/buzz-client's requestQueryEvents throws once it
    // exhausts its own 5xx retry budget for a member/role-projection read.
    return new Error('queryEvents failed after 3 attempts: HTTP 502 Bad Gateway');
  }

  it('backs off and retries reconcile after a transient relay 502 instead of crash-looping', async () => {
    const runtime = runtimeMinimal('resilience-agent');
    const disconnect = vi.fn();
    const isMember = vi
      .fn()
      .mockRejectedValueOnce(transient502())
      .mockRejectedValueOnce(transient502())
      .mockResolvedValue(true);
    mocks.createBuzzClient.mockReturnValue({
      isMember,
      listMyChannels: vi.fn().mockResolvedValue([]),
      disconnect,
    });
    const supervisor = new WorkspaceSupervisor(
      runtime,
      `/tmp/beeline/agents/${runtime.agent.publicKey}/runtime.json`,
      {} as BodyConfig,
    );
    const controller = new AbortController();

    // A crash-looping supervisor would throw out of run() (or exit the
    // process) on the very first transient failure; assert instead that it
    // keeps polling and eventually recovers once the relay does.
    const runPromise = supervisor.run({ pollMs: 1, signal: controller.signal });
    while (isMember.mock.calls.length < 3) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 5));
    }
    controller.abort();

    await expect(runPromise).resolves.toBe('aborted');
    // Recovers past both transient failures and keeps polling (a crash-loop
    // would have thrown out of run() on the first rejection instead).
    expect(isMember.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(disconnect).toHaveBeenCalledTimes(isMember.mock.calls.length);
  });

  it('keeps an active corner Room running across a transient reconcile failure', async () => {
    const runtime = runtimeMinimal('corner-agent');
    mocks.createBuzzClient.mockReturnValue({
      isMember: vi.fn().mockRejectedValue(transient502()),
      disconnect: vi.fn(),
    });
    const supervisor = new WorkspaceSupervisor(
      runtime,
      `/tmp/beeline/agents/${runtime.agent.publicKey}/runtime.json`,
      {} as BodyConfig,
    );
    const cornerController = new AbortController();
    const running = (supervisor as never).running as Map<string, unknown>;
    running.set('active-corner', {
      body: { forceRecoverRoom: vi.fn() },
      controller: cornerController,
      promise: Promise.resolve(),
      lastPollAt: Date.now(),
      lastPresenceAt: Date.now(),
      presence: 'online',
      backoffUntil: 0,
      recovering: false,
    });

    // reconcile() itself still surfaces the failure (run() is what applies
    // the backoff/retry); the corner must be untouched by the failed attempt.
    await expect(supervisor.reconcile()).rejects.toThrow(/502/);

    expect(supervisor.activeRoomIds()).toEqual(['active-corner']);
    expect(cornerController.signal.aborted).toBe(false);
  });
});

describe('WorkspaceSupervisor control-plane wake signal', () => {
  function runtimeMinimal(name: string): AgentRuntimeRecord {
    const agent = storedIdentity(name);
    const body = storedIdentity(`${name}-body`);
    return {
      version: 2,
      communityId: '11111111-1111-4111-8111-111111111111',
      pairedBy: 'a'.repeat(64),
      agent: agent.stored,
      body: body.stored,
      rooms: [],
      supervisorRoot: '/tmp/beeline-wake-test',
      relayBaseUrl: 'http://relay.test',
      agentBinary: '/bin/true',
      mcpBinary: '/bin/true',
      createdAt: new Date(0).toISOString(),
    };
  }

  it('does not poll reconcile every tick, but reconciles promptly on a pushed membership event', async () => {
    const runtime = runtimeMinimal('wake-agent');
    const isMember = vi.fn().mockResolvedValue(true);
    const listMyChannels = vi.fn().mockResolvedValue([]);
    const disconnect = vi.fn();
    const connect = vi.fn().mockResolvedValue(undefined);
    let capturedHandler: (() => void) | undefined;
    const fakeSocket = {
      subscribe: vi.fn((_filters: unknown, onEvent: () => void) => {
        capturedHandler = onEvent;
        return vi.fn();
      }),
    };
    mocks.createBuzzClient.mockReturnValue({
      isMember,
      listMyChannels,
      connect,
      disconnect,
      get socket() {
        return fakeSocket;
      },
    });
    const supervisor = new WorkspaceSupervisor(
      runtime,
      `/tmp/beeline/agents/${runtime.agent.publicKey}/runtime.json`,
      {} as BodyConfig,
      { reconcileHeartbeatMs: 60_000 },
    );
    const controller = new AbortController();

    const runPromise = supervisor.run({ pollMs: 5, signal: controller.signal });
    while (isMember.mock.calls.length < 1) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 5));
    }
    expect(fakeSocket.subscribe).toHaveBeenCalledOnce();

    // Quiet window: no pushed event, well under the 60s heartbeat — the old
    // always-on 5s poll would have called isMember again by now.
    await new Promise((resolveWait) => setTimeout(resolveWait, 60));
    expect(isMember.mock.calls.length).toBe(1);

    capturedHandler?.();
    while (isMember.mock.calls.length < 2) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 5));
    }
    expect(isMember.mock.calls.length).toBe(2);

    controller.abort();
    await expect(runPromise).resolves.toBe('aborted');
  });

  it('falls back to the heartbeat poll when the control-plane WS is unavailable', async () => {
    const runtime = runtimeMinimal('no-ws-agent');
    const isMember = vi.fn().mockResolvedValue(true);
    const listMyChannels = vi.fn().mockResolvedValue([]);
    const disconnect = vi.fn();
    // No `connect`/`socket` on this mock — mirrors a client that cannot open
    // a control-plane WS at all; reconcile() must still be driven, just by
    // the heartbeat instead of a push.
    mocks.createBuzzClient.mockReturnValue({ isMember, listMyChannels, disconnect });
    const supervisor = new WorkspaceSupervisor(
      runtime,
      `/tmp/beeline/agents/${runtime.agent.publicKey}/runtime.json`,
      {} as BodyConfig,
      { reconcileHeartbeatMs: 20 },
    );
    const controller = new AbortController();

    const runPromise = supervisor.run({ pollMs: 5, signal: controller.signal });
    while (isMember.mock.calls.length < 2) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 5));
    }
    expect(isMember.mock.calls.length).toBeGreaterThanOrEqual(2);
    // Only reconcile()'s own per-call client is ever disconnected — the
    // failed control-socket attempt must not double-disconnect the same
    // mock object once per reconcile call.
    expect(disconnect).toHaveBeenCalledTimes(isMember.mock.calls.length);

    controller.abort();
    await expect(runPromise).resolves.toBe('aborted');
  });
});

describe('WorkspaceSupervisor per-room storage and harness isolation', () => {
  const scratchDirs: string[] = [];
  const savedRoomHome = process.env.BUZZY_BODY_ROOM_HOME;

  function scratch(prefix: string): string {
    const path = mkdtempSync(resolve(tmpdir(), prefix));
    scratchDirs.push(path);
    return path;
  }

  afterEach(() => {
    if (savedRoomHome === undefined) delete process.env.BUZZY_BODY_ROOM_HOME;
    else process.env.BUZZY_BODY_ROOM_HOME = savedRoomHome;
    for (const path of scratchDirs.splice(0)) rmSync(path, { recursive: true, force: true });
  });

  function supervisorFor(configPath: string, rooms: AgentRuntimeRecord['rooms'] = []) {
    const agent = storedIdentity('storage-agent');
    const body = storedIdentity('storage-body');
    const runtime: AgentRuntimeRecord = {
      version: 2,
      communityId: '11111111-1111-4111-8111-111111111111',
      pairedBy: 'a'.repeat(64),
      agent: agent.stored,
      body: body.stored,
      rooms,
      supervisorRoot: '/tmp/beeline-storage-test',
      relayBaseUrl: 'http://relay.test',
      agentBinary: '/bin/true',
      mcpBinary: '/bin/true',
      createdAt: new Date(0).toISOString(),
    };
    return new WorkspaceSupervisor(runtime, configPath, {} as BodyConfig);
  }

  function roomRoot(supervisor: WorkspaceSupervisor, channelId: string, room?: unknown): string {
    return (
      Reflect.get(supervisor, 'roomRoot') as (id: string, record?: unknown) => string
    ).call(supervisor, channelId, room);
  }

  function agentHomeRoot(supervisor: WorkspaceSupervisor, workspaceRoot: string) {
    return (
      Reflect.get(supervisor, 'roomAgentHomeRoot') as (root: string) => string | undefined
    ).call(supervisor, workspaceRoot);
  }

  it('keeps a Room provisioned before the runtime move at the exact directory it occupies', () => {
    // A record written before RoomRuntimeRecord.root existed. Its corners hold
    // absolute worktree paths under this directory, so it must not be derived
    // relative to a relocated runtime record.
    const legacyRuntimeDir = scratch('beeline-legacy-runtime-');
    const supervisor = supervisorFor(resolve(legacyRuntimeDir, 'runtime.json'));

    expect(roomRoot(supervisor, 'room-a')).toBe(resolve(legacyRuntimeDir, 'rooms', 'room-a'));
  });

  it('honours an explicit Room root over deriving one from the config path', () => {
    const runtimeDir = scratch('beeline-runtime-');
    const elsewhere = scratch('beeline-elsewhere-');
    const supervisor = supervisorFor(resolve(runtimeDir, 'runtime.json'));

    expect(roomRoot(supervisor, 'room-a', { root: resolve(elsewhere, 'room-a') })).toBe(
      resolve(elsewhere, 'room-a'),
    );
  });

  it('isolates a new Room harness state but never re-homes an already-served Room', () => {
    const runtimeDir = scratch('beeline-runtime-');
    const supervisor = supervisorFor(resolve(runtimeDir, 'runtime.json'));

    const freshRoom = resolve(runtimeDir, 'rooms', 'fresh-room');
    const home = agentHomeRoot(supervisor, freshRoom);
    expect(home).toBe(resolve(freshRoom, 'agent-home'));
    expect(existsSync(home!)).toBe(true);
    // Stable across daemon restarts: the marker directory now exists, so the
    // same Room keeps its isolated home instead of flipping back.
    expect(agentHomeRoot(supervisor, freshRoom)).toBe(home);

    // A Room directory that already exists predates per-room homes. Re-homing
    // it would strand whatever per-project state its harness had built up.
    const existingRoom = resolve(runtimeDir, 'rooms', 'existing-room');
    mkdirSync(existingRoom, { recursive: true });
    expect(agentHomeRoot(supervisor, existingRoom)).toBeUndefined();
  });

  it('lets an operator force per-room homes on, or off, for every Room', () => {
    const runtimeDir = scratch('beeline-runtime-');
    const supervisor = supervisorFor(resolve(runtimeDir, 'runtime.json'));
    const existingRoom = resolve(runtimeDir, 'rooms', 'existing-room');
    mkdirSync(existingRoom, { recursive: true });

    process.env.BUZZY_BODY_ROOM_HOME = '1';
    expect(agentHomeRoot(supervisor, existingRoom)).toBe(resolve(existingRoom, 'agent-home'));

    process.env.BUZZY_BODY_ROOM_HOME = '0';
    expect(agentHomeRoot(supervisor, resolve(runtimeDir, 'rooms', 'brand-new'))).toBeUndefined();
  });
});
