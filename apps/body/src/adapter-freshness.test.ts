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
import { withAdapterInstallLock } from './adapter-install-lock.js';
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
  return { ...process.env, HOME: root, XDG_DATA_HOME: join(root, 'data'), BEELINE_LIB_DIR: join(root, 'lib', 'beeline') };
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
    const env = await lockEnv();
    const install = vi.fn(async () => undefined);
    await refreshRuntimeHarnessAdapters({
      env,
      configPaths: ['one', 'two', 'three', 'native'],
      readRuntime: async path => ({ agentKind: path === 'native' ? 'goose' : path === 'three' ? 'claude' : 'codex' }),
      readRegistry: async () => ({ 'dist-tags': { latest: '2.0.0' }, time: { '2.0.0': '2020-01-01T00:00:00Z' } }),
      checkSession: async () => ({ protocolVersion: 1, agentCapabilities: {} }),
      install,
      log: () => undefined,
    });
    expect(install).toHaveBeenCalledTimes(2);
    expect(install.mock.calls).toEqual([
      [expect.objectContaining({ args: expect.arrayContaining(['@agentclientprotocol/codex-acp@2.0.0']) })],
      [expect.objectContaining({ args: expect.arrayContaining(['@agentclientprotocol/claude-agent-acp@2.0.0']) })],
    ]);
  });

  it('ignores an abandoned legacy lock file; the kernel owns exclusion', async () => {
    const env = await lockEnv();
    const lock = join(env.BEELINE_LIB_DIR!, '../beeline-releases/.state/adapter-install.lock');
    await mkdir(join(lock, '..'), { recursive: true });
    await writeFile(lock, 'abandoned');
    const old = new Date(Date.now() - 5 * 60_000);
    await utimes(lock, old, old);
    await expect(withAdapterInstallLock(async () => 'recovered', env, 500)).resolves.toBe(
      'recovered',
    );
  });

  it('starts a working adapter while a candidate install holds the lock', async () => {
    const env = await lockEnv();
    vi.stubEnv('BEELINE_LIB_DIR', env.BEELINE_LIB_DIR);
    vi.stubEnv('HOME', env.HOME);
    vi.stubEnv('XDG_DATA_HOME', env.XDG_DATA_HOME);
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
    const start = client.start(10_000).then(() => {
      started = true;
    });
    try {
      // Process startup varies under the full suite's load. Observe completion
      // while the lock is still held instead of assuming a 150ms launch time.
      await vi.waitFor(() => expect(started).toBe(true), { timeout: 5_000 });
    } finally {
      release();
      await Promise.all([install, start]);
      await client.stop();
    }
  });
});
