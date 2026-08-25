import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { git, newIdentity } from '@beeline/gate';
import type { BodyConfig } from './config.js';
import type { AgentRuntimeRecord } from './runtime.js';

const mocks = vi.hoisted(() => ({ createBuzzClient: vi.fn() }));
vi.mock('@beeline/buzz-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@beeline/buzz-client')>()),
  createBuzzClient: mocks.createBuzzClient,
}));

import { mapWithConcurrency, ThinDaemonCore } from './thin-core.js';
import { RoomRuntimeCoordinator } from './room-runtime.js';

function stored(name: string) {
  const identity = newIdentity(name);
  return {
    name,
    secretKeyHex: Buffer.from(identity.secretKey).toString('hex'),
    publicKey: identity.publicKey,
  };
}

function runtime(): AgentRuntimeRecord {
  return {
    version: 2,
    communityId: '11111111-1111-4111-8111-111111111111',
    pairedBy: 'a'.repeat(64),
    agent: stored('thin-agent'),
    body: stored('thin-body'),
    rooms: [],
    supervisorRoot: '/tmp/beeline-thin-core-test',
    relayBaseUrl: 'http://relay.invalid',
    agentBinary: '/bin/true',
    mcpBinary: '/bin/true',
    createdAt: new Date(0).toISOString(),
  };
}

