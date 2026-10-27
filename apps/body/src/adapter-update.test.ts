import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';
import { installLatestAgentAdapter, resolveAgentCommand } from './agent-command.js';
import { activeAdapterCommand, adapterStatePath, readAdapterState } from './adapter-store.js';
import {
  agedAdapterVersion,
  ADAPTER_RELEASE_AGE_MS,
  type AdapterRegistry,
} from './adapter-update.js';
import { checkAdapterSession } from './adapter-session-check.js';
import { bodyAgentCommand } from './config.js';
import * as sentry from './sentry.js';
import { MANAGED_ADAPTERS } from './adapter-store.js';
import { runtimeAgentCommand, type AgentRuntimeRecord } from './runtime.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const now = Date.parse('2026-10-27T12:00:00Z');
const registry = (version = '2.0.0'): AdapterRegistry => ({
  'dist-tags': { latest: version },
  time: { [version]: new Date(now - ADAPTER_RELEASE_AGE_MS).toISOString() },
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'beeline-safe-adapter-'));
  roots.push(root);
  const env = {
    ...process.env,
    HOME: root,
    XDG_DATA_HOME: join(root, 'data'),
    BEELINE_HARNESS_PATH_AUGMENT: '0',
  };
  const old = join(root, 'working-adapter');
  await writeFile(old, '#!/bin/sh\nexit 0\n');
  await chmod(old, 0o755);
  const state = adapterStatePath('codex', env);
  await mkdir(dirname(state), { recursive: true });
  await writeFile(state, JSON.stringify({ active: { version: '1.0.0', command: old } }));
  return { root, env, old };
}

it('keeps the working adapter and alerts once across concurrent helpers and later starts; retries the next version', async () => {
  const { root, env, old } = await fixture();
  const alert = vi.fn(async () => undefined);
  const install = vi.fn(async () => undefined);
  const checkSession = vi.fn(async () => {
    throw new Error('ACP error -32602: Invalid params');
  });
  const options = {
    env,
    now: () => now,
    readRegistry: async () => registry(),
    install,
    checkSession,
    alert,
  };
  expect(
    await Promise.all([
      installLatestAgentAdapter('codex', options),
      installLatestAgentAdapter('codex', options),
    ]),
  ).toEqual([false, false]);
  expect(await installLatestAgentAdapter('codex', options)).toBe(false);
  expect(activeAdapterCommand('codex', env)).toBe(old);
  expect(await readFile(old, 'utf8')).toContain('exit 0');
  expect(install).toHaveBeenCalledTimes(1);
  expect(checkSession).toHaveBeenCalledTimes(1);
  expect(alert).toHaveBeenCalledTimes(1);
  expect(alert.mock.calls[0]?.[0]).toMatchObject({
    message: expect.stringContaining('@agentclientprotocol/codex-acp@2.0.0: ACP error -32602'),
  });
  expect(readAdapterState('codex', env).rejected?.['2.0.0']).toBeDefined();
  const passed = vi.fn(async () => ({ protocolVersion: 1, agentCapabilities: {} }));
  expect(
    await installLatestAgentAdapter('codex', {
      ...options,
      readRegistry: async () => registry('2.0.1'),
      checkSession: passed,
    }),
  ).toBe(true);
  expect(activeAdapterCommand('codex', env)).not.toBe(old);
  expect(activeAdapterCommand('codex', env)).toContain(root);
  expect(alert).toHaveBeenCalledTimes(1);
});

it('uses npm publish time at the one-day boundary and follows the newest eligible latest-channel release', () => {
  const versions: AdapterRegistry = {
    'dist-tags': { latest: '2.3.0' },
    time: {
      created: '2020-01-01T00:00:00Z',
      modified: new Date(now).toISOString(),
      '2.2.9': new Date(now - ADAPTER_RELEASE_AGE_MS).toISOString(),
      '2.3.0': new Date(now - ADAPTER_RELEASE_AGE_MS + 1).toISOString(),
      '3.0.0-beta.1': '2020-01-01T00:00:00Z',
    },
  };
  expect(agedAdapterVersion(versions, now)).toBe('2.2.9');
  expect(agedAdapterVersion(versions, now + 1)).toBe('2.3.0');
});

