import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { newIdentity } from '@beeline/gate';
import { OidcBindError, type BuzzClient } from '@beeline/buzz-client';
import type { BodyConfig } from './config.js';
import {
  inspectLocalRepository,
  removeAgentRuntime,
  type AgentRuntimeRecord,
  type RoomRuntimeRecord,
} from './runtime.js';

const mocks = vi.hoisted(() => ({
  createBuzzClient: vi.fn(),
}));

function fakeBuzzClient(overrides: Partial<BuzzClient> = {}): BuzzClient {
  return {
    isMember: vi.fn().mockResolvedValue(true),
    listMyChannels: vi.fn().mockResolvedValue([]),
    listAgents: vi.fn().mockResolvedValue([]),
    syncAgentDeclaration: vi.fn().mockResolvedValue(undefined),
    getChannelMetadata: vi.fn().mockResolvedValue(null),
    connect: vi.fn().mockResolvedValue(undefined),
    socket: {
      connected: true,
      subscribe: vi.fn(() => vi.fn()),
    },
    disconnect: vi.fn(),
    ...overrides,
  } as BuzzClient;
}

vi.mock('@beeline/buzz-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@beeline/buzz-client')>()),
  createBuzzClient: (...args: unknown[]) => fakeBuzzClient(mocks.createBuzzClient(...args)),
}));

import {
  DEFAULT_ROOM_DISCOVERY_RETRY_MS,
  DEFAULT_ROOM_DISCOVERY_TRANSIENT_RETRY_MS,
  isDurableRoomJoinFailure,
  isOwnerGrantNeededFailure,
  ThinDaemonCore,
} from './thin-core.js';
import { RoomRuntimeCoordinator } from './room-runtime.js';

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

function fakeWorkCalendar() {
  return {
    start: vi.fn(async () => undefined),
    refreshNow: vi.fn(async () => undefined),
    dispose: vi.fn(async () => undefined),
  };
}

describe('RoomRuntimeCoordinator removal lease', () => {
  it('requires three successful membership reads before returning agent-removed', async () => {
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
    const supervisor = new RoomRuntimeCoordinator(
      runtime,
      `/tmp/beeline/agents/${agent.identity.publicKey}/runtime.json`,
      {} as BodyConfig,
    );

    await expect(supervisor.reconcile()).resolves.toBe('unknown');
    await expect(supervisor.reconcile()).resolves.toBe('unknown');
    await expect(supervisor.reconcile()).resolves.toBe('not-member');
    expect(mocks.createBuzzClient.mock.results[0]?.value.isMember).toHaveBeenCalledTimes(3);
    expect(supervisor.activeRoomIds()).toEqual([]);
    expect(disconnect).toHaveBeenCalledTimes(3);
  });

  it('archives a corroborated removed runtime so its identity can be restored', async () => {
    const stateRoot = mkdtempSync(resolve(tmpdir(), 'beeline-removal-archive-'));
    try {
      const agent = storedIdentity('archived-agent');
      const body = storedIdentity('archived-body');
      const runtime: AgentRuntimeRecord = {
        version: 2,
        communityId: '11111111-1111-4111-8111-111111111111',
        pairedBy: 'a'.repeat(64),
        agent: agent.stored,
        body: body.stored,
        rooms: [],
        supervisorRoot: stateRoot,
        relayBaseUrl: 'http://relay.test',
        agentBinary: '/bin/true',
        mcpBinary: '/bin/true',
        createdAt: new Date(0).toISOString(),
      };
      const configPath = resolve(
        stateRoot,
        'beeline',
        'agents',
        runtime.agent.publicKey,
        'runtime.json',
      );
      mkdirSync(dirname(configPath), { recursive: true });
      writeFileSync(configPath, `${JSON.stringify(runtime)}\n`, { mode: 0o600 });
      writeFileSync(resolve(dirname(configPath), 'daemon.pid'), '4242\n');
      const isMember = vi.fn().mockResolvedValue(false);
      mocks.createBuzzClient.mockReturnValue({ isMember, disconnect: vi.fn() });
      const supervisor = new RoomRuntimeCoordinator(runtime, configPath, {} as BodyConfig);

      await expect(supervisor.reconcile()).resolves.toBe('unknown');
      await expect(supervisor.reconcile()).resolves.toBe('unknown');
      await expect(supervisor.reconcile()).resolves.toBe('not-member');
      expect(isMember).toHaveBeenCalledTimes(3);

      await removeAgentRuntime(configPath, runtime.agent.publicKey);

      expect(existsSync(configPath)).toBe(false);
      const archived = readdirSync(resolve(stateRoot, 'deleted-runtimes'));
      expect(archived).toHaveLength(1);
      expect(archived[0]).toMatch(new RegExp(`^${runtime.agent.publicKey}-`));
      expect(existsSync(resolve(stateRoot, 'deleted-runtimes', archived[0]!, 'runtime.json'))).toBe(
        true,
      );
      expect(existsSync(resolve(stateRoot, 'deleted-runtimes', archived[0]!, 'daemon.pid'))).toBe(
        false,
      );
    } finally {
      rmSync(stateRoot, { recursive: true, force: true });
    }
  });

  it('requires the successful removal reads to be consecutive', async () => {
    const agent = storedIdentity('consecutive-agent');
    const body = storedIdentity('consecutive-body');
    const runtime: AgentRuntimeRecord = {
      version: 2,
      communityId: '11111111-1111-4111-8111-111111111111',
      pairedBy: 'a'.repeat(64),
      agent: agent.stored,
      body: body.stored,
      rooms: [],
      supervisorRoot: '/tmp/beeline-consecutive-test',
      relayBaseUrl: 'http://relay.test',
      agentBinary: '/bin/true',
      mcpBinary: '/bin/true',
      createdAt: new Date(0).toISOString(),
    };
    const isMember = vi
      .fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockRejectedValueOnce(new Error('membership projection unavailable'))
      .mockResolvedValue(false);
    mocks.createBuzzClient.mockReturnValue({ isMember, disconnect: vi.fn() });
    const supervisor = new RoomRuntimeCoordinator(
      runtime,
      `/tmp/beeline/agents/${runtime.agent.publicKey}/runtime.json`,
      {} as BodyConfig,
    );
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await expect(supervisor.reconcile()).resolves.toBe('unknown');
    await expect(supervisor.reconcile()).resolves.toBe('unknown');
    await expect(supervisor.reconcile()).resolves.toBe('unknown');
    await expect(supervisor.reconcile()).resolves.toBe('unknown');
    await expect(supervisor.reconcile()).resolves.toBe('unknown');
    await expect(supervisor.reconcile()).resolves.toBe('not-member');
  });

  it('keeps a missing Room running until successful reads corroborate its removal', async () => {
    const agent = storedIdentity('room-removal-agent');
    const body = storedIdentity('room-removal-body');
    const runtime: AgentRuntimeRecord = {
      version: 2,
      communityId: '11111111-1111-4111-8111-111111111111',
      pairedBy: 'a'.repeat(64),
      agent: agent.stored,
      body: body.stored,
      rooms: [],
      supervisorRoot: '/tmp/beeline-room-removal-test',
      relayBaseUrl: 'http://relay.test',
      agentBinary: '/bin/true',
      mcpBinary: '/bin/true',
      createdAt: new Date(0).toISOString(),
    };
    mocks.createBuzzClient.mockReturnValue({
      isMember: vi.fn().mockResolvedValue(true),
      listMyChannels: vi.fn().mockResolvedValue([]),
      getChannelMetadata: vi.fn().mockResolvedValue(null),
      disconnect: vi.fn(),
    });
    const supervisor = new RoomRuntimeCoordinator(
      runtime,
      `/tmp/beeline/agents/${runtime.agent.publicKey}/runtime.json`,
      {} as BodyConfig,
    );
    const roomController = new AbortController();
    const running = (supervisor as never).running as Map<string, unknown>;
    running.set('missing-room', {
      body: { forceRecoverRoom: vi.fn() },
      controller: roomController,
      promise: Promise.resolve(),
      lastPollAt: Date.now(),
      lastPresenceAt: Date.now(),
      presence: 'online',
      backoffUntil: 0,
      recovering: false,
    });
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await expect(supervisor.reconcile()).resolves.toBe('member');
    expect(roomController.signal.aborted).toBe(false);
    await expect(supervisor.reconcile()).resolves.toBe('member');
    expect(roomController.signal.aborted).toBe(false);
    await expect(supervisor.reconcile()).resolves.toBe('member');
    expect(roomController.signal.aborted).toBe(true);
  });
});

