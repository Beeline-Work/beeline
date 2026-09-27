import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmod, mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { AcpClient } from './acp.js';
import {
  installLatestAgentAdapter,
  latestAdapterInstallCommand,
  type AgentCommand,
  type AgentKind,
} from './agent-command.js';
import { adapterInstallLockPath, withAdapterInstallLock } from './adapter-install-lock.js';
import { loadConnectModelCatalog } from './connect-command.js';
import { refreshRuntimeHarnessAdapters } from './self-update-cli.js';

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function lockEnv(): Promise<NodeJS.ProcessEnv> {
  const root = await mkdtemp(join(tmpdir(), 'beeline-adapter-lock-'));
  roots.push(root);
  return { ...process.env, BEELINE_LIB_DIR: join(root, 'lib', 'beeline') };
}

describe('harness adapter freshness', () => {
  it.each([
    ['codex', '@agentclientprotocol/codex-acp@latest'],
    ['claude', '@agentclientprotocol/claude-agent-acp@latest'],
    ['pi', 'pi-acp@latest'],
  ] as const)('pins the %s adapter install to latest', (kind, packageSpec) => {
    expect(latestAdapterInstallCommand(kind)).toEqual({
      command: 'npm',
      args: ['install', '-g', packageSpec],
    });
  });

  it('refreshes before the wizard resolves and probes the adapter it will persist', async () => {
    let installed = false;
    const refreshAdapter = vi.fn(async (kind: AgentKind) => {
      expect(kind).toBe('codex');
      installed = true;
    });
    const resolveAgent = vi.fn((): AgentCommand => {
      expect(installed).toBe(true);
      return { kind: 'codex', command: '/latest/bin/codex-acp', args: [] };
    });
    const fetchCatalog = vi.fn(async (agent: Pick<AgentCommand, 'command' | 'args'>) => {
      expect(agent.command).toBe('/latest/bin/codex-acp');
      return {
        raw: [],
        catalog: [
          {
            id: 'model',
            category: 'model',
            currentValue: 'gpt-6-sol',
            options: [{ id: 'gpt-6-sol', name: 'GPT 6 Soul' }],
          },
        ],
      };
    });

    await expect(
      loadConnectModelCatalog({ harness: 'codex' }, { refreshAdapter, resolveAgent, fetchCatalog }),
    ).resolves.toMatchObject({
      currentValue: 'gpt-6-sol',
      options: [{ id: 'gpt-6-sol', name: 'GPT 6 Soul' }],
    });
    expect(refreshAdapter).toHaveBeenCalledTimes(1);
    expect(resolveAgent).toHaveBeenCalledTimes(1);
    expect(fetchCatalog).toHaveBeenCalledTimes(1);
  });

  it('refreshes each stored adapter once for update and start fan-out', async () => {
    const install = vi.fn(async () => undefined);
    const runtimes = new Map([
      ['/agents/speedy/runtime.json', { agentKind: 'codex' as const }],
      ['/agents/scout/runtime.json', { agentKind: 'codex' as const }],
      ['/agents/poet/runtime.json', { agentKind: 'claude' as const }],
      ['/agents/native/runtime.json', { agentKind: 'goose' as const }],
    ]);

    await refreshRuntimeHarnessAdapters({
      configPaths: [...runtimes.keys()],
      readRuntime: async (path) => runtimes.get(path) ?? {},
      install,
      readInstalledVersion: async () => '1.0.0',
      readLatestVersion: async () => '2.0.0',
      log: () => undefined,
    });

    expect(install.mock.calls).toEqual([
      [
        {
          command: 'npm',
          args: ['install', '-g', '@agentclientprotocol/codex-acp@latest'],
        },
      ],
      [
        {
          command: 'npm',
          args: ['install', '-g', '@agentclientprotocol/claude-agent-acp@latest'],
        },
      ],
    ]);
  });

  it('serializes concurrent adapter refresh callers across the same install', async () => {
    const env = await lockEnv();
    let active = 0;
    let maxActive = 0;
    const install = vi.fn(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((done) => setTimeout(done, 150));
      active -= 1;
    });
    const options = {
      env,
      readInstalledVersion: async () => undefined,
      readLatestVersion: async () => '2.0.0',
      install,
    };
    await Promise.all([
      installLatestAgentAdapter('codex', options),
      installLatestAgentAdapter('pi', options),
    ]);
    expect(maxActive).toBe(1);
    expect(install).toHaveBeenCalledTimes(2);
  });

  it('takes over an abandoned adapter lock after its bounded stale age', async () => {
    const env = await lockEnv();
    const lock = adapterInstallLockPath(env)!;
    await mkdir(join(lock, '..'), { recursive: true });
    await writeFile(lock, 'abandoned');
    const old = new Date(Date.now() - 5 * 60_000);
    await utimes(lock, old, old);
    await expect(withAdapterInstallLock(async () => 'recovered', env, 500)).resolves.toBe(
      'recovered',
    );
  });

  it('skips an installed current adapter and skips when the registry lookup fails', async () => {
    const env = await lockEnv();
    const install = vi.fn(async () => undefined);
    await expect(
      installLatestAgentAdapter('codex', {
        env,
        install,
        readInstalledVersion: async () => '2.0.0',
        readLatestVersion: async () => '2.0.0',
      }),
    ).resolves.toBe(false);
    await expect(
      installLatestAgentAdapter('codex', {
        env,
        install,
        readInstalledVersion: async () => '1.0.0',
        readLatestVersion: async () => {
          throw new Error('registry unavailable');
        },
      }),
    ).resolves.toBe(false);
    expect(install).not.toHaveBeenCalled();
  });

  it('reads the installed package version and published npm version before installing', async () => {
    const env = await lockEnv();
    const root = roots.at(-1)!;
    const bin = join(root, 'bin');
    const modules = join(root, 'global-modules');
    await mkdir(join(modules, '@agentclientprotocol', 'codex-acp'), { recursive: true });
    await mkdir(bin);
    await writeFile(
      join(modules, '@agentclientprotocol', 'codex-acp', 'package.json'),
      JSON.stringify({ version: '2.0.0' }),
    );
    const npm = join(bin, 'npm');
    await writeFile(
      npm,
      `#!/bin/sh\nif [ "$1" = root ]; then echo '${modules}'; elif [ "$1" = view ]; then echo 2.0.0; else exit 1; fi\n`,
    );
    await chmod(npm, 0o755);
    env.PATH = `${bin}${delimiter}${env.PATH ?? ''}`;
    const install = vi.fn(async () => undefined);
    await expect(installLatestAgentAdapter('codex', { env, install })).resolves.toBe(false);
    expect(install).not.toHaveBeenCalled();
  });

  it('holds a probe launch until an adapter install releases the lock', async () => {
    const env = await lockEnv();
    vi.stubEnv('BEELINE_LIB_DIR', env.BEELINE_LIB_DIR);
    const root = roots.at(-1)!;
    const binary = join(root, 'probe-agent');
    await writeFile(
      binary,
      `#!/usr/bin/env node\nprocess.stdin.on('data', data => { const request = JSON.parse(data.toString()); if (request.method === 'initialize') process.stdout.write(JSON.stringify({jsonrpc:'2.0', id:request.id, result:{protocolVersion:1}}) + '\\n'); });\n`,
    );
    await chmod(binary, 0o755);
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked!: () => void;
    const acquired = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const install = withAdapterInstallLock(async () => {
      locked();
      await held;
    }, env);
    await acquired;
    const client = new AcpClient({ agentCommand: binary, agentEnv: {} });
    let started = false;
    const start = client.start(2_000).then(() => {
      started = true;
    });
    await new Promise((done) => setTimeout(done, 150));
    expect(started).toBe(false);
    release();
    await Promise.all([install, start]);
    expect(started).toBe(true);
    client.stop();
  });
});
