
import { mkdir as m44_mkdir, mkdtemp as m44_mkdtemp, readdir as m44_readdir, rm as m44_rm } from 'node:fs/promises';

import { resolve as m44_resolve } from 'node:path';

import { afterEach as m44_afterEach, expect as m44_expect, it as m44_it, vi as m44_vi } from 'vitest';

import { ThinDaemonCore as m44_ThinDaemonCore } from "./thin-core.js";

import { DaemonApiError as m44_DaemonApiError, type DaemonApiClient as m44_DaemonApiClient } from "./daemon-api-client.js";

import { identityFromKey as m44_identityFromKey, type AgentRuntimeRecord as m44_AgentRuntimeRecord } from "./runtime.js";

import { startLocalWatchdog as m44_startLocalWatchdog } from "./systemd.js";

import * as m44_recovery from "./corner-disk-recovery.js";

import type { CornerWorktree as m44_CornerWorktree, RoomRuntimeCoordinator as m44_RoomRuntimeCoordinator } from "./room-runtime.js";
import { describe as mergedDescribe44 } from 'vitest';
mergedDescribe44("workloop-watchdog.test.ts", () => {


const roots: string[] = [];

m44_afterEach(async () => {
  m44_vi.useRealTimers(); m44_vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(root => m44_rm(root, { recursive: true, force: true })));
});


async function fixture(execute: ReturnType<typeof m44_vi.fn>) {
  const root = await m44_mkdtemp(m44_resolve(process.cwd(), '.watchdog-test-'));
  roots.push(root);
  const agent = m44_identityFromKey('11'.repeat(32), 'Bee');
  let wake!: () => void;
  const reconnect = m44_vi.fn();
  const api = { execute, link: { reconnectNow: reconnect }, setRoomsChangedListener: (listener: () => void) => { wake = listener; } } as unknown as m44_DaemonApiClient;
  const core = new m44_ThinDaemonCore({
    agent: { publicKey: agent.publicKey, secretKeyHex: '11'.repeat(32), name: 'Bee' },
    rooms: [], communityId: 'workspace', supervisorRoot: root,
    transport: { kind: 'monolith', baseUrl: 'http://127.0.0.1', daemonToken: 'fixture' },
  } as unknown as m44_AgentRuntimeRecord, m44_resolve(root, 'runtime.json'), { workspaceRoot: root } as never, { daemonApi: api });
  return { core, root, reconnect, wake: () => wake() };
}


m44_it('stops renewing the 180-second watchdog when reconcile freezes while the event loop runs', async () => {
  let unblock!: () => void;
  const blocked = new Promise<void>(resolveBlocked => { unblock = resolveBlocked; });
  const execute = m44_vi.fn().mockResolvedValueOnce({ workspaceIds: ['workspace'], rooms: [] })
    .mockImplementation(async () => { await blocked; return { workspaceIds: ['workspace'], rooms: [] }; });
  const { core, wake } = await fixture(execute);
  const controller = new AbortController();
  const progress = m44_vi.fn();
  const running = core.run({ signal: controller.signal, onProgress: progress });
  await m44_vi.waitFor(() => m44_expect(progress).toHaveBeenCalledTimes(1));
  m44_vi.useFakeTimers();
  let lastFeed = Date.now();
  const feed = m44_vi.fn(async () => { lastFeed = Date.now(); });
  const stalled = m44_vi.fn(() => core.workLoopDiagnostics());
  const stop = m44_startLocalWatchdog({ progress: feed }, () => 'healthy', () => core.requestWorkLoopProgress(),
    60_000, { WATCHDOG_USEC: '180000000' }, undefined, stalled);
  try {
    await m44_vi.advanceTimersByTimeAsync(60_000);
    m44_expect(feed).toHaveBeenCalledTimes(1);
    m44_expect(execute).toHaveBeenCalledTimes(1); // local health never discovers Rooms
    wake();
    await m44_vi.advanceTimersByTimeAsync(0);
    m44_expect(execute).toHaveBeenCalledTimes(2);
    await m44_vi.advanceTimersByTimeAsync(180_000);
    m44_expect(feed).toHaveBeenCalledTimes(1);
    m44_expect(Date.now() - lastFeed).toBe(180_000); // systemd's configured expiry
    m44_expect(stalled).toHaveBeenCalledTimes(1);
    m44_expect(stalled.mock.results[0]?.value).toEqual({ stage: 'bootstrap', elapsedMs: 120_000 });
  } finally {
    stop(); controller.abort(); unblock(); await running;
  }
  m44_expect(core.workLoopDiagnostics().stage).toBe('idle');
});


m44_it('answers local watchdog wakes after a failed discovery and reads again on reconnect', async () => {
  const execute = m44_vi.fn().mockRejectedValueOnce(new m44_DaemonApiError('Machine operation outcome is UNKNOWN', 503, true, 'outcome_unknown'))
    .mockResolvedValue({ workspaceIds: ['workspace'], rooms: [] });
  m44_vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const { core, wake, reconnect } = await fixture(execute);
  const controller = new AbortController();
  const progress = m44_vi.fn();
  const running = core.run({ signal: controller.signal, onProgress: progress });
  await m44_vi.waitFor(() => m44_expect(progress).toHaveBeenCalledOnce());
  m44_vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  const feed = m44_vi.fn(async () => undefined);
  const stop = m44_startLocalWatchdog({ progress: feed }, () => 'degraded',
    () => core.requestWorkLoopProgress(), 60_000, { WATCHDOG_USEC: '180000000' });
  try {
    await m44_vi.advanceTimersByTimeAsync(3_600_000);
    m44_expect(feed).toHaveBeenCalledTimes(60);
    m44_expect(reconnect).not.toHaveBeenCalled();
    m44_expect(execute).toHaveBeenCalledOnce();
    wake();
    await m44_vi.advanceTimersByTimeAsync(0);
    m44_expect(execute).toHaveBeenCalledTimes(2);
  } finally { stop(); controller.abort(); await running; }
});


m44_it.each([401, 403, 404])('parks a non-retryable %s discovery request while local health keeps progressing', async status => {
  const execute = m44_vi.fn(async () => { throw new m44_DaemonApiError('refused', status, false); });
  const error = m44_vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const { core, wake } = await fixture(execute);
  const controller = new AbortController();
  const progress = m44_vi.fn();
  const running = core.run({ signal: controller.signal, onProgress: progress });
  await m44_vi.waitFor(() => m44_expect(progress).toHaveBeenCalledTimes(1));
  m44_vi.useFakeTimers();
  const feed = m44_vi.fn(async () => undefined);
  const stop = m44_startLocalWatchdog({ progress: feed }, () => 'refused', () => core.requestWorkLoopProgress(),
    60_000, { WATCHDOG_USEC: '180000000' });
  try {
    await m44_vi.advanceTimersByTimeAsync(60 * 60_000);
    m44_expect(feed).toHaveBeenCalledTimes(60);
    m44_expect(execute).toHaveBeenCalledTimes(1);
    m44_expect(error).toHaveBeenCalledTimes(1);
    wake(); await m44_vi.advanceTimersByTimeAsync(0);
    m44_expect(execute).toHaveBeenCalledTimes(2); // an explicit event may retry
  } finally { stop(); controller.abort(); await running; }
});


m44_it('keeps watchdog and discovery serving beyond the watchdog deadline while startup cleanup is blocked', async () => {
  let release!: () => void;
  const blocked = new Promise<void>(done => { release = done; });
  const execute = m44_vi.fn(async () => ({ workspaceIds: ['workspace'], rooms: [] }));
  const { core, wake } = await fixture(execute);
  const coordinator = (core as unknown as { roomRuntime: m44_RoomRuntimeCoordinator }).roomRuntime;
  const cleanup = m44_vi.spyOn(coordinator as unknown as {
    retryPendingCornerReaps(desired: ReadonlySet<string>): Promise<void>;
  }, 'retryPendingCornerReaps').mockImplementation(() => blocked);
  const controller = new AbortController();
  const established = m44_vi.fn();
  const running = core.run({ signal: controller.signal, onEstablished: established });
  await m44_vi.waitFor(() => m44_expect(cleanup).toHaveBeenCalledOnce());
  m44_vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  const feed = m44_vi.fn(async () => undefined);
  const stop = m44_startLocalWatchdog({ progress: feed }, () => 'serving',
    () => core.requestWorkLoopProgress(), 60_000, { WATCHDOG_USEC: '180000000' });
  try {
    m44_expect(established).toHaveBeenCalledOnce();
    await m44_vi.advanceTimersByTimeAsync(240_000);
    m44_expect(feed).toHaveBeenCalledTimes(4);
    m44_expect(execute).toHaveBeenCalledOnce(); // watchdog is local, never polling
    wake();
    await m44_vi.waitFor(() => m44_expect(execute).toHaveBeenCalledTimes(2));
    // Another discovery coalesces maintenance; it cannot start a second sweep.
    m44_expect(cleanup).toHaveBeenCalledOnce();
  } finally {
    stop(); controller.abort(); release(); await running;
  }
});



m44_it('acknowledges watchdog progress throughout 615 archived refusals while preservation is stalled', async () => {
  let release!: () => void;
  const blocked = new Promise<void>(resolveBlocked => { release = resolveBlocked; });
  const preserve = m44_vi.spyOn(m44_recovery, 'preserveUnpublishedCornerWorktree')
    .mockImplementation(async () => { await blocked; return { pointer: 'fixture', pruned: [] }; });
  m44_vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const execute = m44_vi.fn(async (name: string) => {
    if (name === 'getDaemonBootstrap') return { workspaceIds: ['workspace'], rooms: [] };
    if (name === 'getCornerRestoreState') {
      await new Promise(resolveDelay => setTimeout(resolveDelay, 1));
      throw new m44_DaemonApiError('corner no longer reachable', 403, false);
    }
    throw new Error(`unexpected operation ${name}`);
  });
  const { core, root } = await fixture(execute);
  const coordinator = (core as unknown as { roomRuntime: m44_RoomRuntimeCoordinator }).roomRuntime;
  const pending = (coordinator as unknown as { pendingCornerReaps: Map<string, m44_CornerWorktree> }).pendingCornerReaps;
  for (let index = 0; index < 615; index++) {
    const cornerId = `refused-${index}`;
    const path = m44_resolve(root, 'beeline', 'corners', cornerId);
    await m44_mkdir(path, { recursive: true });
    pending.set(cornerId, { cornerId, path, branch: `feature/${cornerId}`,
      parentRoomId: 'parent', gitCommonDir: m44_resolve(root, 'repo.git'), token: '' });
  }
  const controller = new AbortController();
  const established = m44_vi.fn();
  const running = core.run({ signal: controller.signal, onEstablished: established });
  const feed = m44_vi.fn(async () => undefined);
  const stop = m44_startLocalWatchdog({ progress: feed }, () => 'reconciling',
    () => core.requestWorkLoopProgress(), 10, { WATCHDOG_USEC: '180000000' });
  try {
    await m44_vi.waitFor(() => m44_expect(preserve).toHaveBeenCalledTimes(1));
    // Intake is already established while optional preservation and the
    // archived backlog continue. Neither may delay readiness or the watchdog.
    await m44_vi.waitFor(() => m44_expect(feed.mock.calls.length).toBeGreaterThanOrEqual(3), { timeout: 1_000 });
    m44_expect(established).toHaveBeenCalledTimes(1);
    await m44_vi.waitFor(() => m44_expect(pending.size).toBe(0), { timeout: 25_000 });
    m44_expect(pending.size).toBe(0);
    // Undeclared proof must not cause per-refusal owner records or a growing
    // owner-store scan on every iteration of this backlog.
    m44_expect(await m44_readdir(m44_resolve(root, 'beeline/storage-owners')).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    })).toEqual([]);
    // Clearing the queue can precede the final atomic refusal write.
    await m44_vi.waitFor(async () => {
      m44_expect(await m44_readdir(m44_resolve(root, 'corner-cleanup-refusals'))).toHaveLength(615);
    }, { timeout: 25_000 });
    m44_expect(preserve).toHaveBeenCalledTimes(1); // one job across the whole backlog
    m44_expect(execute.mock.calls.filter(([name]) => name === 'getCornerRestoreState')).toHaveLength(615);
    const reads = execute.mock.calls.length;
    await core.requestWorkLoopProgress();
    m44_expect(execute).toHaveBeenCalledTimes(reads); // health tick adds no discovery polling
  } finally {
    stop(); controller.abort(); release(); await running;
  }
}, 30_000);
});

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