describe('RoomRuntimeCoordinator unbound channel policy', () => {
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
      getChannelMetadata: vi.fn().mockResolvedValue(null),
      disconnect,
    });
    const supervisor = new RoomRuntimeCoordinator(
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

    await expect(supervisor.reconcile()).resolves.toBe('member');

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
      getChannelMetadata: vi.fn().mockResolvedValue(null),
      disconnect: vi.fn(),
    });
    const supervisor = new RoomRuntimeCoordinator(
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

    await expect(supervisor.reconcile()).resolves.toBe('member');

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
      getChannelMetadata: vi.fn().mockResolvedValue(null),
      disconnect: vi.fn(),
    });
    const supervisor = new RoomRuntimeCoordinator(
      runtime,
      `/tmp/beeline/agents/${runtime.agent.publicKey}/runtime.json`,
      {} as BodyConfig,
    );
    const startConversation = vi
      .spyOn(supervisor as never, 'startConversationRoom' as never)
      .mockImplementation(() => undefined as never);

    await expect(supervisor.reconcile()).resolves.toBe('member');

    expect(startConversation).toHaveBeenCalledWith('repo-less-room', 'named-repository');
  });
});

describe('RoomRuntimeCoordinator Room watchdog', () => {
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
    const supervisor = new RoomRuntimeCoordinator(
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
    const supervisor = new RoomRuntimeCoordinator(
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
      resolveRoomRepositoryState: vi.fn(async (channelId: string) => {
        const room = runtime.rooms.find((candidate) => candidate.channelId === channelId)!;
        return { kind: 'repository', repository: { channelId, binding: room.repo.repository } };
      }),
      getChannelMetadata: vi.fn().mockResolvedValue(null),
      disconnect,
    });
    const supervisor = new RoomRuntimeCoordinator(
      runtime,
      `/tmp/beeline/agents/${runtime.agent.publicKey}/runtime.json`,
      {} as BodyConfig,
    );
    const start = vi
      .spyOn(supervisor as never, 'startRepositoryRoom' as never)
      .mockImplementation(() => undefined as never);

    await expect(supervisor.reconcile()).resolves.toBe('member');

    expect(start).toHaveBeenCalledWith(runtime.rooms[0], 'stale-room');
    expect(start).toHaveBeenCalledWith(runtime.rooms[1], 'healthy-room');
    expect(disconnect).toHaveBeenCalledOnce();
  });

  it('repairs a stale runtime binding from the Room binding before restart join', async () => {
    const runtime = runtimeWithRooms();
    runtime.rooms = [runtime.rooms[0]!];
    runtime.supervisorRoot = mkdtempSync(resolve(tmpdir(), 'beeline-runtime-repair-'));
    const currentBinding = {
      key: 'room-selected-key',
      name: 'captain/selected',
      remote: 'git://github.com/captain/selected',
      localOnly: false,
      githubInstallationId: 77,
    };
    mocks.createBuzzClient.mockReturnValue({
      isMember: vi.fn().mockResolvedValue(true),
      listMyChannels: vi
        .fn()
        .mockResolvedValue([{ channelId: 'stale-room', event: { created_at: 1 } }]),
      resolveRoomRepositoryState: vi.fn().mockResolvedValue({
        kind: 'repository',
        repository: { channelId: 'stale-room', binding: currentBinding },
      }),
      getChannelMetadata: vi.fn().mockResolvedValue(null),
      disconnect: vi.fn(),
    });
    const supervisor = new RoomRuntimeCoordinator(
      runtime,
      resolve(runtime.supervisorRoot, 'runtime.json'),
      {} as BodyConfig,
    );
    vi.spyOn(supervisor as never, 'materializeRoom' as never).mockResolvedValue({
      ...runtime.rooms[0],
      repo: { ...runtime.rooms[0]!.repo, repository: currentBinding },
    } as never);
    const start = vi
      .spyOn(supervisor as never, 'startRepositoryRoom' as never)
      .mockImplementation(() => undefined as never);

    await expect(supervisor.reconcile()).resolves.toBe('member');

    expect(runtime.rooms[0]!.repo.repository).toEqual(currentBinding);
    expect(start).toHaveBeenCalledWith(
      expect.objectContaining({ repo: expect.objectContaining({ repository: currentBinding }) }),
      'stale-room',
    );
    rmSync(runtime.supervisorRoot, { recursive: true, force: true });
  });
});