it('skips a young-only candidate and an unavailable registry without touching the working copy', async () => {
  const { env, old } = await fixture();
  const install = vi.fn(async () => undefined);
  const young = registry();
  young.time['2.0.0'] = new Date(now - 1000).toISOString();
  expect(
    await installLatestAgentAdapter('codex', {
      env,
      now: () => now,
      install,
      readRegistry: async () => young,
    }),
  ).toBe(false);
  expect(
    await installLatestAgentAdapter('codex', {
      env,
      install,
      readRegistry: async () => {
        throw new Error('offline');
      },
    }),
  ).toBe(false);
  expect(install).not.toHaveBeenCalled();
  expect(activeAdapterCommand('codex', env)).toBe(old);
});

it('leaves the working adapter intact after partial npm failure', async () => {
  const { env, old } = await fixture();
  await expect(
    installLatestAgentAdapter('codex', {
      env,
      readRegistry: async () => registry(),
      install: async (command) => {
        const prefix = command.args[command.args.indexOf('--prefix') + 1]!;
        await writeFile(join(prefix, 'partial'), 'partial install');
        throw new Error('npm failed');
      },
    }),
  ).rejects.toThrow('npm failed');
  expect(activeAdapterCommand('codex', env)).toBe(old);
  expect(await readFile(old, 'utf8')).toContain('exit 0');
});

it('all agent resolvers, including saved global commands, use the promoted adapter', async () => {
  const { env, old, root } = await fixture();
  const codex = join(root, 'codex');
  await writeFile(codex, '#!/bin/sh\nexit 0\n');
  await chmod(codex, 0o755);
  env.PATH = root;
  expect(resolveAgentCommand({ kind: 'codex', env }).command).toBe(old);
  const saved = {
    agentKind: 'codex',
    agentCommand: '/legacy/bin/codex-acp',
    agentBinary: '/legacy/bin/codex-acp',
  } as AgentRuntimeRecord;
  expect(runtimeAgentCommand(saved, env).command).toBe(old);
});

async function adapterProcess(root: string, mode: 'pass' | 'reject' | 'protocol' | 'capabilities') {
  const command = join(root, 'codex-acp');
  const trace = join(root, 'requests.jsonl');
  await writeFile(
    command,
    `#!${process.execPath}
const fs = require('node:fs');
require('node:readline').createInterface({input:process.stdin}).on('line', line => {
 const r = JSON.parse(line); fs.appendFileSync(${JSON.stringify(trace)}, line+'\\n');
 if (r.id === undefined) return;
 let result;
 if (r.method === 'initialize') result = {protocolVersion:${mode === 'protocol' ? 99 : 1},agentCapabilities:${mode === 'capabilities' ? 'null' : '{promptCapabilities:{image:true}}'}};
 else if (r.method === 'session/new') {
   if (${JSON.stringify(mode)} === 'reject') { process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:r.id,error:{code:-32602,message:'Invalid params'}})+'\\n'); return; }
   result = {sessionId:'probe-session'};
 } else { process.exit(23); }
 process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:r.id,result})+'\\n');
});`,
  );
  await chmod(command, 0o755);
  return { command, trace };
}

it.each(['pass', 'reject', 'protocol', 'capabilities'] as const)(
  'runs real ACP initialize/session/new with production parameters: %s',
  async (mode) => {
    const { root } = await fixture();
    const { command, trace } = await adapterProcess(root, mode);
    const check = checkAdapterSession({
      command,
      env: { PATH: process.env.PATH!, HOME: root },
      timeoutMs: 2000,
    });
    if (mode === 'pass')
      await expect(check).resolves.toMatchObject({
        protocolVersion: 1,
        agentCapabilities: { promptCapabilities: { image: true } },
      });
    else
      await expect(check).rejects.toThrow(
        mode === 'reject'
          ? 'Invalid params'
          : mode === 'protocol'
            ? 'protocolVersion'
            : 'agentCapabilities',
      );
    const requests = (await readFile(trace, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(requests.some((r) => r.method === 'session/prompt')).toBe(false);
    if (mode === 'pass' || mode === 'reject') {
      const session = requests.find((r) => r.method === 'session/new');
      expect(session.params.systemPrompt).toBeTruthy();
      expect(session.params.mcpServers).toHaveLength(1);
      expect(session.params.mcpServers[0]).toMatchObject({ command: process.execPath, env: [] });
    }
  },
);

it('serializes independent helper processes into a single install and promotion', async () => {
  const { root, env } = await fixture();
  const module = fileURLToPath(new URL('./agent-command.ts', import.meta.url));
  const log = join(root, 'installs');
  const script = `import { installLatestAgentAdapter } from ${JSON.stringify(module)};
import { appendFile } from 'node:fs/promises';
await installLatestAgentAdapter('codex', {
 readRegistry: async () => (${JSON.stringify(registry())}),
 install: async () => { await appendFile(${JSON.stringify(log)}, 'install\\n'); await new Promise(done => setTimeout(done, 100)); },
 checkSession: async () => ({protocolVersion:1,agentCapabilities:{}}),
});`;
  const run = () =>
    new Promise<void>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        ['--import', 'tsx', '--input-type=module', '-e', script],
        { env, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      let stderr = '';
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
      });
      child.on('error', reject);
      child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(stderr))));
    });
  await Promise.all([run(), run()]);
  expect(await readFile(log, 'utf8')).toBe('install\n');
  expect(readAdapterState('codex', env).active?.version).toBe('2.0.0');
});

