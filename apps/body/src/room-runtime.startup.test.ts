import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { expect, it, vi } from 'vitest';
import { RoomRuntimeCoordinator } from './room-runtime.js';
import { identityFromKey, type AgentRuntimeRecord } from './runtime.js';

it.each([
  { agentKind: 'pi', managed: true, prestart: true },
  { agentKind: 'pi', managed: false, prestart: false },
  { agentKind: 'codex', managed: true, prestart: false },
])('starts intake before cleanup and prepares only the first pending managed Pi Room: %j', async ({ agentKind, managed, prestart }) => {
  const root = await mkdtemp(resolve(tmpdir(), 'beeline-intake-first-'));
  const identity = identityFromKey('11'.repeat(32), 'Bee');
  const runtime = { agent: { name: 'Bee', publicKey: identity.publicKey,
    secretKeyHex: Buffer.from(identity.secretKey).toString('hex') },
    communityId: 'workspace', supervisorRoot: root, rooms: [],
    transport: { kind: 'monolith', baseUrl: 'https://server.example', daemonToken: 'test' },
  } as AgentRuntimeRecord;
  const execute = vi.fn(async (name: string) => {
    if (name === 'getDaemonBootstrap') return { workspaceIds: ['workspace'], rooms: [{ roomId: 'room' }, { roomId: 'other' }], pendingRooms: [{ roomId: 'room' }, { roomId: 'other' }] };
    if (name === 'listRoomCorners') return { corners: [{ cornerId: 'corner', parentRoomId: 'room' }] };
    throw new Error(`unexpected operation ${name}`);
  });
  const coordinator = new RoomRuntimeCoordinator(runtime, resolve(root, 'runtime.json'),
    { workspaceRoot: root, agentKind, agentEnv: managed ? { BEELINE_FREE_AGENT_ID: identity.publicKey } : {}, modelSelection: { model: 'beeline/deepseek/deepseek-v4.1-flash' } } as never, { daemonApi: { execute } as never });
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
    expect(start).toHaveBeenCalledWith('room', prestart);
    expect(start).toHaveBeenCalledWith('other', false);
    expect(watch).toHaveBeenCalledWith(expect.objectContaining({ cornerId: 'corner' }));
    expect(serving).toHaveBeenCalledOnce();
  } finally {
    release();
    await reconciliation;
    await coordinator.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});