describe('RoomRuntimeCoordinator transient relay resilience', () => {
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

  function liveNonRetryableHtmlErrorFixture(): Error & { nonRetryable: true } {
    // Captured production failure shape from the usebeeline.app cutover. The
    // bridge attaches `nonRetryable` after exhausting the 5xx attempts, while
    // the edge sends an HTML body instead of the relay's JSON response.
    return Object.assign(
      new Error(
        'queryEvents failed: HTTP 503 <html><body>Please try again in a few minutes.</body></html>',
      ),
      { nonRetryable: true as const },
    );
  }

  it('maps the live non-retryable HTML membership failure to unknown and keeps the runtime', async () => {
    const stateRoot = mkdtempSync(resolve(tmpdir(), 'beeline-membership-unknown-'));
    try {
      const runtime = runtimeMinimal('html-error-agent');
      runtime.supervisorRoot = stateRoot;
      const configPath = resolve(
        stateRoot,
        'beeline',
        'agents',
        runtime.agent.publicKey,
        'runtime.json',
      );
      mkdirSync(dirname(configPath), { recursive: true });
      writeFileSync(configPath, `${JSON.stringify(runtime)}\n`, { mode: 0o600 });
      const isMember = vi.fn().mockRejectedValue(liveNonRetryableHtmlErrorFixture());
      mocks.createBuzzClient.mockReturnValue({ isMember, disconnect: vi.fn() });
      const supervisor = new RoomRuntimeCoordinator(runtime, configPath, {} as BodyConfig);
      const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);

      await expect(supervisor.reconcile()).resolves.toBe('unknown');

      await expect(supervisor.reconcile()).resolves.toBe('unknown');
      await expect(supervisor.reconcile()).resolves.toBe('unknown');

      expect(existsSync(configPath)).toBe(true);
      expect(existsSync(resolve(stateRoot, 'deleted-runtimes'))).toBe(false);
      expect(errors.mock.calls.flat().join(' ')).toContain(
        'membership could not be confirmed; keeping runtime and Rooms',
      );
    } finally {
      rmSync(stateRoot, { recursive: true, force: true });
    }
  });

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
      getChannelMetadata: vi.fn().mockResolvedValue(null),
      disconnect,
    });
    const supervisor = new ThinDaemonCore(
      runtime,
      `/tmp/beeline/agents/${runtime.agent.publicKey}/runtime.json`,
      {} as BodyConfig,
      { workCalendar: fakeWorkCalendar() },
    );
    const controller = new AbortController();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);

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
    expect(errors.mock.calls.flat().join(' ')).toContain('membership could not be confirmed');
    // One per reconcile() client, plus the daemon's shared relay socket closed
    // once at teardown (same mock object backs both in this fixture).
    expect(disconnect).toHaveBeenCalledTimes(isMember.mock.calls.length + 1);
  });

  it('keeps an active corner Room running across a transient reconcile failure', async () => {
    const runtime = runtimeMinimal('corner-agent');
    mocks.createBuzzClient.mockReturnValue({
      isMember: vi.fn().mockRejectedValue(transient502()),
      getChannelMetadata: vi.fn().mockResolvedValue(null),
      disconnect: vi.fn(),
    });
    const supervisor = new RoomRuntimeCoordinator(
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

    // The destructive membership boundary maps every read failure to the
    // explicit unknown state; the corner must be untouched by the attempt.
    await expect(supervisor.reconcile()).resolves.toBe('unknown');

    expect(supervisor.activeRoomIds()).toEqual(['active-corner']);
    expect(cornerController.signal.aborted).toBe(false);
  });
});

