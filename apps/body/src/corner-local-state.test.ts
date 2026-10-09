import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { DaemonApiClient } from './daemon-api-client.js';
import { identityFromKey, type AgentRuntimeRecord } from './runtime.js';
import { RoomRuntimeCoordinator } from './room-runtime.js';

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

it('reaps legacy chat-only scratch and agent home after exact server archive proof', async () => {
  const supervisorRoot = await mkdtemp(resolve(tmpdir(), 'beeline-chat-reap-'));
  roots.push(supervisorRoot);
  const identity = identityFromKey('12'.repeat(32), 'Bee');
  const agentRoot = resolve(supervisorRoot, 'beeline', 'agents', identity.publicKey);
  const roomRoot = resolve(agentRoot, 'rooms', 'corner-chat');
  const scratch = resolve(roomRoot, 'scratch');
  const home = resolve(scratch, 'agent-home');
  await mkdir(home, { recursive: true });
  await writeFile(resolve(scratch, 'work.txt'), 'old task artifact');
  await writeFile(resolve(home, 'session.txt'), 'old session');
  const execute = vi.fn(async (name: string) => {
    if (name === 'getCornerRestoreState') return { archived: true, parentRoomId: 'room-parent' };
    throw new Error(`unexpected ${name}`);
  });
  const coordinator = new RoomRuntimeCoordinator(
    {
      agent: {
        name: 'Bee', publicKey: identity.publicKey,
        secretKeyHex: Buffer.from(identity.secretKey).toString('hex'),
      },
      rooms: [], communityId: 'workspace', supervisorRoot,
      transport: { kind: 'monolith', baseUrl: 'https://server.example', daemonToken: 'token' },
    } as unknown as AgentRuntimeRecord,
    resolve(agentRoot, 'runtime.json'),
    { workspaceRoot: supervisorRoot } as never,
    { daemonApi: { execute } as unknown as DaemonApiClient },
  );
  const sweep = coordinator as unknown as {
    sweepCornerLocalState(archived: ReadonlyMap<string, { cornerId: string; parentRoomId: string }>, desired: ReadonlySet<string>): Promise<void>;
  };

  await sweep.sweepCornerLocalState(new Map(), new Set());
  await expect(access(scratch)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(execute).toHaveBeenCalledWith('getCornerRestoreState', { cornerId: 'corner-chat' });
  await coordinator.shutdown();
});

it('keeps chat scratch when the server says the corner is still open', async () => {
  const supervisorRoot = await mkdtemp(resolve(tmpdir(), 'beeline-chat-live-'));
  roots.push(supervisorRoot);
  const identity = identityFromKey('13'.repeat(32), 'Bee');
  const agentRoot = resolve(supervisorRoot, 'beeline', 'agents', identity.publicKey);
  const scratch = resolve(agentRoot, 'rooms', 'corner-chat', 'scratch');
  await mkdir(scratch, { recursive: true });
  await writeFile(resolve(scratch, 'work.txt'), 'keep');
  const execute = vi.fn(async () => ({ archived: false }));
  const coordinator = new RoomRuntimeCoordinator(
    {
      agent: {
        name: 'Bee', publicKey: identity.publicKey,
        secretKeyHex: Buffer.from(identity.secretKey).toString('hex'),
      },
      rooms: [], communityId: 'workspace', supervisorRoot,
      transport: { kind: 'monolith', baseUrl: 'https://server.example', daemonToken: 'token' },
    } as unknown as AgentRuntimeRecord,
    resolve(agentRoot, 'runtime.json'),
    { workspaceRoot: supervisorRoot } as never,
    { daemonApi: { execute } as unknown as DaemonApiClient },
  );
  const sweep = coordinator as unknown as {
    sweepCornerLocalState(archived: ReadonlyMap<string, { cornerId: string; parentRoomId: string }>, desired: ReadonlySet<string>): Promise<void>;
  };
  await sweep.sweepCornerLocalState(new Map(), new Set());
  await expect(access(resolve(scratch, 'work.txt'))).resolves.toBeUndefined();
  await coordinator.shutdown();
});