describe('ThinDaemonCore', () => {
  it('lets other Rooms progress while one bounded-concurrency slot is stalled', async () => {
    let release!: () => void;
    const stalled = new Promise<void>((resolve) => {
      release = resolve;
    });
    const completed: number[] = [];
    const work = mapWithConcurrency([0, 1, 2, 3], 3, async (value) => {
      if (value === 0) await stalled;
      else completed.push(value);
    });
    await vi.waitFor(() => expect(completed).toEqual([1, 2, 3]));
    release();
    await work;
  });

  it("kills one Room's stalled Git worker without blocking other Rooms or restarting the core", async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'beeline-thin-git-stall-'));
    const helper = resolve(root, 'git');
    const priorGit = process.env.BEELINE_GIT_BINARY;
    await writeFile(helper, '#!/bin/sh\ntrap "" TERM\n(trap "" TERM; sleep 30) &\nwait\n', {
      mode: 0o755,
    });
    process.env.BEELINE_GIT_BINARY = helper;
    const daemonPid = process.pid;
    const completionOrder: string[] = [];
    try {
      await mapWithConcurrency(['stalled', 'healthy-a', 'healthy-b'], 3, async (room) => {
        if (room === 'stalled') {
          const result = await git(root, ['status'], { timeoutMs: 50, killGraceMs: 50 });
          expect(result.timedOut).toBe(true);
          completionOrder.push(room);
          return;
        }
        completionOrder.push(room);
      });
    } finally {
      if (priorGit === undefined) delete process.env.BEELINE_GIT_BINARY;
      else process.env.BEELINE_GIT_BINARY = priorGit;
      await rm(root, { recursive: true, force: true });
    }

    expect(completionOrder.slice(0, 2).sort()).toEqual(['healthy-a', 'healthy-b']);
    expect(completionOrder[2]).toBe('stalled');
    expect(process.pid).toBe(daemonPid);
  });

  it('quiesces and force-recovers continuous work at the absolute drain deadline', async () => {
    let finishRoom!: () => void;
    const roomPromise = new Promise<void>((resolveRoom) => {
      finishRoom = resolveRoom;
    });
    const controller = new AbortController();
    const forceRecoverRoom = vi.fn(async () => finishRoom());
    const core = new RoomRuntimeCoordinator(
      runtime(),
      '/tmp/beeline-thin-core-test/runtime.json',
      {} as BodyConfig,
      { drainDeadlineMs: 20 },
    ) as unknown as {
      running: Map<string, unknown>;
      stopAll(): Promise<void>;
    };
    core.running.set('busy-room', {
      body: { forceRecoverRoom },
      controller,
      promise: roomPromise,
      lastPollAt: 0,
      lastPresenceAt: 0,
      presence: 'online',
      backoffUntil: 0,
      recovering: false,
    });

    const startedAt = Date.now();
    await core.stopAll();
    expect(controller.signal.aborted).toBe(true);
    expect(forceRecoverRoom).toHaveBeenCalledWith('busy-room');
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  it('declares READY before relay health and emits degraded heartbeat only after a tick', async () => {
    const order: string[] = [];
    const controller = new AbortController();
    const client = {
      connect: vi.fn(async () => {
        order.push('connect');
        throw new Error('relay outage');
      }),
      isMember: vi.fn(async () => {
        order.push('membership');
        throw new Error('relay outage');
      }),
      disconnect: vi.fn(),
    };
    mocks.createBuzzClient.mockReturnValue(client);
    const workCalendar = {
      start: vi.fn(async () => order.push('calendar:start')),
      refreshNow: vi.fn(async () => undefined),
      dispose: vi.fn(async () => order.push('calendar:dispose')),
    };
    const core = new ThinDaemonCore(
      runtime(),
      '/tmp/beeline-thin-core-test/runtime.json',
      {} as BodyConfig,
      { reconcileHeartbeatMs: 10, workCalendar },
    );

    await core.run({
      signal: controller.signal,
      pollMs: 1,
      onEstablished: () => {
        order.push('ready');
      },
      onProgress: (status) => {
        order.push(`progress:${status}`);
        controller.abort();
      },
    });

    expect(order[0]).toBe('ready');
    expect(order).toContain('connect');
    // Relay membership remained unknown, so no Room authority existed from
    // which the calendar could safely start.
    expect(workCalendar.start).not.toHaveBeenCalled();
    expect(order.some((value) => value.startsWith('progress:relay membership degraded'))).toBe(
      true,
    );
    // Relay failure degrades STATUS; it does not suppress the loop heartbeat.
    expect(order.findIndex((value) => value.startsWith('progress:'))).toBeGreaterThan(
      order.indexOf('membership'),
    );
    expect(workCalendar.dispose).toHaveBeenCalledOnce();
  });

  it('starts its one calendar only after Room reconciliation establishes authority', async () => {
    const order: string[] = [];
    const controller = new AbortController();
    const workCalendar = {
      start: vi.fn(async () => order.push('calendar:start')),
      refreshNow: vi.fn(async () => undefined),
      dispose: vi.fn(async () => order.push('calendar:dispose')),
    };
    const core = new ThinDaemonCore(
      runtime(),
      '/tmp/beeline-thin-core-test/runtime.json',
      {} as BodyConfig,
      { workCalendar },
    );
    const roomRuntime = Reflect.get(core, 'roomRuntime') as {
      reconcile: () => Promise<'member'>;
      watchdogTick: () => Promise<void>;
      activeRoomCount: () => number;
    };
    vi.spyOn(roomRuntime, 'reconcile').mockImplementation(async () => {
      order.push('rooms:reconciled');
      return 'member';
    });
    vi.spyOn(roomRuntime, 'watchdogTick').mockResolvedValue(undefined);
    vi.spyOn(roomRuntime, 'activeRoomCount').mockReturnValue(0);
    const relaySocket = Reflect.get(core, 'relaySocket') as {
      connected: () => Promise<never>;
    };
    vi.spyOn(relaySocket, 'connected').mockRejectedValue(new Error('no fake socket'));

    await core.run({
      signal: controller.signal,
      pollMs: 1,
      onProgress: () => controller.abort(),
    });

    expect(order.indexOf('calendar:start')).toBeGreaterThan(order.indexOf('rooms:reconciled'));
    expect(workCalendar.start).toHaveBeenCalledOnce();
    expect(workCalendar.dispose).toHaveBeenCalledOnce();
  });

  it('retries calendar startup on the bounded core cadence after a state failure', async () => {
    const controller = new AbortController();
    const startupFailure = new Error('durable calendar state unavailable');
    const workCalendar = {
      start: vi.fn().mockRejectedValueOnce(startupFailure).mockResolvedValueOnce(undefined),
      refreshNow: vi.fn(async () => undefined),
      dispose: vi.fn(async () => undefined),
    };
    const core = new ThinDaemonCore(
      runtime(),
      '/tmp/beeline-thin-core-test/runtime.json',
      {} as BodyConfig,
      { reconcileHeartbeatMs: 60_000, workCalendar },
    );
    const roomRuntime = Reflect.get(core, 'roomRuntime') as {
      reconcile: () => Promise<'member'>;
      watchdogTick: () => Promise<void>;
      activeRoomCount: () => number;
    };
    const reconcile = vi.spyOn(roomRuntime, 'reconcile').mockResolvedValue('member');
    vi.spyOn(roomRuntime, 'watchdogTick').mockResolvedValue(undefined);
    vi.spyOn(roomRuntime, 'activeRoomCount').mockReturnValue(0);
    const relaySocket = Reflect.get(core, 'relaySocket') as {
      connected: () => Promise<never>;
    };
    vi.spyOn(relaySocket, 'connected').mockRejectedValue(new Error('no fake socket'));
    const startError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let progressTicks = 0;

    await core.run({
      signal: controller.signal,
      pollMs: 1,
      onProgress: () => {
        progressTicks += 1;
        if (progressTicks >= 3) controller.abort();
      },
    });

    expect(workCalendar.start).toHaveBeenCalledTimes(2);
    expect(reconcile).toHaveBeenCalledTimes(2);
    expect(startError).toHaveBeenCalledWith('[thin-core] work calendar start failed:', startupFailure);
    expect(workCalendar.dispose).toHaveBeenCalledOnce();
  });
});