describe('ThinDaemonCore control-plane wake signal', () => {
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
    const supervisor = new ThinDaemonCore(
      runtime,
      `/tmp/beeline/agents/${runtime.agent.publicKey}/runtime.json`,
      {} as BodyConfig,
      { reconcileHeartbeatMs: 60_000, workCalendar: fakeWorkCalendar() },
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
    mocks.createBuzzClient.mockReturnValue({
      isMember,
      listMyChannels,
      disconnect,
      connect: undefined as never,
      socket: undefined as never,
    });
    const supervisor = new ThinDaemonCore(
      runtime,
      `/tmp/beeline/agents/${runtime.agent.publicKey}/runtime.json`,
      {} as BodyConfig,
      { reconcileHeartbeatMs: 20, workCalendar: fakeWorkCalendar() },
    );
    const controller = new AbortController();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const runPromise = supervisor.run({ pollMs: 5, signal: controller.signal });
    while (isMember.mock.calls.length < 2) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 5));
    }
    expect(isMember.mock.calls.length).toBeGreaterThanOrEqual(2);
    // Only reconcile()'s own per-call client is ever disconnected — the
    // failed control-socket attempt must not double-disconnect the same
    // mock object once per reconcile call.
    expect(disconnect).toHaveBeenCalledTimes(isMember.mock.calls.length);
    expect(errors.mock.calls.flat().join(' ')).toContain('control-plane WS unavailable');

    controller.abort();
    await expect(runPromise).resolves.toBe('aborted');
  });
});

describe('RoomRuntimeCoordinator per-room storage and harness isolation', () => {
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
    return new RoomRuntimeCoordinator(runtime, configPath, {} as BodyConfig);
  }

  function roomRoot(supervisor: RoomRuntimeCoordinator, channelId: string, room?: unknown): string {
    return (Reflect.get(supervisor, 'roomRoot') as (id: string, record?: unknown) => string).call(
      supervisor,
      channelId,
      room,
    );
  }

  function agentHomeRoot(supervisor: RoomRuntimeCoordinator, workspaceRoot: string) {
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

describe('RoomRuntimeCoordinator room owns the repo (Stage 1)', () => {
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

  function supervisorFor(
    supervisorRoot: string,
    rooms: RoomRuntimeRecord[] = [],
  ): RoomRuntimeCoordinator {
    const rt = runtime(supervisorRoot, rooms);
    return new RoomRuntimeCoordinator(
      rt,
      `/tmp/beeline/agents/${rt.agent.publicKey}/runtime.json`,
      {} as BodyConfig,
    );
  }

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
      resolveServingRepo(
        room: RoomRuntimeRecord,
      ): Promise<{ localPath?: string; targetBranch?: string }>;
    };

    return supervisor.resolveServingRepo(room).then((bound) => {
      const canonical = resolve(
        supervisorRoot,
        'beeline',
        'repositories',
        opBinding.repository.key,
      );
      expect(bound.localPath).toBe(canonical);
      // The load-bearing safety property: the agent NEVER serves from the
      // operator's working tree (which carries WIP and drifts).
      expect(bound.localPath).not.toBe(operatorCheckout);
      expect(existsSync(resolve(canonical, '.git'))).toBe(true);
      expect(inspectLocalRepository(canonical).repository.key).toBe(opBinding.repository.key);
      rmSync(tmp, { recursive: true, force: true });
    });
  });

  it('seeds local-only truth into a canonical checkout and never serves the pairing root', async () => {
    const tmp = mkdtempSync(resolve(tmpdir(), 'buzzy-local-canon-'));
    const operatorCheckout = resolve(tmp, 'local-proj');
    spawnSync('git', ['init', '-q', '-b', 'main', operatorCheckout], { encoding: 'utf8' });
    spawnSync('git', ['-C', operatorCheckout, 'config', 'user.email', 't@t.local']);
    spawnSync('git', ['-C', operatorCheckout, 'config', 'user.name', 'test']);
    spawnSync('git', ['-C', operatorCheckout, 'commit', '-q', '--allow-empty', '-m', 'init']);
    const binding = inspectLocalRepository(operatorCheckout);
    const room: RoomRuntimeRecord = {
      channelId: 'local-room',
      repo: binding,
      membershipSince: 1,
      discoveredAt: new Date(0).toISOString(),
    };
    const supervisorRoot = resolve(tmp, 'state');
    const supervisor = supervisorFor(supervisorRoot, [room]) as never as {
      resolveServingRepo(room: RoomRuntimeRecord): Promise<{ localPath?: string }>;
    };
    const bound = await supervisor.resolveServingRepo(room);
    expect(bound.localPath).toBe(
      resolve(supervisorRoot, 'beeline', 'repositories', binding.repository.key),
    );
    expect(bound.localPath).not.toBe(operatorCheckout);
    expect(inspectLocalRepository(bound.localPath!).repository.localOnly).toBe(true);
    rmSync(tmp, { recursive: true, force: true });
  });
});

describe('Room join-failure classification', () => {
  it('treats known-durable reasons as durable and transport-shaped failures as transient', () => {
    expect(
      isDurableRoomJoinFailure(new Error('invited Room x is local-only on another checkout')),
    ).toBe(true);
    expect(
      isDurableRoomJoinFailure(
        new Error('publishEvent kind=9 failed: HTTP 400 {"error":"invalid: channel is archived"}'),
      ),
    ).toBe(true);
    // Everything else retries short: the cost of a wrong guess is one join
    // attempt per pass against an unservable Room; the cost of parking a
    // recoverable Room for ten minutes is an agent that reads as dead.
    expect(isDurableRoomJoinFailure(new Error('queryEvents failed: HTTP 502 bad gateway'))).toBe(
      false,
    );
    expect(
      isDurableRoomJoinFailure(
        new OidcBindError('room_repository_unauthorized', 'agent is not authorized', 403),
      ),
    ).toBe(false);
    expect(isDurableRoomJoinFailure(new Error('fetch failed'))).toBe(false);
  });

  it('recognizes the typed owner-grant-needed refusal as a pending grant, never a durable park', () => {
    const error = new OidcBindError(
      'owner_grant_needed',
      'bananaman614305/widget is waiting for its owner to grant Beeline access. Ask the repository owner to install the Beeline GitHub App: https://github.com/apps/beeline/installations/new',
      403,
      { installUrl: 'https://github.com/apps/beeline/installations/new' },
    );
    expect(isOwnerGrantNeededFailure(error)).toBe(true);
    // The daemon must keep retrying (transient) so the link completes with no
    // user re-entry once the owner installs.
    expect(isDurableRoomJoinFailure(error)).toBe(false);
    expect(isOwnerGrantNeededFailure(new Error('some other failure'))).toBe(false);
  });
});

