import { execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DaemonApiError, type DaemonApiClient } from './daemon-api-client.js';
import {
  HELPER_EXIT_CODES,
  HELPER_HARD_STOP_MS,
  HelperLifecycle,
  retryBeforeReady,
  successorRollbackAllowed,
} from './helper-lifecycle.js';
import { ManagedUpdateDrain, type ManagedUpdateHandoff } from './managed-update.js';
import { identityFromKey, type AgentRuntimeRecord } from './runtime.js';
import { ThinDaemonCore } from './thin-core.js';

const execFileAsync = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const networkFailure = () =>
  Object.assign(new TypeError('fetch failed'), {
    cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
  });

/** A real core whose one Room is busy until the test says otherwise. */
async function coreWithRoom() {
  const root = await mkdtemp(join(tmpdir(), 'beeline-lifecycle-'));
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
  const core = new ThinDaemonCore(runtime, join(root, 'agent.json'), { workspaceRoot: root } as never, {
    daemonApi: { execute: vi.fn(), setRoomsChangedListener: vi.fn() } as unknown as DaemonApiClient,
  });
  const turn = { busy: true };
  const room = {
    body: { isBusy: () => turn.busy, prepareForForcedUpdateRestart: vi.fn(), forceRecoverRoom: vi.fn() },
    controller: new AbortController(),
    promise: Promise.resolve(),
  };
  const internal = core as unknown as {
    roomRuntime: {
      running: Map<string, unknown>;
      restartRequested: boolean;
      setDiscoveryWakeListener(listener: () => void): void;
    };
  };
  internal.roomRuntime.running.set('room-1', room);
  const discovery = vi.fn();
  internal.roomRuntime.setDiscoveryWakeListener(discovery);
  /** What every Room and corner loop asks before claiming a turn. */
  const canStartTurn = () => !internal.roomRuntime.restartRequested;
  return { core, turn, room, discovery, canStartTurn };
}

function lifecycle() {
  const controller = new AbortController();
  const exitProcess = vi.fn();
  return { controller, exitProcess, lifecycle: new HelperLifecycle({ controller, exitProcess }) };
}

describe('HelperLifecycle', () => {
  it('maps every exit reason to one of 0, 75, 77, 78 or 79', () => {
    expect(new Set(Object.values(HELPER_EXIT_CODES))).toEqual(new Set([0, 75, 77, 78, 79]));
    expect(HELPER_EXIT_CODES).toMatchObject({
      stopped: 0,
      'restart-requested': 0,
      update: 0,
      failed: 75,
      'rolled-back': 75,
      'force-update-failed': 75,
      distress: 77,
      'agent-removed': 78,
      'unknown-agent': 79,
    });
  });

  it('holds a managed update while a turn runs and quiesces once it settles', async () => {
    const { core, turn, canStartTurn } = await coreWithRoom();
    const { lifecycle: helper } = lifecycle();
    expect(helper.quiesceUpdateIfIdle(() => core.quiesceForUpdateIfIdle())).toBe(false);
    expect(helper.state).toEqual({ kind: 'serving' });
    expect(canStartTurn()).toBe(true);
    turn.busy = false;
    expect(helper.quiesceUpdateIfIdle(() => core.quiesceForUpdateIfIdle())).toBe(true);
    expect(helper.state).toEqual({ kind: 'quiescing', reason: 'update' });
    expect(canStartTurn()).toBe(false);
  });

  it('lets /restart take over a waiting update and cancel at once', async () => {
    const { core, room } = await coreWithRoom();
    const { lifecycle: helper, controller, exitProcess } = lifecycle();
    helper.quiesce('update');
    expect(helper.quiesce('update')).toBe(false);
    expect(helper.quiesce('restart')).toBe(true);
    await expect(core.cancelActiveWorkForRestart()).resolves.toBe(true);
    expect(room.body.prepareForForcedUpdateRestart).toHaveBeenCalledOnce();
    helper.stop('restart-requested');
    expect(controller.signal.aborted).toBe(true);
    helper.exit(helper.stopReason!);
    expect(exitProcess).toHaveBeenCalledWith(0);
  });

  it('stops hard 80 s after SIGTERM if shutdown never finishes', async () => {
    vi.useFakeTimers();
    const { lifecycle: helper, controller, exitProcess } = lifecycle();
    const emitter = new EventEmitter();
    const dispose = helper.installSignals(emitter);
    emitter.emit('SIGTERM');
    expect(controller.signal.aborted).toBe(true);
    expect(helper.state).toEqual({ kind: 'stopping', reason: 'stopped' });
    await vi.advanceTimersByTimeAsync(HELPER_HARD_STOP_MS - 1);
    expect(exitProcess).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(HELPER_HARD_STOP_MS).toBe(80_000);
    expect(exitProcess).toHaveBeenCalledOnce();
    expect(exitProcess).toHaveBeenCalledWith(0);
    dispose();
  });

  it('serves turns again after a managed restart fails', async () => {
    const { core, turn, discovery, canStartTurn } = await coreWithRoom();
    turn.busy = false;
    const { lifecycle: helper, controller } = lifecycle();
    const update = {
      restartRequest: async (quiesceIfIdle: () => boolean) => {
        if (!quiesceIfIdle()) return { kind: 'none' as const };
        return {
          kind: 'restart' as const,
          request: { loadedRelease: 'a', desiredRelease: 'b', drainDeadlineAt: Date.now() },
        };
      },
    } as unknown as ManagedUpdateHandoff;
    const drain = new ManagedUpdateDrain({
      update,
      quiesceIfIdle: () => helper.quiesceUpdateIfIdle(() => core.quiesceForUpdateIfIdle()),
      activeTurnCount: () => core.activeTurnCount(),
      restart: async () => {
        throw new Error('staged release lost activation race');
      },
      log: () => undefined,
    });
    // The same recovery the daemon wires around every update tick.
    await drain.tick().catch(() => helper.resumeAfterFailedUpdate(() => core.resumeServing()));
    expect(helper.state).toEqual({ kind: 'serving' });
    expect(controller.signal.aborted).toBe(false);
    expect(canStartTurn()).toBe(true);
    expect(discovery).toHaveBeenCalled();
  });

  it('logs an unhandled rejection in the daemon and keeps the process up', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'beeline-unhandled-'));
    roots.push(dir);
    const script = join(dir, 'probe.ts');
    await writeFile(
      script,
      `import { installUnhandledRejectionGuard } from ${JSON.stringify(
        new URL('./helper-lifecycle.ts', import.meta.url).pathname,
      )};
installUnhandledRejectionGuard();
void Promise.reject(new Error('stray promise'));
setTimeout(() => console.log('still serving'), 50);
`,
    );
    const { stdout, stderr } = await execFileAsync(process.execPath, ['--import', 'tsx', script], {
      cwd: new URL('..', import.meta.url).pathname,
    });
    expect(stdout).toContain('still serving');
    expect(stderr).toContain('[thin-core] unhandled rejection (kept running):');
    expect(stderr).toContain('stray promise');
  });
});

