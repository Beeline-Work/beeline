import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { newIdentity } from '@beeline/gate';
import type { BodyConfig } from './config.js';
import { inspectLocalRepository, type AgentRuntimeRecord, type RoomRuntimeRecord } from './runtime.js';
import { AGENT_ERROR_STATE_MESSAGES } from './agent-state-messages.js';
import type { NostrEvent } from '@beeline/nostr';

const mocks = vi.hoisted(() => ({
  createBuzzClient: vi.fn(),
}));

vi.mock('@beeline/buzz-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@beeline/buzz-client')>()),
  createBuzzClient: mocks.createBuzzClient,
}));

import { DEFAULT_ROOM_DISCOVERY_RETRY_MS, WorkspaceSupervisor } from './supervisor.js';

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
    // reconcile()'s own per-call client, plus the daemon's one shared relay
    // socket closed at teardown. This fixture returns the same mock object for
    // every createBuzzClient() call, so both land on this spy.
    expect(disconnect).toHaveBeenCalledTimes(2);
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
      resolveRoomRepository: vi.fn().mockResolvedValue(null),
      resolveRoomRepositoryState: vi.fn().mockResolvedValue({ kind: 'none' }),
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

  it('leaves a Room alone rather than serving it as repo-less when its repository is unconfirmable', async () => {
    // A Room's repository config is authorized against the CURRENT admin
    // projection, which is a separate relay read that comes back empty under
    // load. Reported as `null` — "there is no repository" — that read decided
    // what KIND of Room this is, and a Room served as `named-repository` tells
    // anyone who asks for a corner that it has no repository linked.
    //
    // (A Room this daemon has already materialized is short-circuited earlier
    // by `runtime.rooms` and was never exposed to this; the Rooms that are are
    // the ones this daemon has not served before — a second agent paired into
    // an existing Room, or a fresh runtime.)
    const runtime = runtimeWithExistingRepo();
    mocks.createBuzzClient.mockReturnValue({
      isMember: vi.fn().mockResolvedValue(true),
      listMyChannels: vi
        .fn()
        .mockResolvedValue([{ channelId: 'unconfirmable-room', event: { created_at: 20 } }]),
      getChannelCommunityId: vi.fn().mockResolvedValue(runtime.communityId),
      getParentChannelId: vi.fn().mockResolvedValue(null),
      resolveRoomRepository: vi.fn().mockResolvedValue(null),
      resolveRoomRepositoryState: vi
        .fn()
        .mockResolvedValue({ kind: 'unverified', reason: 'role projection came back empty' }),
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
    const startRepository = vi
      .spyOn(supervisor as never, 'startRepositoryRoom' as never)
      .mockImplementation(() => undefined as never);

    await expect(supervisor.reconcile()).resolves.toBe(true);

    // Neither: "I could not tell" is not a licence to pick one.
    expect(startConversation).not.toHaveBeenCalled();
    expect(startRepository).not.toHaveBeenCalled();
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
      resolveRoomRepository: vi.fn().mockResolvedValue(null),
      resolveRoomRepositoryState: vi.fn().mockResolvedValue({ kind: 'none' }),
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
    // One per reconcile() client, plus the daemon's shared relay socket closed
    // once at teardown (same mock object backs both in this fixture).
    expect(disconnect).toHaveBeenCalledTimes(isMember.mock.calls.length + 1);
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

describe('WorkspaceSupervisor room owns the repo (Stage 1)', () => {
  function storedId(name: string) {
    return storedIdentity(name).stored;
  }

  function runtime(supervisorRoot: string, rooms: RoomRuntimeRecord[] = []): AgentRuntimeRecord {
    return {
      version: 2,
      communityId: '11111111-1111-4111-8111-111111111111',
      pairedBy: 'a'.repeat(64),
      agent: storedId('canon-agent'),
      body: storedId('canon-body'),
      rooms,
      supervisorRoot,
      relayBaseUrl: 'http://relay.test',
      agentBinary: '/bin/true',
      mcpBinary: '/bin/true',
      createdAt: new Date(0).toISOString(),
    };
  }

  function supervisorFor(supervisorRoot: string, rooms: RoomRuntimeRecord[] = []): WorkspaceSupervisor {
    const rt = runtime(supervisorRoot, rooms);
    return new WorkspaceSupervisor(
      rt,
      `/tmp/beeline/agents/${rt.agent.publicKey}/runtime.json`,
      {} as BodyConfig,
    );
  }

  it('places the canonical checkout per-host per-repo (not per-agent), identical across agents', () => {
    const root = '/tmp/beeline-canon-host';
    const a = supervisorFor(root) as never as { canonicalCheckoutPath(key: string): string };
    const b = supervisorFor(root) as never as { canonicalCheckoutPath(key: string): string };
    const expected = resolve(root, 'beeline', 'repositories', 'repo-key-xyz');
    expect(a.canonicalCheckoutPath('repo-key-xyz')).toBe(expected);
    // A different agent on the same host resolves the SAME shared checkout.
    expect(b.canonicalCheckoutPath('repo-key-xyz')).toBe(expected);
  });

  it('serves a remote Room from beeline own clone of origin, never the operator checkout', () => {
    const tmp = mkdtempSync(resolve(tmpdir(), 'buzzy-canon-'));
    const gitEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1' };
    const runGit = (cwd: string, args: string[]) =>
      spawnSync('git', args, { cwd, env: gitEnv, encoding: 'utf8' });

    // A real "origin" repo, and a separate operator working checkout of it.
    const origin = resolve(tmp, 'origin');
    spawnSync('git', ['init', '-q', '-b', 'main', origin], { env: gitEnv, encoding: 'utf8' });
    runGit(origin, ['config', 'user.email', 't@t.local']);
    runGit(origin, ['config', 'user.name', 'test']);
    spawnSync('git', ['-C', origin, 'commit', '-q', '--allow-empty', '-m', 'init'], {
      env: gitEnv,
      encoding: 'utf8',
    });
    const operatorCheckout = resolve(tmp, 'operator-proj');
    spawnSync('git', ['clone', '-q', origin, operatorCheckout], { env: gitEnv, encoding: 'utf8' });

    // The Room's stored binding points at the OPERATOR's checkout (the pairing
    // shape). Serving must NOT use it — it must clone its own canonical.
    const opBinding = inspectLocalRepository(operatorCheckout);
    const room: RoomRuntimeRecord = {
      channelId: 'repo-room',
      repo: opBinding,
      membershipSince: 1,
      discoveredAt: new Date(0).toISOString(),
    };

    const supervisorRoot = resolve(tmp, 'state');
    const supervisor = supervisorFor(supervisorRoot, [room]) as never as {
      resolveServingRepo(room: RoomRuntimeRecord): Promise<{ localPath?: string; targetBranch?: string }>;
    };

    return supervisor.resolveServingRepo(room).then((bound) => {
      const canonical = resolve(supervisorRoot, 'beeline', 'repositories', opBinding.repository.key);
      expect(bound.localPath).toBe(canonical);
      // The load-bearing safety property: the agent NEVER serves from the
      // operator's working tree (which carries WIP and drifts).
      expect(bound.localPath).not.toBe(operatorCheckout);
      expect(existsSync(resolve(canonical, '.git'))).toBe(true);
      expect(inspectLocalRepository(canonical).repository.key).toBe(opBinding.repository.key);
      rmSync(tmp, { recursive: true, force: true });
    });
  });

  it('leaves a local-only Room on its stored checkout (no origin to clone a canonical from)', async () => {
    const room: RoomRuntimeRecord = {
      channelId: 'local-room',
      repo: {
        root: '/tmp/local-proj',
        repository: { name: 'local-proj', key: 'local-key', localOnly: true },
        targetBranch: 'main',
      } as never,
      membershipSince: 1,
      discoveredAt: new Date(0).toISOString(),
    };
    const supervisor = supervisorFor('/tmp/beeline-local-host', [room]) as never as {
      resolveServingRepo(room: RoomRuntimeRecord): Promise<{ localPath?: string }>;
    };
    const bound = await supervisor.resolveServingRepo(room);
    expect(bound.localPath).toBe('/tmp/local-proj');
  });

  it('speaks a repo-unavailable notice once across repeated resolve failures, and clears once resolution succeeds', async () => {
    const room: RoomRuntimeRecord = {
      channelId: 'repo-unavailable-room',
      repo: {
        root: '/tmp/nonexistent-repo-unavailable',
        repository: { name: 'nonexistent-repo', key: 'repo-unavailable-key', localOnly: false },
        targetBranch: 'main',
        remoteName: 'origin',
      } as never,
      membershipSince: 1,
      discoveredAt: new Date(0).toISOString(),
    };
    const supervisor = supervisorFor('/tmp/beeline-repo-unavailable-host', [room]);
    const resolveSpy = vi
      .spyOn(supervisor as never, 'resolveServingRepo' as never)
      .mockRejectedValue(new Error('could not clone canonical checkout for nonexistent-repo: fatal'));
    const startRepositoryRoom = (
      Reflect.get(supervisor, 'startRepositoryRoom') as (...args: unknown[]) => Promise<void>
    ).bind(supervisor);
    const published: NostrEvent[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        published.push(JSON.parse(String(init?.body)) as NostrEvent);
        return new Response(JSON.stringify({ accepted: true }), { status: 200 });
      }),
    );
    const noticeCount = () =>
      published.filter((item) => item.content === AGENT_ERROR_STATE_MESSAGES['repo-unavailable']).length;

    await startRepositoryRoom(room, room.channelId);
    expect(noticeCount()).toBe(1);

    // The next reconcile retries the same still-unresolved Room: same
    // underlying failure, no second notice.
    await startRepositoryRoom(room, room.channelId);
    expect(noticeCount()).toBe(1);
    expect(resolveSpy).toHaveBeenCalledTimes(2);

    vi.unstubAllGlobals();
  });
});

describe('WorkspaceSupervisor per-Room discovery isolation', () => {
  function runtimeNoRooms(name: string): AgentRuntimeRecord {
    const agent = storedIdentity(name);
    const body = storedIdentity(`${name}-body`);
    return {
      version: 2,
      communityId: '11111111-1111-4111-8111-111111111111',
      pairedBy: 'a'.repeat(64),
      agent: agent.stored,
      body: body.stored,
      rooms: [],
      supervisorRoot: '/tmp/beeline-discovery-test',
      relayBaseUrl: 'http://relay.test',
      agentBinary: '/bin/true',
      mcpBinary: '/bin/true',
      createdAt: new Date(0).toISOString(),
    };
  }

  /**
   * One unservable Room (bound to a local-only repository that lives on
   * another checkout — a legitimate durable state, not a relay hiccup) used to
   * throw straight out of `reconcile()`. That aborted the whole pass: every
   * Room behind it in the join loop never started, and `run()` re-ran
   * discovery on its 5s error backoff forever, one log line per pass.
   */
  function discoveryClient(runtime: AgentRuntimeRecord) {
    return {
      isMember: vi.fn().mockResolvedValue(true),
      listMyChannels: vi.fn().mockResolvedValue([
        { channelId: 'unservable-room', event: { created_at: 20 } },
        { channelId: 'good-dm', event: { created_at: 21 } },
        { channelId: 'good-room', event: { created_at: 22 } },
      ]),
      getChannelCommunityId: vi.fn().mockResolvedValue(runtime.communityId),
      getParentChannelId: vi.fn().mockResolvedValue(null),
      resolveRoomRepository: vi.fn(async (channelId: string) =>
        channelId === 'unservable-room'
          ? { binding: { name: 'elsewhere', key: 'elsewhere', localOnly: true } }
          : null,
      ),
      resolveRoomRepositoryState: vi.fn(async (channelId: string) =>
        channelId === 'unservable-room'
          ? {
              kind: 'repository',
              repository: { binding: { name: 'elsewhere', key: 'elsewhere', localOnly: true } },
            }
          : { kind: 'none' },
      ),
      getChannelRepositoryBinding: vi.fn().mockResolvedValue(null),
      getDirectMessage: vi.fn(async (channelId: string) =>
        channelId === 'good-dm'
          ? { participants: [runtime.agent.publicKey, 'b'.repeat(64)] }
          : null,
      ),
      disconnect: vi.fn(),
    };
  }

  it('skips one unservable Room and still joins every other invited Room', async () => {
    const runtime = runtimeNoRooms('discovery-agent');
    mocks.createBuzzClient.mockReturnValue(discoveryClient(runtime));
    const supervisor = new WorkspaceSupervisor(
      runtime,
      `/tmp/beeline/agents/${runtime.agent.publicKey}/runtime.json`,
      {} as BodyConfig,
    );
    const startConversation = vi
      .spyOn(supervisor as never, 'startConversationRoom' as never)
      .mockImplementation(() => undefined as never);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    // The pass completes rather than throwing...
    await expect(supervisor.reconcile()).resolves.toBe(true);

    // ...and the two Rooms listed *after* the unservable one are still served.
    expect(startConversation).toHaveBeenCalledWith('good-dm', 'direct-message');
    expect(startConversation).toHaveBeenCalledWith('good-room', 'named-repository');
  });

  it('logs the unservable Room once and retries it on a long cadence, not every pass', async () => {
    const runtime = runtimeNoRooms('discovery-log-agent');
    mocks.createBuzzClient.mockReturnValue(discoveryClient(runtime));
    let now = 1_000_000;
    const supervisor = new WorkspaceSupervisor(
      runtime,
      `/tmp/beeline/agents/${runtime.agent.publicKey}/runtime.json`,
      {} as BodyConfig,
      { now: () => now },
    );
    vi.spyOn(supervisor as never, 'startConversationRoom' as never).mockImplementation(
      () => undefined as never,
    );
    const materialize = vi.spyOn(supervisor as never, 'materializeRoom' as never);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await supervisor.reconcile();
    await supervisor.reconcile();
    await supervisor.reconcile();

    const unservableLogs = errors.mock.calls.filter((call) =>
      String(call[0]).includes('unservable-room'),
    );
    expect(unservableLogs).toHaveLength(1);
    expect(String(unservableLogs[0]![0])).toContain('could not be joined');
    // Parked, not re-attempted on every pass.
    expect(materialize).toHaveBeenCalledTimes(1);

    // Past the retry cadence it is tried again — an operator who fixes the
    // underlying cause is still picked up, just not by polling every 5s.
    now += DEFAULT_ROOM_DISCOVERY_RETRY_MS + 1;
    await supervisor.reconcile();
    expect(materialize).toHaveBeenCalledTimes(2);
  });
});
