import { describe, expect, it, vi } from 'vitest';
import { latestAdapterInstallCommand, type AgentCommand, type AgentKind } from './agent-command.js';
import { loadConnectModelCatalog } from './connect-command.js';
import { refreshRuntimeHarnessAdapters } from './self-update-cli.js';

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
});