it.each(['codex', 'claude', 'pi'] as const)(
  'protects %s with the real session check and the existing Sentry alert route',
  async (kind) => {
    const { root, env } = await fixture();
    const adapter = MANAGED_ADAPTERS[kind];
    const statePath = adapterStatePath(kind, env);
    const working = join(root, 'working-adapter');
    await mkdir(dirname(statePath), { recursive: true });
    await writeFile(statePath, JSON.stringify({ active: { version: '1.0.0', command: working } }));
    const capture = vi.spyOn(sentry, 'captureHelperError').mockImplementation(() => undefined);
    const flush = vi.spyOn(sentry, 'flushHelperErrors').mockResolvedValue(undefined);
    let broken = true;
    const install = async (request: { args: string[] }) => {
      const prefix = request.args[request.args.indexOf('--prefix') + 1]!;
      const bin = join(prefix, 'node_modules/.bin');
      await mkdir(bin, { recursive: true });
      const generated = await adapterProcess(bin, broken ? 'reject' : 'pass');
      if (adapter.binary !== 'codex-acp') {
        await writeFile(join(bin, adapter.binary), await readFile(generated.command));
        await chmod(join(bin, adapter.binary), 0o755);
      }
    };
    try {
      const options = { env, readRegistry: async () => registry(), install };
      expect(await installLatestAgentAdapter(kind, options)).toBe(false);
      expect(await installLatestAgentAdapter(kind, options)).toBe(false);
      expect(activeAdapterCommand(kind, env)).toBe(working);
      expect(capture).toHaveBeenCalledTimes(1);
      expect(capture.mock.calls[0]?.[0]).toMatchObject({
        message: expect.stringContaining(adapter.packageName + '@2.0.0'),
      });
      expect(flush).toHaveBeenCalledTimes(1);
      broken = false;
      expect(
        await installLatestAgentAdapter(kind, {
          ...options,
          readRegistry: async () => registry('2.0.1'),
        }),
      ).toBe(true);
      const command = activeAdapterCommand(kind, env)!;
      expect(command).not.toBe(working);
      expect(await readFile(command, 'utf8')).toContain('probe-session');
      expect(capture).toHaveBeenCalledTimes(1);
    } finally {
      capture.mockRestore();
      flush.mockRestore();
    }
  },
);

it('running helpers resolve the shared promotion for every new Room/corner session without restarting', async () => {
  const { env, old } = await fixture();
  const config = {
    agentKind: 'codex' as const,
    agentCommand: old,
    agentBinary: old,
    agentEnv: env,
  };
  expect(bodyAgentCommand(config)).toBe(old);
  expect(
    await installLatestAgentAdapter('codex', {
      env,
      readRegistry: async () => registry(),
      install: async () => undefined,
      checkSession: async () => ({ protocolVersion: 1, agentCapabilities: { loadSession: true } }),
    }),
  ).toBe(true);
  expect(bodyAgentCommand(config)).toBe(activeAdapterCommand('codex', env));
  expect(bodyAgentCommand(config)).not.toBe(old);
  expect(readAdapterState('codex', env).active?.negotiated).toEqual({
    protocolVersion: 1,
    agentCapabilities: { loadSession: true },
  });
});