describe('RoomRuntimeCoordinator per-Room discovery isolation', () => {
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
      messageSubmit: vi.fn().mockResolvedValue({}),
      query: vi.fn().mockResolvedValue([]),
      getChannelMetadata: vi.fn().mockResolvedValue(null),
      disconnect: vi.fn(),
    };
  }

  it('skips one unservable Room and still joins every other invited Room', async () => {
    const runtime = runtimeNoRooms('discovery-agent');
    mocks.createBuzzClient.mockReturnValue(discoveryClient(runtime));
    const supervisor = new RoomRuntimeCoordinator(
      runtime,
      `/tmp/beeline/agents/${runtime.agent.publicKey}/runtime.json`,
      {} as BodyConfig,
    );
    const startConversation = vi
      .spyOn(supervisor as never, 'startConversationRoom' as never)
      .mockImplementation(() => undefined as never);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    // The pass completes rather than throwing...
    await expect(supervisor.reconcile()).resolves.toBe('member');

    // ...and the two Rooms listed *after* the unservable one are still served.
    expect(startConversation).toHaveBeenCalledWith('good-dm', 'direct-message');
    expect(startConversation).toHaveBeenCalledWith('good-room', 'named-repository');
  });

  it('logs the unservable Room once and retries it on a long cadence, not every pass', async () => {
    const runtime = runtimeNoRooms('discovery-log-agent');
    const client = discoveryClient(runtime);
    mocks.createBuzzClient.mockReturnValue(client);
    let now = 1_000_000;
    const supervisor = new RoomRuntimeCoordinator(
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
    expect(client.messageSubmit).not.toHaveBeenCalled();

    // Past the retry cadence it is tried again — an operator who fixes the
    // underlying cause is still picked up, just not by polling every 5s.
    now += Math.ceil(DEFAULT_ROOM_DISCOVERY_RETRY_MS * 1.2) + 1;
    await supervisor.reconcile();
    expect(materialize).toHaveBeenCalledTimes(2);
    expect(client.messageSubmit).not.toHaveBeenCalled();
  });

  it('retries a transient join failure on the short cadence instead of the ten-minute park', async () => {
    // The 2026-08-23 production darkness: a relay outage got a Room
    // watchdog-recycled, and the recovery join then failed on a transient
    // authority error while the auth service was itself mid-rollout. Parking
    // that Room for ten minutes per attempt kept the agent dark long after
    // the relay was back.
    const runtime = runtimeNoRooms('transient-join-agent');
    const client = discoveryClient(runtime);
    mocks.createBuzzClient.mockReturnValue(client);
    let now = 1_000_000;
    const supervisor = new RoomRuntimeCoordinator(
      runtime,
      `/tmp/beeline/agents/${runtime.agent.publicKey}/runtime.json`,
      {} as BodyConfig,
      { now: () => now },
    );
    vi.spyOn(supervisor as never, 'startConversationRoom' as never).mockImplementation(
      () => undefined as never,
    );
    const materialize = vi
      .spyOn(supervisor as never, 'materializeRoom' as never)
      .mockRejectedValue(new Error('queryEvents failed: HTTP 502 bad gateway') as never);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await supervisor.reconcile();
    expect(client.messageSubmit).not.toHaveBeenCalled();

    // Past the SHORT cadence it is tried again — not held for ten minutes.
    // Backoff is intentionally jittered by ±20%; advance beyond its upper bound.
    now += Math.ceil(DEFAULT_ROOM_DISCOVERY_TRANSIENT_RETRY_MS * 1.2) + 1;
    await supervisor.reconcile();
    expect(materialize).toHaveBeenCalledTimes(2);
  });

  it('does not publish a recovery for a durable legacy repository failure', async () => {
    const runtime = runtimeNoRooms('repository-recovery-agent');
    const room: RoomRuntimeRecord = {
      channelId: '3f37b271-1a12-4d2a-b002-202b3f3582b9',
      repo: {
        root: '/tmp/beeline-peddle-cache',
        gitCommonDir: '/tmp/beeline-peddle-cache/.git',
        targetBranch: 'main',
        repository: {
          key: 'github:1330313701',
          name: 'bananaman614305/peddle',
          remote: 'git://github.com/bananaman614305/peddle',
          localOnly: false,
          githubInstallationId: 156013969,
        },
      },
      membershipSince: 20,
      discoveredAt: new Date(0).toISOString(),
    };
    runtime.rooms.push(room);
    const client = discoveryClient(runtime);
    client.listMyChannels.mockResolvedValue([
      { channelId: '3f37b271-1a12-4d2a-b002-202b3f3582b9', event: { created_at: 20 } },
    ]);
    client.resolveRoomRepositoryState.mockResolvedValue({
      kind: 'repository',
      repository: { binding: room.repo.repository },
    });
    const relayEvents = [
      {
        id: 'f'.repeat(64),
        pubkey: runtime.agent.publicKey,
        created_at: 900,
        kind: 9,
        tags: [['h', room.channelId]],
        content:
          "Agent unavailable: I could not access this Room's repository. " +
          'I will retry automatically in 30 seconds.',
        sig: 'e'.repeat(128),
      },
    ];
    client.query.mockImplementation(async () => [...relayEvents]);
    client.messageSubmit.mockImplementation(async (channelId, content, options) => {
      const event = {
        id: `${relayEvents.length}`.padStart(64, '0'),
        pubkey: runtime.agent.publicKey,
        created_at: 1_000 + relayEvents.length,
        kind: 9,
        tags: [['h', channelId], ...(options?.extraTags ?? [])],
        content,
        sig: 'd'.repeat(128),
      };
      relayEvents.push(event);
      return event;
    });
    mocks.createBuzzClient.mockReturnValue(client);
    const firstCoordinator = new RoomRuntimeCoordinator(
      runtime,
      `/tmp/beeline/agents/${runtime.agent.publicKey}/runtime.json`,
      {} as BodyConfig,
    );
    vi.spyOn(firstCoordinator as never, 'startRepositoryRoom' as never).mockResolvedValue(
      undefined as never,
    );
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await firstCoordinator.reconcile();
    expect(client.messageSubmit).not.toHaveBeenCalled();

    const restartedCoordinator = new RoomRuntimeCoordinator(
      runtime,
      `/tmp/beeline/agents/${runtime.agent.publicKey}/runtime.json`,
      {} as BodyConfig,
    );
    vi.spyOn(restartedCoordinator as never, 'startRepositoryRoom' as never).mockResolvedValue(
      undefined as never,
    );
    await restartedCoordinator.reconcile();

    expect(client.messageSubmit).not.toHaveBeenCalled();
  });

  it('does not publish an orphan recovery for a join failure that never produced a notice', async () => {
    const runtime = runtimeNoRooms('repository-orphan-recovery-agent');
    const room: RoomRuntimeRecord = {
      channelId: 'unservable-room',
      repo: {
        root: '/tmp/beeline-peddle-cache',
        gitCommonDir: '/tmp/beeline-peddle-cache/.git',
        targetBranch: 'main',
        repository: {
          key: 'github:1330313701',
          name: 'bananaman614305/peddle',
          remote: 'git://github.com/bananaman614305/peddle',
          localOnly: false,
          githubInstallationId: 156013969,
        },
      },
      membershipSince: 20,
      discoveredAt: new Date(0).toISOString(),
    };
    runtime.rooms.push(room);
    const client = discoveryClient(runtime);
    client.listMyChannels.mockResolvedValue([
      { channelId: 'unservable-room', event: { created_at: 20 } },
    ]);
    client.resolveRoomRepositoryState.mockResolvedValue({
      kind: 'repository',
      repository: { binding: room.repo.repository },
    });
    mocks.createBuzzClient.mockReturnValue(client);
    let now = 1_000_000;
    const supervisor = new RoomRuntimeCoordinator(
      runtime,
      `/tmp/beeline/agents/${runtime.agent.publicKey}/runtime.json`,
      {} as BodyConfig,
      { now: () => now },
    );
    vi.spyOn(supervisor as never, 'startRepositoryRoom' as never).mockResolvedValue(
      undefined as never,
    );
    Reflect.get(supervisor, 'quarantine').noteFailure(
      room.channelId,
      new Error('Room join deadline exceeded after 75000ms'),
    );
    now += Math.ceil(DEFAULT_ROOM_DISCOVERY_TRANSIENT_RETRY_MS * 1.2) + 1;
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await supervisor.reconcile();

    expect(client.query).not.toHaveBeenCalled();
    expect(client.messageSubmit).not.toHaveBeenCalled();
  });

  it('keeps a token-broker 403 in operator logs instead of Room chat', async () => {
    const runtime = runtimeNoRooms('broker-denied-agent');
    const client = discoveryClient(runtime);
    client.listMyChannels.mockResolvedValue([
      { channelId: 'unservable-room', event: { created_at: 20 } },
    ]);
    mocks.createBuzzClient.mockReturnValue(client);
    const supervisor = new RoomRuntimeCoordinator(
      runtime,
      `/tmp/beeline/agents/${runtime.agent.publicKey}/runtime.json`,
      {} as BodyConfig,
    );
    vi.spyOn(supervisor as never, 'materializeRoom' as never).mockRejectedValue(
      new OidcBindError(
        'room_repository_unauthorized',
        'agent is not authorized for this Room repository',
        403,
      ) as never,
    );
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(supervisor.reconcile()).resolves.toBe('member');

    expect(client.messageSubmit).not.toHaveBeenCalled();
  });
});

