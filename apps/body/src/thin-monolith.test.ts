import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ThinDaemonCore } from './thin-core.js';
import { identityFromKey, stageMonolithAgentRuntime } from './runtime.js';
import type { BodyConfig } from './config.js';
import type { DaemonApiClient } from './daemon-api-client.js';

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe('monolith-only thin daemon', () => {
  it('stages and reads only an authenticated monolith runtime', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'beeline-thin-runtime-'));
    roots.push(root);
    const staged = await stageMonolithAgentRuntime({
      workspaceId: 'workspace',
      pairedBy: 'human',
      daemonExchangeToken: `bde_${'a'.repeat(43)}`,
      agentBinary: 'codex-acp',
      agentKind: 'codex',
      agentCommand: 'codex-acp',
      agentArgs: [],
      mcpBinary: 'unused',
      agentIdentity: identityFromKey('11'.repeat(32), 'Bee'),
      bodyIdentity: identityFromKey('22'.repeat(32), 'Body'),
      supervisorRoot: root,
    });
    expect(staged.runtime.transport).toMatchObject({ kind: 'monolith' });
    expect(staged.runtime.rooms).toEqual([]);
  });

  it('discovers Rooms through the daemon API and never constructs relay transport', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'beeline-thin-core-'));
    roots.push(root);
    const staged = await stageMonolithAgentRuntime({
      workspaceId: 'workspace',
      pairedBy: 'human',
      daemonExchangeToken: `bde_${'b'.repeat(43)}`,
      agentBinary: '/nonexistent',
      agentKind: 'codex',
      agentCommand: '/nonexistent',
      agentArgs: [],
      mcpBinary: 'unused',
      agentIdentity: identityFromKey('33'.repeat(32), 'Bee'),
      bodyIdentity: identityFromKey('44'.repeat(32), 'Body'),
      supervisorRoot: root,
    });
    const execute = vi.fn(async (name: string) => {
      if (name === 'getDaemonBootstrap') return { workspaceIds: ['workspace'], rooms: [{ roomId: 'room', archived: false }] };
      if (name === 'getRoomInbox') return { items: [], cursor: 'latest' };
      return { id: 'write', createdAt: 1 };
    });
    const api = { execute } as unknown as DaemonApiClient;
    const config: BodyConfig = {
      agentBinary: '/nonexistent',
      agentKind: 'codex',
      agentCommand: '/nonexistent',
      agentArgs: [],
      mcpBinary: 'unused',
      readonlyMcpCommand: '/nonexistent',
      agentEnv: {},
      workspaceRoot: root,
      autoApprovePermissions: false,
    };
    const controller = new AbortController();
    const core = new ThinDaemonCore(staged.runtime, staged.configPath, config, { daemonApi: api });
    const result = core.run({
      pollMs: 1,
      signal: controller.signal,
      onProgress: () => controller.abort(),
    });
    await expect(result).resolves.toBe('aborted');
    expect(execute).toHaveBeenCalledWith('getDaemonBootstrap', expect.any(Object));
    expect(execute).toHaveBeenCalledWith('postAgentPresence', expect.objectContaining({ roomId: 'room' }));
  });
});