describe('before READY', () => {
  it('waits for the link while the network is down, extending the start timeout, with no rollback', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const opens = new Set<() => void>();
    const extend = vi.fn(async () => undefined);
    let networkUp = false;
    const work = vi.fn(async () => {
      if (!networkUp) throw networkFailure();
      return 'replayed';
    });
    const deadlineAt = Date.now() + 10 * 60_000;
    let settled: unknown;
    const replay = retryBeforeReady(work, {
      onLinkOpen: (listener) => {
        opens.add(listener);
        return () => opens.delete(listener);
      },
      extendStartTimeout: extend,
      deadlineAt,
    }).then((value) => (settled = value), (error) => (settled = error));
    // The bounded early retries, then nothing but waiting on the link.
    await vi.advanceTimersByTimeAsync(1_000 + 5_000 + 30_000);
    expect(work).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(4 * 60_000);
    expect(work).toHaveBeenCalledTimes(4);
    expect(settled).toBeUndefined();
    expect(extend).toHaveBeenCalled();
    expect(extend.mock.calls.every(([ms]) => (ms as number) <= 75_000)).toBe(true);
    // While waiting, a failure is never grounds for a successor rollback.
    expect(successorRollbackAllowed(networkFailure(), deadlineAt)).toBe(false);
    networkUp = true;
    for (const open of [...opens]) open();
    await vi.advanceTimersByTimeAsync(0);
    await replay;
    expect(settled).toBe('replayed');
    expect(work).toHaveBeenCalledTimes(5);
  });

  it('lets the failure through only at the attempt deadline, or at once for a real fault', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const deadlineAt = Date.now() + 120_000;
    const replay = retryBeforeReady(async () => {
      throw networkFailure();
    }, { onLinkOpen: () => () => undefined, extendStartTimeout: async () => undefined, deadlineAt });
    const failed = expect(replay).rejects.toThrow('fetch failed');
    await vi.advanceTimersByTimeAsync(120_000);
    await failed;
    expect(successorRollbackAllowed(networkFailure(), deadlineAt, deadlineAt)).toBe(true);

    const fault = new Error('successor cannot read its runtime');
    await expect(
      retryBeforeReady(async () => {
        throw fault;
      }, { onLinkOpen: () => () => undefined, extendStartTimeout: async () => undefined, deadlineAt }),
    ).rejects.toBe(fault);
    expect(successorRollbackAllowed(fault, Date.now() + 60_000)).toBe(true);
    expect(successorRollbackAllowed(new DaemonApiError('bad', 502, true), Date.now() + 60_000))
      .toBe(false);
  });
});