describe('RoomRuntimeCoordinator archived Room', () => {
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
      supervisorRoot: '/tmp/beeline-archived-room-test',
      relayBaseUrl: 'http://relay.test',
      agentBinary: '/bin/true',
      mcpBinary: '/bin/true',
      createdAt: new Date(0).toISOString(),
    };
  }

  /** The verbatim refusal from the captain's daemon log (`daemon.log`). */
  const ARCHIVED_QUARANTINE_ERROR = new Error(
    'publishEvent kind=9 failed: HTTP 400 {"error":"invalid: channel is archived"}',
  );

  function twoRoomClient(runtime: AgentRuntimeRecord, metadataFor: (channelId: string) => unknown) {
    return {
      isMember: vi.fn().mockResolvedValue(true),
      listMyChannels: vi.fn().mockResolvedValue([
        { channelId: 'dead-room', event: { created_at: 20 } },
        { channelId: 'live-room', event: { created_at: 21 } },
      ]),
      getChannelCommunityId: vi.fn().mockResolvedValue(runtime.communityId),
      getParentChannelId: vi.fn().mockResolvedValue(null),
      resolveRoomRepositoryState: vi.fn().mockResolvedValue({ kind: 'none' }),
      getChannelRepositoryBinding: vi.fn().mockResolvedValue(null),
      getDirectMessage: vi.fn().mockResolvedValue(null),
      getChannelMetadata: vi.fn(async (channelId: string) => metadataFor(channelId)),
      messageSubmit: vi.fn().mockResolvedValue({}),
      disconnect: vi.fn(),
    };
  }

  it('never serves a Room the relay reports as archived, and asks exactly once', async () => {
    // The relay's `channel is archived` projection is authoritative and
    // terminal. Serving the Room anyway can only end in the identical HTTP
    // 400 quarantine — the captain's daemon re-served one archived Room 161
    // times against 2 for its live Room. Discovery now reads the projection
    // before serving and drops the Room, asking once per process.
    const runtime = runtimeNoRooms('archived-proactive-agent');
    const client = twoRoomClient(runtime, (channelId) =>
      channelId === 'dead-room' ? { archived: true } : { archived: false },
    );
    mocks.createBuzzClient.mockReturnValue(client);
    const supervisor = new RoomRuntimeCoordinator(
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
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(supervisor.reconcile()).resolves.toBe('member');
    await expect(supervisor.reconcile()).resolves.toBe('member');
    await expect(supervisor.reconcile()).resolves.toBe('member');

    // The dead Room is never served...
    const deadStarts = [...startConversation.mock.calls, ...startRepository.mock.calls].filter(
      (call) => call[0] === 'dead-room',
    );
    expect(deadStarts).toHaveLength(0);
    // ...the live Room is served on every pass...
    expect(startConversation).toHaveBeenCalledWith('live-room', 'named-repository');
    // ...the archived answer was read exactly ONCE across all three passes
    // (held inert afterwards; not re-polled), and said so once.
    expect(client.getChannelMetadata).toHaveBeenCalledWith('dead-room');
    expect(
      client.getChannelMetadata.mock.calls.filter((call) => call[0] === 'dead-room'),
    ).toHaveLength(1);
    const dropLogs = errors.mock.calls.filter(
      (call) => String(call[0]).includes('dead-room') && String(call[0]).includes('archived'),
    );
    expect(dropLogs).toHaveLength(1);
  });

  it('treats an archived-channel quarantine as terminal and never retries it', async () => {
    // The observed failure mode: the archive lands between discovery's
    // metadata read and the first serve, so the Room is started and its loop
    // dies on `publishEvent ... HTTP 400 channel is archived`. That answer is
    // a fact about the Room, not a transient failure — quarantine must stop
    // the retry outright instead of re-serving the Room every pass.
    const runtime = runtimeNoRooms('archived-reactive-agent');
    const client = twoRoomClient(runtime, () => null); // read answers nothing useful
    mocks.createBuzzClient.mockReturnValue(client);
    const supervisor = new RoomRuntimeCoordinator(
      runtime,
      `/tmp/beeline/agents/${runtime.agent.publicKey}/runtime.json`,
      {} as BodyConfig,
    );
    const startConversation = vi
      .spyOn(supervisor as never, 'startConversationRoom' as never)
      .mockImplementation(() => undefined as never);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    // The serving loop died with the verbatim relay refusal:
    (supervisor as never).handleQuarantinedRoom('dead-room', ARCHIVED_QUARANTINE_ERROR);

    // ...and discovery must never pick it back up.
    await expect(supervisor.reconcile()).resolves.toBe('member');
    await expect(supervisor.reconcile()).resolves.toBe('member');
    expect(client.getChannelMetadata).not.toHaveBeenCalledWith('dead-room');
    const deadStarts = startConversation.mock.calls.filter((call) => call[0] === 'dead-room');
    expect(deadStarts).toHaveLength(0);
  });

  it('keeps retrying a Room quarantined by an ordinary error', async () => {
    // Only the archived verdict is terminal. Any other quarantine stays
    // retryable — the pre-existing behaviour for transient Room failures.
    const runtime = runtimeNoRooms('ordinary-quarantine-agent');
    const client = twoRoomClient(runtime, () => ({ archived: false }));
    mocks.createBuzzClient.mockReturnValue(client);
    let now = 1_000;
    const supervisor = new RoomRuntimeCoordinator(
      runtime,
      `/tmp/beeline/agents/${runtime.agent.publicKey}/runtime.json`,
      {} as BodyConfig,
      { now: () => now },
    ) as never as { handleQuarantinedRoom(id: string, error: unknown): void };

    supervisor.handleQuarantinedRoom('live-room', new Error('relay socket hang up'));

    // Transport quarantine is short and bounded, but no longer immediate.
    await expect(
      (supervisor as unknown as { reconcile(): Promise<string> }).reconcile(),
    ).resolves.toBe('member');
    expect(client.getChannelMetadata).not.toHaveBeenCalledWith('live-room');
    now += Math.ceil(DEFAULT_ROOM_DISCOVERY_TRANSIENT_RETRY_MS * 1.2) + 1;
    await expect(
      (supervisor as unknown as { reconcile(): Promise<string> }).reconcile(),
    ).resolves.toBe('member');
    // It is offered again after the bounded backoff.
    expect(client.getChannelMetadata).toHaveBeenCalledWith('live-room');
  });

  it('classifies only the archived-channel refusal as terminal', async () => {
    const { isArchivedChannelError } = await import('./thin-core.js');
    expect(isArchivedChannelError(ARCHIVED_QUARANTINE_ERROR)).toBe(true);
    expect(isArchivedChannelError('HTTP 400 {"error":"invalid: Channel is Archived"}')).toBe(true);
    // Retryable codes and unrelated failures stay out.
    expect(isArchivedChannelError(new Error('queryEvents failed: HTTP 429'))).toBe(false);
    expect(isArchivedChannelError(new Error('HTTP 408 request timeout'))).toBe(false);
    expect(isArchivedChannelError(new Error('HTTP 500 Bad Gateway'))).toBe(false);
    expect(isArchivedChannelError(new Error('socket hang up'))).toBe(false);
  });
});

