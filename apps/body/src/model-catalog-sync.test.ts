import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MODEL_CATALOG_HASH_FILE, syncAgentModelCatalog } from './model-catalog-sync.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function scratchDir(prefix: string): Promise<string> {
  const directory = await mkdtemp(resolve(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

/** A minimal ACP harness whose `session/new` advertises the given config options. */
async function fakeCatalogAgent(configOptions: unknown[]): Promise<string> {
  const directory = await scratchDir('buzzy-catalog-agent-');
  const binary = resolve(directory, 'fake-catalog-agent.mjs');
  await writeFile(
    binary,
    `#!/usr/bin/env node
import { createInterface } from 'node:readline';
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
      result: { sessionId: 'catalog-session', configOptions: ${JSON.stringify(configOptions)} },
    });
  } else if (message.method === 'shutdown') {
    process.exit(0);
  } else if (typeof message.id === 'number') {
    send({ jsonrpc: '2.0', id: message.id, result: {} });
  }
});
`,
  );
  await chmod(binary, 0o755);
  return binary;
}

const ADVERTISED = [
  {
    id: 'model',
    category: 'model',
    currentValue: 'gpt-5.6',
    options: [
      { id: 'gpt-5.6', name: 'GPT-5.6' },
      { id: 'gpt-5.6-mini', name: 'GPT-5.6 mini' },
    ],
  },
  {
    id: 'reasoning_effort',
    category: 'reasoning_effort',
    currentValue: 'medium',
    options: [{ id: 'low' }, { id: 'medium' }, { id: 'high' }],
  },
  { id: 'mode', category: 'mode', currentValue: 'agent', options: [{ id: 'agent' }] },
];

function fakeApi(configuration: { model?: string; effort?: string } = {}) {
  const posted: unknown[] = [];
  return {
    posted,
    execute: vi.fn(async (name: string, input: unknown) => {
      if (name === 'getAgentConfiguration') return { ...configuration, commands: [], yoloMode: false };
      if (name === 'postAgentModelCatalog') {
        posted.push(input);
        return { ok: true };
      }
      throw new Error(`unexpected operation ${name}`);
    }),
  };
}

describe('syncAgentModelCatalog', () => {
  it('posts the harness catalog with the server selection on activation, once per change', async () => {
    const runtimeDir = await scratchDir('buzzy-catalog-runtime-');
    const command = await fakeCatalogAgent(ADVERTISED);
    const api = fakeApi({ model: 'gpt-5.6-mini' });
    const log = vi.fn();

    const first = await syncAgentModelCatalog({
      api: api as never,
      agent: { command, args: [] },
      agentEnv: { PATH: process.env.PATH ?? '', HOME: runtimeDir },
      agentId: 'agent-1',
      workspaceId: 'workspace-1',
      runtimeDir,
      runtimeSelection: { model: 'stale-runtime-model' },
      log,
    });

    expect(first).toBe('posted');
    expect(api.posted).toEqual([
      {
        agentId: 'agent-1',
        workspaceId: 'workspace-1',
        options: [
          {
            id: 'model',
            category: 'model',
            currentValue: 'gpt-5.6',
            options: [
              { id: 'gpt-5.6', name: 'GPT-5.6' },
              { id: 'gpt-5.6-mini', name: 'GPT-5.6 mini' },
            ],
          },
          {
            id: 'reasoning_effort',
            category: 'reasoning_effort',
            currentValue: 'medium',
            options: [{ id: 'low' }, { id: 'medium' }, { id: 'high' }],
          },
        ],
        selection: { model: 'gpt-5.6-mini' },
      },
    ]);
    expect((await readFile(resolve(runtimeDir, MODEL_CATALOG_HASH_FILE), 'utf8')).trim()).toMatch(
      /^[0-9a-f]{64}$/,
    );
    expect(log).toHaveBeenCalledWith(expect.stringContaining('model catalog posted'));

    const second = await syncAgentModelCatalog({
      api: api as never,
      agent: { command, args: [] },
      agentEnv: { PATH: process.env.PATH ?? '', HOME: runtimeDir },
      agentId: 'agent-1',
      workspaceId: 'workspace-1',
      runtimeDir,
    });
    expect(second).toBe('unchanged');
    expect(api.posted).toHaveLength(1);
  });

  it('posts an empty catalog with the runtime selection when the harness advertises nothing', async () => {
    const runtimeDir = await scratchDir('buzzy-catalog-runtime-');
    const command = await fakeCatalogAgent([]);
    const api = fakeApi();

    const result = await syncAgentModelCatalog({
      api: api as never,
      agent: { command, args: [] },
      agentEnv: { PATH: process.env.PATH ?? '', HOME: runtimeDir },
      agentId: 'agent-1',
      workspaceId: 'workspace-1',
      runtimeDir,
      runtimeSelection: { model: 'openrouter/z-ai/glm-5.3-flash' },
      log: vi.fn(),
    });

    expect(result).toBe('posted');
    expect(api.posted).toEqual([
      {
        agentId: 'agent-1',
        workspaceId: 'workspace-1',
        options: [],
        selection: { model: 'openrouter/z-ai/glm-5.3-flash' },
      },
    ]);
  });

  it('logs a failed probe once and never throws', async () => {
    const runtimeDir = await scratchDir('buzzy-catalog-runtime-');
    const api = fakeApi();
    const log = vi.fn();

    const result = await syncAgentModelCatalog({
      api: api as never,
      agent: { command: resolve(runtimeDir, 'missing-harness'), args: [] },
      agentEnv: { PATH: process.env.PATH ?? '', HOME: runtimeDir },
      agentId: 'agent-1',
      workspaceId: 'workspace-1',
      runtimeDir,
      timeoutMs: 5_000,
      log,
    });

    expect(result).toBe('failed');
    expect(api.posted).toEqual([]);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('model catalog not posted this activation'),
    );
  });

  it('gives up on a probe that never answers within the deadline', async () => {
    const runtimeDir = await scratchDir('buzzy-catalog-runtime-');
    const api = fakeApi();
    const log = vi.fn();
    const result = await syncAgentModelCatalog({
      api: api as never,
      agent: { command: 'never', args: [] },
      agentEnv: {},
      agentId: 'agent-1',
      workspaceId: 'workspace-1',
      runtimeDir,
      fetchCatalog: () => new Promise(() => undefined),
      timeoutMs: 20,
      log,
    });
    expect(result).toBe('failed');
    expect(log).toHaveBeenCalledWith(expect.stringContaining('timed out after 20ms'));
  });
});
