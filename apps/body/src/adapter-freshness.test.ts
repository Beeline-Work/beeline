import { describe, expect, it, vi } from 'vitest';
import { latestAdapterInstallCommand } from './agent-command.js';
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
