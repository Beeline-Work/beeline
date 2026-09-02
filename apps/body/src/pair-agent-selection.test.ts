import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, resolve } from 'node:path';

import { selectPairAgentCommand } from './pair-agent-selection.js';

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function executables(...names: string[]): Promise<string> {
  const directory = await mkdtemp(resolve(tmpdir(), 'beeline-pair-agent-'));
  cleanup.push(directory);
  await Promise.all(names.map((name) => addExecutable(directory, name)));
  return directory;
}

async function addExecutable(directory: string, name: string): Promise<void> {
  const path = resolve(directory, name);
  await writeFile(path, '#!/bin/sh\nexit 0\n');
  await chmod(path, 0o755);
}

function capture(): { output: Pick<NodeJS.WritableStream, 'write'>; text: () => string } {
  let value = '';
  return {
    output: {
      write(chunk: Uint8Array | string): boolean {
        value += chunk.toString();
        return true;
      },
    },
    text: () => value,
  };
}

describe('pair agent auto-selection', () => {
  it('fails clearly when no real ACP-capable agent is installed', async () => {
    await expect(selectPairAgentCommand({ env: { PATH: '' }, interactive: false })).rejects.toThrow(
      /No supported ACP-capable coding agent.*codex.*claude.*goose.*pi.*--agent reference.*LLM key.*--agent custom/s,
    );
  });

  it('auto-selects and announces the sole detected agent', async () => {
    const directory = await executables('codex', 'codex-acp');
    const log = capture();

    const selected = await selectPairAgentCommand({
      env: { PATH: directory },
      interactive: false,
      output: log.output,
    });

    expect(selected).toMatchObject({ kind: 'codex', command: resolve(directory, 'codex-acp') });
    expect(log.text()).toBe('[beeline] using codex (auto-detected)\n');
  });

  it('offers a picker over every detected agent and persists the selected command', async () => {
    const codex = await executables('codex', 'codex-acp');
    const goose = await executables('goose');
    const log = capture();
    const selectAgent = vi.fn().mockResolvedValue('goose');

    const selected = await selectPairAgentCommand({
      env: { PATH: [codex, goose].join(delimiter) },
      interactive: true,
      output: log.output,
      selectAgent,
    });

    expect(selected).toEqual({ kind: 'goose', command: resolve(goose, 'goose'), args: ['acp'] });
    expect(selectAgent).toHaveBeenCalledWith([
      expect.objectContaining({ kind: 'codex', status: 'ready' }),
      expect.objectContaining({ kind: 'goose', status: 'ready' }),
    ]);
    expect(log.text()).toContain('[beeline] using goose (selected)');
  });

  it('auto-selects a native-ACP grok install without any adapter step', async () => {
    const grok = await executables('grok');
    const log = capture();

    const selected = await selectPairAgentCommand({
      env: { PATH: grok },
      interactive: false,
      output: log.output,
    });

    expect(selected).toEqual({
      kind: 'grok',
      command: resolve(grok, 'grok'),
      args: ['agent', 'stdio'],
    });
    expect(log.text()).toContain('[beeline] using grok (auto-detected)');
  });

  it('refuses to guess among several detected agents without a TTY', async () => {
    const codex = await executables('codex', 'codex-acp');
    const goose = await executables('goose');

    await expect(
      selectPairAgentCommand({
        env: { PATH: [codex, goose].join(delimiter) },
        interactive: false,
      }),
    ).rejects.toThrow(/codex, goose.*non-interactive.*--agent <name>/);
  });

  it('surfaces an installed agent with a missing adapter and installs it when selected', async () => {
    const directory = await executables('claude', 'goose');
    const log = capture();
    const installs: Array<{ command: string; args: string[] }> = [];
    const selectAgent = vi.fn().mockResolvedValue('claude');

    const selected = await selectPairAgentCommand({
      env: { PATH: directory },
      interactive: true,
      output: log.output,
      selectAgent,
      install: async (command) => {
        installs.push(command);
        await addExecutable(directory, 'claude-agent-acp');
      },
    });

    expect(selectAgent).toHaveBeenCalledWith([
      expect.objectContaining({ kind: 'claude', status: 'missing-adapter' }),
      expect.objectContaining({ kind: 'goose', status: 'ready' }),
    ]);
    expect(installs).toEqual([
      {
        command: 'npm',
        args: ['install', '-g', '@agentclientprotocol/claude-agent-acp'],
      },
    ]);
    expect(selected).toEqual({
      kind: 'claude',
      command: resolve(directory, 'claude-agent-acp'),
      args: [],
    });
    expect(log.text()).toContain('[beeline] using claude (adapter installed)');
  });

  it.each([
    {
      kind: 'codex' as const,
      binary: 'codex',
      adapter: 'codex-acp',
      packageName: '@agentclientprotocol/codex-acp',
    },
    {
      kind: 'claude' as const,
      binary: 'claude',
      adapter: 'claude-agent-acp',
      packageName: '@agentclientprotocol/claude-agent-acp',
    },
    { kind: 'pi' as const, binary: 'pi', adapter: 'pi-acp', packageName: 'pi-acp' },
  ])(
    'offers the exact $kind adapter install for an explicit preset and re-resolves it',
    async ({ kind, binary, adapter, packageName }) => {
      const directory = await executables(binary);
      const installs: Array<{ command: string; args: string[] }> = [];
      const confirmInstall = vi.fn().mockResolvedValue(true);

      const selected = await selectPairAgentCommand({
        explicitKind: kind,
        env: { PATH: directory },
        interactive: true,
        confirmInstall,
        install: async (command) => {
          installs.push(command);
          await addExecutable(directory, adapter);
        },
      });

      expect(confirmInstall).toHaveBeenCalledWith(expect.stringContaining('Install now?'));
      expect(installs).toEqual([{ command: 'npm', args: ['install', '-g', packageName] }]);
      expect(selected).toEqual({ kind, command: resolve(directory, adapter), args: [] });
    },
  );

  it('declines an explicit preset install when confirmInstall resolves false', async () => {
    const directory = await executables('pi');
    let installed = false;

    await expect(
      selectPairAgentCommand({
        explicitKind: 'pi',
        env: { PATH: directory },
        interactive: true,
        confirmInstall: async () => false,
        install: async () => {
          installed = true;
        },
      }),
    ).rejects.toThrow(/pi adapter not installed/);

    expect(installed).toBe(false);
  });

  it('prints the manual command and does not install an explicit preset without a TTY', async () => {
    const directory = await executables('pi');
    const log = capture();
    let installed = false;

    await expect(
      selectPairAgentCommand({
        explicitKind: 'pi',
        env: { PATH: directory },
        interactive: false,
        output: log.output,
        install: async () => {
          installed = true;
        },
      }),
    ).rejects.toThrow(/cannot be used non-interactively/);

    expect(log.text()).toBe('pi adapter not installed; install it with: npm install -g pi-acp\n');
    expect(installed).toBe(false);
  });

  it('surfaces a missing adapter without auto-installing during non-interactive detection', async () => {
    const directory = await executables('claude');
    const log = capture();
    let installed = false;

    await expect(
      selectPairAgentCommand({
        env: { PATH: directory },
        interactive: false,
        output: log.output,
        install: async () => {
          installed = true;
        },
      }),
    ).rejects.toThrow(/need ACP adapter setup/);

    expect(log.text()).toBe(
      'claude adapter not installed; install it with: npm install -g @agentclientprotocol/claude-agent-acp\n',
    );
    expect(installed).toBe(false);
  });

  it('reports install failure with the manual command and lets another menu choice proceed', async () => {
    const directory = await executables('claude', 'goose');
    const log = capture();
    const picks = ['claude', 'goose'];
    const selectAgent = vi.fn().mockImplementation(async () => picks.shift());

    const selected = await selectPairAgentCommand({
      env: { PATH: directory },
      interactive: true,
      output: log.output,
      selectAgent,
      install: async () => {
        throw new Error('permission denied');
      },
    });

    expect(selected.kind).toBe('goose');
    expect(selectAgent).toHaveBeenCalledTimes(2);
    expect(log.text()).toContain('could not install the claude adapter: permission denied');
    expect(log.text()).toContain(
      'install it with: npm install -g @agentclientprotocol/claude-agent-acp',
    );
    expect(log.text()).toContain('[beeline] using goose (selected)');
  });

  it('lets an explicit preset bypass detection and prompting', async () => {
    const reference = await executables('buzz-agent');
    const selectAgent = vi.fn();

    const selected = await selectPairAgentCommand({
      explicitKind: 'reference',
      env: { PATH: reference },
      interactive: true,
      selectAgent,
    });

    expect(selected.kind).toBe('reference');
    expect(selectAgent).not.toHaveBeenCalled();
  });

  it('keeps an explicit custom ACP command working without detection', async () => {
    const directory = await executables('my-acp');

    await expect(
      selectPairAgentCommand({
        explicitKind: 'custom',
        customCommand: 'my-acp serve --stdio',
        env: { PATH: directory },
        interactive: false,
      }),
    ).resolves.toEqual({
      kind: 'custom',
      command: resolve(directory, 'my-acp'),
      args: ['serve', '--stdio'],
    });
  });
});

describe('pair agent selection — clack cancel handling', () => {
  it('exits cleanly (no throw past the caller, no stack trace) when the agent picker is cancelled', async () => {
    vi.resetModules();
    vi.doMock('@clack/prompts', () => ({
      select: vi.fn().mockResolvedValue(Symbol('clack.cancel')),
      confirm: vi.fn(),
      isCancel: (value: unknown) => typeof value === 'symbol',
      cancel: vi.fn(),
    }));
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);

    try {
      const { selectPairAgentCommand: selectWithMockedClack } =
        await import('./pair-agent-selection.js');
      const codex = await executables('codex', 'codex-acp');
      const goose = await executables('goose');

      await expect(
        selectWithMockedClack({
          env: { PATH: [codex, goose].join(delimiter) },
          interactive: true,
        }),
      ).rejects.toThrow('process.exit(1)');
      expect(exitSpy).toHaveBeenCalledWith(1);
    } finally {
      exitSpy.mockRestore();
      vi.doUnmock('@clack/prompts');
      vi.resetModules();
    }
  });
});
