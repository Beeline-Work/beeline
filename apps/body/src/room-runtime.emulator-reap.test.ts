import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { processAlive } from './android-emulator-lease.js';
import { stoppedEmulatorLogDir, type KeptCornerEmulator } from './corner-emulator.js';
import { DaemonApiError, type DaemonApiClient } from './daemon-api-client.js';
import { RoomRuntimeCoordinator } from './room-runtime.js';
import { identityFromKey, type AgentRuntimeRecord } from './runtime.js';

const roots: string[] = [];
const pids: number[] = [];
afterEach(async () => {
  for (const pid of pids.splice(0)) {
    try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
  }
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const CORNER = 'fbcbb6cc-3b23-4167-a922-d29472b6a903';

function runtimeAt(root: string): AgentRuntimeRecord {
  const identity = identityFromKey('22'.repeat(32), 'Speedy');
  return {
    agent: {
      name: 'Speedy',
      publicKey: identity.publicKey,
      secretKeyHex: Buffer.from(identity.secretKey).toString('hex'),
    },
    rooms: [],
    communityId: 'workspace',
    supervisorRoot: root,
    transport: { kind: 'monolith', baseUrl: 'https://server.example', daemonToken: 'token' },
  } as unknown as AgentRuntimeRecord;
}

/** Another agent's live corner emulator, as its helper leaves it on the shared host. */
async function keptEmulator(root: string): Promise<KeptCornerEmulator> {
  const leaseRoot = resolve(root, 'beeline/workspaces/ws/shared-home/cache/android-leases');
  const instanceRoot = resolve(root, 'instances/instance-1');
  await mkdir(resolve(leaseRoot, 'kept'), { recursive: true });
  await mkdir(instanceRoot, { recursive: true });
  await writeFile(resolve(instanceRoot, 'emulator.log'), 'guest booted\nGoogle sign-in started\n');
  const child = spawn('sleep', ['120'], { detached: true, stdio: 'ignore' });
  child.unref();
  pids.push(child.pid!);
  const markerPath = resolve(leaseRoot, 'port-5556.lease');
  await writeFile(markerPath, 'owner');
  const record: KeptCornerEmulator = {
    version: 1,
    cornerId: CORNER,
    pid: child.pid!,
    port: 5556,
    serial: 'emulator-5556',
    instanceRoot,
    markerPath,
    ownership: 'owner',
    leaseRoot,
  };
  await writeFile(resolve(leaseRoot, 'kept', `${CORNER}.json`), JSON.stringify(record));
  return record;
}

async function reap(root: string, execute: ReturnType<typeof vi.fn>): Promise<void> {
  const coordinator = new RoomRuntimeCoordinator(runtimeAt(root), resolve(root, 'agent.json'),
    { workspaceRoot: root } as never, { daemonApi: { execute } as unknown as DaemonApiClient });
  const internal = coordinator as unknown as {
    reapClosedCornerEmulators(live: ReadonlySet<string>): Promise<void>;
  };
  await internal.reapClosedCornerEmulators(new Set());
}

describe('corner emulator reaper across agent runtimes', () => {
  it.each([403, 404, 410])('keeps a live corner emulator when a non-member runtime is refused with %i', async (status) => {
    const root = await mkdtemp(resolve(tmpdir(), 'beeline-emulator-reap-'));
    roots.push(root);
    const kept = await keptEmulator(root);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const execute = vi.fn().mockRejectedValue(
      new DaemonApiError(`monolith daemon request failed (${status}: request_failed)`, status, false));
    await reap(root, execute);
    expect(execute).toHaveBeenCalledWith('getCornerRestoreState', { cornerId: CORNER });
    expect(processAlive(kept.pid)).toBe(true);
    expect(existsSync(kept.instanceRoot)).toBe(true);
    expect(existsSync(resolve(kept.leaseRoot, 'kept', `${CORNER}.json`))).toBe(true);
    expect(log.mock.calls.flat().join('\n')).toContain(
      `corner emulator reaper: corner=${CORNER} agent=${runtimeAt(root).agent.publicKey} keep: lookup refused (${status})`);
    log.mockRestore();
    console.info(`Reproduction EMU-REAP-1: non-member ${status} keeps the live corner emulator`);
  });

  it('keeps the emulator while the corner is open', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'beeline-emulator-reap-'));
    roots.push(root);
    const kept = await keptEmulator(root);
    await reap(root, vi.fn().mockResolvedValue({ cornerId: CORNER, archived: false }));
    expect(processAlive(kept.pid)).toBe(true);
  });

  it('stops an archived corner emulator and keeps its log and stop reason', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'beeline-emulator-reap-'));
    roots.push(root);
    const kept = await keptEmulator(root);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await reap(root, vi.fn().mockResolvedValue({ cornerId: CORNER, archived: true }));
    log.mockRestore();
    for (let i = 0; i < 30 && processAlive(kept.pid); i++)
      await new Promise((done) => setTimeout(done, 100));
    expect(processAlive(kept.pid)).toBe(false);
    expect(existsSync(kept.instanceRoot)).toBe(false);
    expect(existsSync(resolve(kept.leaseRoot, 'kept', `${CORNER}.json`))).toBe(false);
    const dir = stoppedEmulatorLogDir(kept.leaseRoot);
    const [file] = await readdir(dir);
    const retained = await readFile(resolve(dir, file!), 'utf8');
    expect(retained).toContain(
      `reason=corner archived; reaped by agent ${runtimeAt(root).agent.publicKey}`);
    expect(retained).toContain('Google sign-in started');
  });
});