describe('RoomRuntimeCoordinator agent soul freshness', () => {
  function runtimeNoRooms(name: string): AgentRuntimeRecord {
    const agent = storedIdentity(`${name}-agent`);
    const body = storedIdentity(`${name}-body`);
    return {
      version: 2,
      communityId: '22222222-2222-4222-8222-222222222222',
      pairedBy: 'a'.repeat(64),
      agent: agent.stored,
      body: body.stored,
      rooms: [],
      supervisorRoot: '/tmp/beeline-soul-freshness-test',
      relayBaseUrl: 'http://relay.test',
      agentBinary: '/bin/true',
      mcpBinary: '/bin/true',
      createdAt: new Date(0).toISOString(),
    };
  }

  function coordinatorHarness(runtime: AgentRuntimeRecord) {
    const supervisor = new RoomRuntimeCoordinator(
      runtime,
      `/tmp/beeline/agents/${runtime.agent.publicKey}/runtime.json`,
      {} as BodyConfig,
    ) as unknown as {
      running: Map<string, { body: { refreshPersonaForSoulUpdate: () => Promise<void> } }>;
      refreshPersonaIfSoulChanged(client: {
        listAgents: (communityId: string) => Promise<unknown[]>;
      }): Promise<void>;
    };
    const refreshPersonaForSoulUpdate = vi.fn().mockResolvedValue(undefined);
    supervisor.running.set('some-room', { body: { refreshPersonaForSoulUpdate } });
    return { supervisor, refreshPersonaForSoulUpdate };
  }

  it('refreshes the startup declaration from the current persona name', async () => {
    const runtime = runtimeNoRooms('declaration');
    const syncAgentDeclaration = vi.fn().mockResolvedValue(undefined);
    mocks.createBuzzClient.mockReturnValue(
      fakeBuzzClient({
        listAgents: vi.fn().mockResolvedValue([
          {
            pubkey: runtime.agent.publicKey,
            displayName: 'Arlo',
            soulProfile: { updatedAt: 100, name: 'Ox', soul: 'a persona' },
          },
        ]),
        syncAgentDeclaration,
      }),
    );
    const supervisor = new RoomRuntimeCoordinator(
      runtime,
      `/tmp/beeline/agents/${runtime.agent.publicKey}/runtime.json`,
      {} as BodyConfig,
    );

    await expect(supervisor.reconcile()).resolves.toBe('member');
    expect(syncAgentDeclaration).toHaveBeenCalledWith(runtime.communityId, { displayName: 'Ox' });
  });

  it('never refreshes on the first read — it only seeds the baseline', async () => {
    const runtime = runtimeNoRooms('baseline');
    const { supervisor, refreshPersonaForSoulUpdate } = coordinatorHarness(runtime);
    const listAgents = vi.fn().mockResolvedValue([
      {
        pubkey: runtime.agent.publicKey,
        soulProfile: { updatedAt: 100, name: 'Ox', soul: 'street dialect' },
      },
    ]);

    await supervisor.refreshPersonaIfSoulChanged({ listAgents });

    expect(refreshPersonaForSoulUpdate).not.toHaveBeenCalled();
  });

  it('forces every Room session back through activation once a newer soul is observed', async () => {
    const runtime = runtimeNoRooms('changed');
    const { supervisor, refreshPersonaForSoulUpdate } = coordinatorHarness(runtime);
    const soulAt = (updatedAt: number) =>
      vi.fn().mockResolvedValue([
        {
          pubkey: runtime.agent.publicKey,
          soulProfile: { updatedAt, name: 'Ox', soul: 'a persona' },
        },
      ]);

    await supervisor.refreshPersonaIfSoulChanged({ listAgents: soulAt(100) });
    expect(refreshPersonaForSoulUpdate).not.toHaveBeenCalled();

    // A human saves an edited soul — the next reconcile pass observes a
    // newer `updatedAt` and must force a re-activation on every Room this
    // daemon serves, never mid-turn (Body.refreshPersonaForSoulUpdate itself
    // only suspends idle sessions).
    await supervisor.refreshPersonaIfSoulChanged({ listAgents: soulAt(200) });
    expect(refreshPersonaForSoulUpdate).toHaveBeenCalledTimes(1);

    // An unchanged read on the next heartbeat must not re-trigger it.
    await supervisor.refreshPersonaIfSoulChanged({ listAgents: soulAt(200) });
    expect(refreshPersonaForSoulUpdate).toHaveBeenCalledTimes(1);
  });

  it('tolerates a failed freshness read without losing the last-known baseline', async () => {
    const runtime = runtimeNoRooms('resilient');
    const { supervisor, refreshPersonaForSoulUpdate } = coordinatorHarness(runtime);
    const soulAt = (updatedAt: number) =>
      vi.fn().mockResolvedValue([
        {
          pubkey: runtime.agent.publicKey,
          soulProfile: { updatedAt, name: 'Ox', soul: 'a persona' },
        },
      ]);

    await supervisor.refreshPersonaIfSoulChanged({ listAgents: soulAt(100) });
    const freshnessError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await supervisor.refreshPersonaIfSoulChanged({
      listAgents: vi.fn().mockRejectedValue(new Error('relay unavailable')),
    });
    expect(refreshPersonaForSoulUpdate).not.toHaveBeenCalled();
    expect(freshnessError).toHaveBeenCalledWith(
      expect.stringContaining('agent soul freshness check failed'),
      expect.objectContaining({ message: 'relay unavailable' }),
    );

    await supervisor.refreshPersonaIfSoulChanged({ listAgents: soulAt(200) });
    expect(refreshPersonaForSoulUpdate).toHaveBeenCalledTimes(1);
  });
});
