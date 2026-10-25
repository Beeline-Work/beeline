import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, delimiter } from 'node:path';
import { cursorAcpBridgeLaunch } from './cursor-acp-bridge.js';
import { applyRuntimeModelPreflight, resolvePreflightModelSelection } from './runtime-model-validation.js';
import type { BodyConfig } from './config.js';
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
      if (name === 'getAgentConfiguration')
        return { ...configuration, commands: [], yoloMode: false };
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
    const api = fakeApi({ model: 'gpt-5.6-mini', effort: 'high' });
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
            currentValue: 'gpt-5.6-mini',
            options: [
              { id: 'gpt-5.6', name: 'GPT-5.6' },
              { id: 'gpt-5.6-mini', name: 'GPT-5.6 mini' },
            ],
          },
          {
            id: 'reasoning_effort',
            category: 'reasoning_effort',
            currentValue: 'high',
            options: [{ id: 'low' }, { id: 'medium' }, { id: 'high' }],
          },
        ],
        selection: { model: 'gpt-5.6-mini', effort: 'high' },
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

    const forced = await syncAgentModelCatalog({
      api: api as never,
      agent: { command, args: [] },
      agentEnv: { PATH: process.env.PATH ?? '', HOME: runtimeDir },
      agentId: 'agent-1',
      workspaceId: 'workspace-1',
      runtimeDir,
      force: true,
    });
    expect(forced).toBe('posted');
    expect(api.posted).toHaveLength(2);
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

  it('publishes the startup-unavailable mark while probing the default catalog', async () => {
    const runtimeDir = await scratchDir('buzzy-catalog-runtime-');
    const api = fakeApi({ model: 'claude-fable-5-1[1m]' });
    const fetchCatalog = vi.fn().mockResolvedValue({
      raw: [],
      catalog: [
        {
          id: 'model',
          category: 'model',
          currentValue: 'claude-sonnet-5',
          options: [{ id: 'claude-sonnet-5' }],
        },
      ],
    });
    await syncAgentModelCatalog({
      api: api as never,
      agent: { command: 'claude-agent-acp', args: [] },
      agentEnv: {},
      agentId: 'agent-1',
      workspaceId: 'workspace-1',
      runtimeDir,
      startupUnavailable: 'model',
      startupSelection: { model: 'claude-fable-5-1[1m]' },
      fetchCatalog,
      log: vi.fn(),
    });
    expect(fetchCatalog).toHaveBeenCalledWith(expect.anything(), expect.anything(), undefined);
    expect(api.posted).toEqual([
      expect.objectContaining({
        options: [
          expect.objectContaining({
            currentValue: 'claude-sonnet-5',
          }),
        ],
        selection: { model: 'claude-fable-5-1[1m]' },
        unavailable: 'model',
      }),
    ]);
  });

  it('does not publish a verdict about a different server selection', async () => {
    const api = fakeApi({ model: 'grok-4.7-xhigh' });
    await syncAgentModelCatalog({
      api: api as never,
      agent: { command: 'cursor-agent', args: [] }, agentEnv: {},
      agentId: 'agent-1', workspaceId: 'workspace-1',
      runtimeDir: await scratchDir('catalog-mismatch-'),
      startupUnavailable: 'model',
      startupSelection: { model: 'cursor-grok-4.6-high-fast' },
      fetchCatalog: async () => ({ catalog: [] }), log: vi.fn(),
    });
    expect(api.posted).toHaveLength(1);
    expect(api.posted[0]).not.toHaveProperty('unavailable');
  });

  it('MODEL-NOTICE: a server read timeout never validates the stale cache or publishes its verdict', async () => {
    const runtimeDir = await scratchDir('catalog-stale-');
    const api = fakeApi({ model: 'gpt-5.6' });
    api.execute.mockRejectedValueOnce(new Error('getAgentConfiguration timed out'));
    const local = { model: 'cursor-grok-4.6-high-fast' };
    const selection = await resolvePreflightModelSelection(local,
      () => api.execute('getAgentConfiguration', { agentId: 'agent-1' }) as Promise<{ model?: string }>);
    const config: Pick<BodyConfig, 'agentEnv' | 'modelSelection' | 'modelUnavailable'> = { agentEnv: {} };
    const validate = vi.fn();
    if (selection) await applyRuntimeModelPreflight(config, { command: 'unused', args: [] }, selection, validate);
    expect(validate).not.toHaveBeenCalled();
    await syncAgentModelCatalog({
      api: api as never, agent: { command: await fakeCatalogAgent(ADVERTISED), args: [] },
      agentEnv: { PATH: process.env.PATH ?? '', HOME: runtimeDir },
      agentId: 'agent-1', workspaceId: 'workspace-1', runtimeDir, runtimeSelection: local,
      startupUnavailable: config.modelUnavailable?.unavailable.label,
      startupSelection: config.modelUnavailable?.selection, log: vi.fn(),
    });
    expect(api.posted).toHaveLength(1);
    expect(api.posted[0]).toMatchObject({ selection: { model: 'gpt-5.6' } });
    expect(api.posted[0]).not.toHaveProperty('unavailable');
  });

  it.each(['timeout', 'nonzero', 'absent'] as const)(
    'MODEL-NOTICE: Cursor enumeration %s through ACP and publication', async (failure) => {
      const runtimeDir = await scratchDir('catalog-cursor-');
      const binary = resolve(runtimeDir, 'cursor-agent');
      const successful = '#!/usr/bin/env node\nconsole.log("auto - Auto");\n';
      await writeFile(binary, failure === 'timeout'
        ? '#!/usr/bin/env node\nsetInterval(() => {}, 1000);\n'
        : failure === 'nonzero' ? '#!/usr/bin/env node\nprocess.exit(1);\n' : successful);
      await chmod(binary, 0o755);
      const agent = { ...cursorAcpBridgeLaunch(), kind: 'cursor' as const };
      const agentEnv = { PATH: `${runtimeDir}${delimiter}${process.env.PATH ?? ''}`, HOME: runtimeDir };
      const config: Pick<BodyConfig, 'agentEnv' | 'modelSelection' | 'modelUnavailable'> = { agentEnv };
      const selection = { model: 'grok-4.7-xhigh' };
      await applyRuntimeModelPreflight(config, agent, selection);
      // Let publication read a healthy catalog after the failed startup lookup.
      await writeFile(binary, successful);
      const api = fakeApi(selection);
      expect(await syncAgentModelCatalog({
        api: api as never, agent, agentEnv, agentId: 'agent-1', workspaceId: 'workspace-1', runtimeDir,
        startupUnavailable: config.modelUnavailable?.unavailable.label,
        startupSelection: config.modelUnavailable?.selection, log: vi.fn(),
      })).toBe('posted');
      expect(api.posted).toHaveLength(1);
      if (failure === 'absent') expect(api.posted[0]).toHaveProperty('unavailable', 'model');
      else expect(api.posted[0]).not.toHaveProperty('unavailable');
    }, 35_000,
  );

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
