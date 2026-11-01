import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { expect, it, vi } from 'vitest';
import { RoomRuntimeCoordinator, type CornerWorktree } from './room-runtime.js';
import { identityFromKey, type AgentRuntimeRecord } from './runtime.js';

it('background reaping leases inactive corners and wakes a start deferred by that lease', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'beeline-reap-lease-'));
  const identity = identityFromKey('11'.repeat(32), 'Bee');
  const execute = vi.fn();
  const coordinator = new RoomRuntimeCoordinator({
    agent: { publicKey: identity.publicKey, secretKeyHex: '11'.repeat(32), name: 'Bee' },
    rooms: [], communityId: 'workspace', supervisorRoot: root,
    transport: { kind: 'monolith', baseUrl: 'https://server.example', daemonToken: 'test' },
  } as AgentRuntimeRecord, resolve(root, 'runtime.json'), { workspaceRoot: root } as never,
  { daemonApi: { execute } as never });
  const internal = coordinator as unknown as {
    reapIdleCornerWorktree(worktree: CornerWorktree, desired: ReadonlySet<string>): Promise<void>;
    reapCornerWorktree(worktree: CornerWorktree): Promise<void>;
    startCorner(corner: { cornerId: string; parentRoomId: string }): Promise<void>;
  };
  const worktree = { cornerId: 'corner', parentRoomId: 'room', path: resolve(root, 'corner'),
    gitCommonDir: resolve(root, 'repo.git'), branch: 'feature/corner', token: '' };
  let release!: () => void;
  const blocked = new Promise<void>(done => { release = done; });
  const reap = vi.spyOn(internal, 'reapCornerWorktree').mockReturnValue(blocked);
  const wake = vi.fn();
  coordinator.setDiscoveryWakeListener(wake);
  let maintenance: Promise<void> | undefined;
  try {
    await internal.reapIdleCornerWorktree(worktree, new Set(['corner']));
    expect(reap).not.toHaveBeenCalled();
    maintenance = internal.reapIdleCornerWorktree(worktree, new Set());
    await vi.waitFor(() => expect(reap).toHaveBeenCalledOnce());
    await internal.startCorner({ cornerId: 'corner', parentRoomId: 'room' });
    expect(execute).not.toHaveBeenCalled();
    release(); await maintenance;
    expect(wake).toHaveBeenCalledOnce();
  } finally {
    release(); await maintenance; reap.mockRestore();
    await coordinator.shutdown(); await rm(root, { recursive: true, force: true });
  }
});

it('establishes every corner subscription without waiting for pending legacy checkout migration', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'beeline-migration-intake-'));
  const identity = identityFromKey('11'.repeat(32), 'Bee');
  const corners = Array.from({ length: 20 }, (_, i) => ({ roomId: `corner-${i}`, parentRoomId: 'room' }));
  const execute = vi.fn(async (name: string) => {
    if (name === 'getDaemonBootstrap') return { workspaceIds: ['workspace'],
      rooms: [{ roomId: 'room' }], pendingRooms: corners };
    if (name === 'listRoomCorners') return { corners: corners.map(corner => ({ cornerId: corner.roomId, parentRoomId: 'room' })) };
    throw new Error(`unexpected operation ${name}`);
  });
  const subscribe = vi.fn(() => () => undefined);
  const coordinator = new RoomRuntimeCoordinator({
    agent: { publicKey: identity.publicKey, secretKeyHex: '11'.repeat(32), name: 'Bee' },
    rooms: [], communityId: 'workspace', supervisorRoot: root,
    transport: { kind: 'monolith', baseUrl: 'https://server.example', daemonToken: 'test' },
  } as AgentRuntimeRecord, resolve(root, 'runtime.json'), { workspaceRoot: root } as never,
  { daemonApi: { execute, liveSubscribe: subscribe } as never });
  const internal = coordinator as unknown as {
    startRoom(id: string): Promise<void>;
    startCorner(input: { cornerId: string }): Promise<void>;
  };
  const room = vi.spyOn(internal, 'startRoom').mockResolvedValue();
  let release!: () => void;
  const migrating = new Promise<void>(done => { release = done; });
  const start = vi.spyOn(internal, 'startCorner').mockReturnValue(migrating);
  const serving = vi.fn();
  let reconciled = false;
  const reconciliation = coordinator.reconcile(serving).then(() => { reconciled = true; });
  try {
    await vi.waitFor(() => expect(reconciled).toBe(true), { timeout: 1_000 });
    expect(serving).toHaveBeenCalledOnce();
    expect(room).toHaveBeenCalledWith('room');
    expect(new Set(subscribe.mock.calls.map(call => (call as unknown[])[0])).size).toBe(20);
    expect(start).toHaveBeenCalled();
  } finally {
    release(); await reconciliation; await coordinator.shutdown();
    room.mockRestore(); start.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
});

it('starts Room and corner intake before waiting for archived cleanup', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'beeline-intake-first-'));
  const identity = identityFromKey('11'.repeat(32), 'Bee');
  const runtime = { agent: { name: 'Bee', publicKey: identity.publicKey,
    secretKeyHex: Buffer.from(identity.secretKey).toString('hex') },
    communityId: 'workspace', supervisorRoot: root, rooms: [],
    transport: { kind: 'monolith', baseUrl: 'https://server.example', daemonToken: 'test' },
  } as AgentRuntimeRecord;
  const execute = vi.fn(async (name: string) => {
    if (name === 'getDaemonBootstrap') return { workspaceIds: ['workspace'], rooms: [{ roomId: 'room' }] };
    if (name === 'listRoomCorners') return { corners: [{ cornerId: 'corner', parentRoomId: 'room' }] };
    throw new Error(`unexpected operation ${name}`);
  });
  const coordinator = new RoomRuntimeCoordinator(runtime, resolve(root, 'runtime.json'),
    { workspaceRoot: root } as never, { daemonApi: { execute } as never });
  const internal = coordinator as unknown as {
    startRoom(id: string): Promise<void>;
    watchCorner(input: { cornerId: string }): Promise<void>;
    retryPendingCornerReaps(desired: ReadonlySet<string>): Promise<void>;
  };
  const start = vi.spyOn(internal, 'startRoom').mockResolvedValue();
  const watch = vi.spyOn(internal, 'watchCorner').mockResolvedValue();
  let release!: () => void;
  const cleanup = vi.spyOn(internal, 'retryPendingCornerReaps')
    .mockImplementation(() => new Promise<void>(done => { release = done; }));
  const serving = vi.fn();
  const reconciliation = coordinator.reconcile(serving);
  try {
    await vi.waitFor(() => expect(cleanup).toHaveBeenCalled());
    expect(start).toHaveBeenCalledWith('room');
    expect(watch).toHaveBeenCalledWith(expect.objectContaining({ cornerId: 'corner' }));
    expect(serving).toHaveBeenCalledOnce();
  } finally {
    release();
    await reconciliation;
    await coordinator.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});
