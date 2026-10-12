import { mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { ThinDaemonCore } from './thin-core.js';
import { DaemonApiError, type DaemonApiClient } from './daemon-api-client.js';
import { identityFromKey, type AgentRuntimeRecord } from './runtime.js';
import { startLocalWatchdog } from './systemd.js';

const roots: string[] = [];
afterEach(async () => {
  vi.useRealTimers(); vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function fixture(execute: ReturnType<typeof vi.fn>) {
  const root = await mkdtemp(resolve(process.cwd(), '.watchdog-test-'));
  roots.push(root);
  const agent = identityFromKey('11'.repeat(32), 'Bee');
  let wake!: () => void;
  const api = { execute, setRoomsChangedListener: (listener: () => void) => { wake = listener; } } as unknown as DaemonApiClient;
  const core = new ThinDaemonCore({
    agent: { publicKey: agent.publicKey, secretKeyHex: '11'.repeat(32), name: 'Bee' },
    rooms: [], communityId: 'workspace', supervisorRoot: root,
    transport: { kind: 'monolith', baseUrl: 'http://127.0.0.1', daemonToken: 'fixture' },
  } as unknown as AgentRuntimeRecord, resolve(root, 'runtime.json'), { workspaceRoot: root } as never, { daemonApi: api });
  return { core, wake: () => wake() };
}

it('stops renewing the 180-second watchdog when reconcile freezes while the event loop runs', async () => {
  let unblock!: () => void;
  const blocked = new Promise<void>(resolveBlocked => { unblock = resolveBlocked; });
  const execute = vi.fn().mockResolvedValueOnce({ workspaceIds: ['workspace'], rooms: [] })
    .mockImplementation(async () => { await blocked; return { workspaceIds: ['workspace'], rooms: [] }; });
  const { core, wake } = await fixture(execute);
  const controller = new AbortController();
  const progress = vi.fn();
  const running = core.run({ signal: controller.signal, onProgress: progress });
  await vi.waitFor(() => expect(progress).toHaveBeenCalledTimes(1));
  vi.useFakeTimers();
  let lastFeed = Date.now();
  const feed = vi.fn(async () => { lastFeed = Date.now(); });
  const stop = startLocalWatchdog({ progress: feed }, () => 'healthy', () => core.requestWorkLoopProgress(),
    60_000, { WATCHDOG_USEC: '180000000' });
  try {
    await vi.advanceTimersByTimeAsync(60_000);
    expect(feed).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(1); // local health never discovers Rooms
    wake();
    await vi.advanceTimersByTimeAsync(0);
    expect(execute).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(180_000);
    expect(feed).toHaveBeenCalledTimes(1);
    expect(Date.now() - lastFeed).toBe(180_000); // systemd's configured expiry
  } finally {
    stop(); controller.abort(); unblock(); await running;
  }
});

it.each([401, 403, 404])('parks a non-retryable %s discovery request while local health keeps progressing', async status => {
  const execute = vi.fn(async () => { throw new DaemonApiError('refused', status, false); });
  const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const { core, wake } = await fixture(execute);
  const controller = new AbortController();
  const progress = vi.fn();
  const running = core.run({ signal: controller.signal, onProgress: progress });
  await vi.waitFor(() => expect(progress).toHaveBeenCalledTimes(1));
  vi.useFakeTimers();
  const feed = vi.fn(async () => undefined);
  const stop = startLocalWatchdog({ progress: feed }, () => 'refused', () => core.requestWorkLoopProgress(),
    60_000, { WATCHDOG_USEC: '180000000' });
  try {
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(feed).toHaveBeenCalledTimes(60);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledTimes(1);
    wake(); await vi.advanceTimersByTimeAsync(0);
    expect(execute).toHaveBeenCalledTimes(2); // an explicit event may retry
  } finally { stop(); controller.abort(); await running; }
});
