/**
 * `convergeRuntimeRecordFileModes` — see `runtime.ts`. File modes cannot
 * isolate agents that share one Unix account (that is `bwrap-sandbox.ts`'s
 * job); this is the narrower defense-in-depth convergence for an existing
 * runtime record that predates `writeRuntimeRecord`'s private modes.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { convergeRuntimeRecordFileModes } from './runtime.js';

describe('convergeRuntimeRecordFileModes', () => {
  const roots: string[] = [];
  afterEach(() => {
    while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
  });

  it('tightens a pre-existing record and its directory to private modes', async () => {
    const root = mkdtempSync(resolve(tmpdir(), 'runtime-modes-'));
    roots.push(root);
    const directory = resolve(root, 'beeline', 'agents', 'a'.repeat(64));
    mkdirSync(directory, { recursive: true, mode: 0o755 });
    const path = resolve(directory, 'runtime.json');
    writeFileSync(path, '{}\n', { mode: 0o644 });

    await convergeRuntimeRecordFileModes(path);

    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(directory).mode & 0o777).toBe(0o700);
  });

  it('is a no-op, not a throw, when the record does not exist yet', async () => {
    const root = mkdtempSync(resolve(tmpdir(), 'runtime-modes-missing-'));
    roots.push(root);
    await expect(
      convergeRuntimeRecordFileModes(resolve(root, 'beeline', 'agents', 'b'.repeat(64), 'runtime.json')),
    ).resolves.toBeUndefined();
  });

  it('is idempotent against a record already holding private modes', async () => {
    const root = mkdtempSync(resolve(tmpdir(), 'runtime-modes-idempotent-'));
    roots.push(root);
    const directory = resolve(root, 'beeline', 'agents', 'c'.repeat(64));
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const path = resolve(directory, 'runtime.json');
    writeFileSync(path, '{}\n', { mode: 0o600 });

    await convergeRuntimeRecordFileModes(path);
    await convergeRuntimeRecordFileModes(path);

    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(directory).mode & 0o777).toBe(0o700);
  });
});

import { access as m15_access, mkdir as m15_mkdir, mkdtemp as m15_mkdtemp, rm as m15_rm, writeFile as m15_writeFile } from 'node:fs/promises';

import { tmpdir as m15_tmpdir } from 'node:os';

import { resolve as m15_resolve } from 'node:path';

import { afterEach as m15_afterEach, expect as m15_expect, it as m15_it, vi as m15_vi } from 'vitest';

import type { DaemonApiClient as m15_DaemonApiClient } from "./daemon-api-client.js";

import { identityFromKey as m15_identityFromKey, type AgentRuntimeRecord as m15_AgentRuntimeRecord } from "./runtime.js";

import { RoomRuntimeCoordinator as m15_RoomRuntimeCoordinator } from "./room-runtime.js";
import { describe as mergedDescribe15 } from 'vitest';
mergedDescribe15("corner-local-state.test.ts", () => {


const roots: string[] = [];

m15_afterEach(async () => Promise.all(roots.splice(0).map((path) => m15_rm(path, { recursive: true, force: true }))));


m15_it('reaps the entire legacy private folder after exact server archive proof', async () => {
  const supervisorRoot = await m15_mkdtemp(m15_resolve(m15_tmpdir(), 'beeline-chat-reap-'));
  roots.push(supervisorRoot);
  const identity = m15_identityFromKey('12'.repeat(32), 'Bee');
  const agentRoot = m15_resolve(supervisorRoot, 'beeline', 'agents', identity.publicKey);
  const roomRoot = m15_resolve(agentRoot, 'rooms', 'corner-chat');
  const scratch = m15_resolve(roomRoot, 'scratch');
  const home = m15_resolve(scratch, 'agent-home');
  await m15_mkdir(home, { recursive: true });
  await m15_writeFile(m15_resolve(scratch, 'work.txt'), 'old task artifact');
  await m15_writeFile(m15_resolve(home, 'session.txt'), 'old session');
  const execute = m15_vi.fn(async (name: string) => {
    if (name === 'getCornerRestoreState') return { archived: true, parentRoomId: 'room-parent' };
    throw new Error(`unexpected ${name}`);
  });
  const coordinator = new m15_RoomRuntimeCoordinator(
    {
      agent: {
        name: 'Bee', publicKey: identity.publicKey,
        secretKeyHex: Buffer.from(identity.secretKey).toString('hex'),
      },
      rooms: [], communityId: 'workspace', supervisorRoot,
      transport: { kind: 'monolith', baseUrl: 'https://server.example', daemonToken: 'token' },
    } as unknown as m15_AgentRuntimeRecord,
    m15_resolve(agentRoot, 'runtime.json'),
    { workspaceRoot: supervisorRoot } as never,
    { daemonApi: { execute } as unknown as m15_DaemonApiClient },
  );
  const sweep = coordinator as unknown as {
    cleanupArchivedCornerLocalState(cornerId: string): Promise<boolean>;
  };

  await sweep.cleanupArchivedCornerLocalState('corner-chat');
  await m15_expect(m15_access(m15_resolve(scratch, 'work.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  await m15_expect(m15_access(m15_resolve(home, 'session.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  m15_expect(execute).toHaveBeenCalledWith('getCornerRestoreState', { cornerId: 'corner-chat' });
  await coordinator.shutdown();
});


m15_it('keeps chat scratch when the server says the corner is still open', async () => {
  const supervisorRoot = await m15_mkdtemp(m15_resolve(m15_tmpdir(), 'beeline-chat-live-'));
  roots.push(supervisorRoot);
  const identity = m15_identityFromKey('13'.repeat(32), 'Bee');
  const agentRoot = m15_resolve(supervisorRoot, 'beeline', 'agents', identity.publicKey);
  const scratch = m15_resolve(agentRoot, 'rooms', 'corner-chat', 'scratch');
  await m15_mkdir(scratch, { recursive: true });
  await m15_writeFile(m15_resolve(scratch, 'work.txt'), 'keep');
  const execute = m15_vi.fn(async () => ({ archived: false }));
  const coordinator = new m15_RoomRuntimeCoordinator(
    {
      agent: {
        name: 'Bee', publicKey: identity.publicKey,
        secretKeyHex: Buffer.from(identity.secretKey).toString('hex'),
      },
      rooms: [], communityId: 'workspace', supervisorRoot,
      transport: { kind: 'monolith', baseUrl: 'https://server.example', daemonToken: 'token' },
    } as unknown as m15_AgentRuntimeRecord,
    m15_resolve(agentRoot, 'runtime.json'),
    { workspaceRoot: supervisorRoot } as never,
    { daemonApi: { execute } as unknown as m15_DaemonApiClient },
  );
  const sweep = coordinator as unknown as {
    cleanupArchivedCornerLocalState(cornerId: string): Promise<boolean>;
  };
  await sweep.cleanupArchivedCornerLocalState('corner-chat');
  await m15_expect(m15_access(m15_resolve(scratch, 'work.txt'))).resolves.toBeUndefined();
  await coordinator.shutdown();
});
});
