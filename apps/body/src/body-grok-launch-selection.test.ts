import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

const mocks = vi.hoisted(() => ({
  getAgentModelConfig: vi.fn(),
  listAgents: vi.fn(),
  publishAgentModelCatalog: vi.fn(),
}));

vi.mock('@beeline/buzz-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@beeline/buzz-client')>();
  return {
    ...actual,
    getAgentModelConfig: mocks.getAgentModelConfig,
    listAgents: mocks.listAgents,
    publishAgentModelCatalog: mocks.publishAgentModelCatalog,
  };
});

import { Body, type AgentSession } from './body.js';
import { newIdentity } from '@beeline/gate';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  mocks.getAgentModelConfig.mockReset();
  mocks.listAgents.mockReset();
  mocks.publishAgentModelCatalog.mockReset();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function fakeGrokAgent(capturePath: string): Promise<string> {
  const directory = await mkdtemp(resolve(tmpdir(), 'beeline-body-grok-launch-'));
  temporaryDirectories.push(directory);
  const binary = resolve(directory, 'grok');
  await writeFile(
    binary,
    `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

appendFileSync(${JSON.stringify(capturePath)}, JSON.stringify(process.argv.slice(2)) + '\\n');
const lines = createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
lines.on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1 } });
  } else if (message.method === 'session/new') {
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        sessionId: 'grok-session',
        models: {
          currentModelId: 'grok-4.6',
          availableModels: [{
            modelId: 'grok-4.6',
            name: 'Grok 4.6',
            _meta: {
              reasoningEffort: 'high',
              reasoningEfforts: [{ value: 'high', default: true }],
            },
          }],
        },
      },
    });
  } else if (message.method === 'session/set_model') {
    send({ jsonrpc: '2.0', id: message.id, result: { modelId: message.params.modelId } });
  } else if (message.method === 'shutdown') {
    process.exit(0);
  }
});
`,
  );
  await chmod(binary, 0o755);
  return binary;
}

describe('Body Grok launch selection', () => {
  it('uses a post-start human model and effort change for the next cold process', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'beeline-body-grok-session-'));
    temporaryDirectories.push(root);
    const capturePath = resolve(root, 'argv.ndjson');
    const selected = { model: 'grok-4.6', effort: 'high' };
    mocks.getAgentModelConfig.mockResolvedValue({
      ...selected,
      authoredBy: 'human',
      updatedAt: 2,
    });
    mocks.listAgents.mockResolvedValue([]);
    mocks.publishAgentModelCatalog.mockResolvedValue(undefined);
    const agentCommand = await fakeGrokAgent(capturePath);

    // The daemon was started with the old pair-time choice. The durable human
    // pick is newer, and Grok must use it before it starts its next process.
    const body = new Body(
      {
        agentBinary: agentCommand,
        agentKind: 'grok',
        agentCommand,
        agentArgs: ['agent', 'stdio'],
        modelSelection: { model: 'grok-4.5', effort: 'low' },
        mcpBinary: '/nonexistent',
        agentEnv: {},
        workspaceRoot: root,
        operatorHome: root,
        relayBaseUrl: 'http://relay.test',
        relayHost: 'relay.test',
        relayScheme: 'http',
        relayWsUrl: 'ws://relay.test',
      },
      newIdentity('operator'),
      newIdentity('agent'),
    );
    vi.spyOn(body as never, 'agentHistory' as never).mockResolvedValue([] as never);

    const createManagedSession = Reflect.get(body, 'createManagedSession') as (input: unknown) =>
      Promise<AgentSession>;
    const session = await createManagedSession.call(body, {
      channelId: 'room-id',
      mode: 'readonly',
      cwd: root,
      mcpServers: [],
      systemPrompt: 'test',
      autoApprovePermissions: false,
      communityId: 'workspace-id',
    });
    await session.lifecycle!.activate();
    await session.lifecycle!.suspend();

    const expected = ['agent', '--model', 'grok-4.6', '--reasoning-effort', 'high', 'stdio'];
    expect((await readFile(capturePath, 'utf8')).trim().split('\n').map(JSON.parse)).toEqual([
      expected,
      expected,
    ]);
  });
});
