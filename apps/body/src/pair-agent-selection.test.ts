import { afterEach, describe, expect, it } from 'vitest';
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
    expect(log.text()).toBe('[buzz] using codex (auto-detected)\n');
  });

  it('shows a numbered TTY menu and persists the selected detected command', async () => {
    const codex = await executables('codex', 'codex-acp');
    const goose = await executables('goose');
    const log = capture();

    const selected = await selectPairAgentCommand({
      env: { PATH: [codex, goose].join(delimiter) },
      interactive: true,
      output: log.output,
      ask: async () => '2',
    });

    expect(selected).toEqual({ kind: 'goose', command: resolve(goose, 'goose'), args: ['acp'] });
    expect(log.text()).toContain(
      "Which agent should back this repo's agent?\n  1) codex\n  2) goose\n",
    );
    expect(log.text()).toContain('[buzz] using goose (selected)');
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

    const selected = await selectPairAgentCommand({
      env: { PATH: directory },
      interactive: true,
      output: log.output,
      ask: async () => '1',
      install: async (command) => {
        installs.push(command);
        await addExecutable(directory, 'claude-agent-acp');
      },
    });

    expect(log.text()).toContain('1) claude (adapter not installed — install now?)\n  2) goose');
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
    expect(log.text()).toContain('[buzz] using claude (adapter installed)');
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

      const selected = await selectPairAgentCommand({
        explicitKind: kind,
        env: { PATH: directory },
        interactive: true,
        ask: async () => 'yes',
        install: async (command) => {
          installs.push(command);
          await addExecutable(directory, adapter);
        },
      });

      expect(installs).toEqual([{ command: 'npm', args: ['install', '-g', packageName] }]);
      expect(selected).toEqual({ kind, command: resolve(directory, adapter), args: [] });
    },
  );

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

  it('exits nonzero and prints the exact manual command through the real CLI', async () => {
    const directory = await executables('pi');
    const result = spawnSync(
      process.execPath,
      ['--import', 'tsx', 'src/cli.ts', 'pair', 'BUZZ-TEST-TEST', '--agent', 'pi'],
      {
        cwd: process.cwd(),
        env: { ...process.env, PATH: directory },
        encoding: 'utf8',
      },
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toContain(
      'pi adapter not installed; install it with: npm install -g pi-acp',
    );
    expect(result.stderr).toContain('pi cannot be used non-interactively');
  });

  it('reports install failure with the manual command and lets another menu choice proceed', async () => {
    const directory = await executables('claude', 'goose');
    const log = capture();
    const answers = ['1', '2'];

    const selected = await selectPairAgentCommand({
      env: { PATH: directory },
      interactive: true,
      output: log.output,
      ask: async () => answers.shift()!,
      install: async () => {
        throw new Error('permission denied');
      },
    });

    expect(selected.kind).toBe('goose');
    expect(log.text()).toContain('could not install the claude adapter: permission denied');
    expect(log.text()).toContain(
      'install it with: npm install -g @agentclientprotocol/claude-agent-acp',
    );
    expect(log.text()).toContain('[buzz] using goose (selected)');
  });

  it('lets an explicit preset bypass detection and prompting', async () => {
    const reference = await executables('buzz-agent');
    let asked = false;

    const selected = await selectPairAgentCommand({
      explicitKind: 'reference',
      env: { PATH: reference },
      interactive: true,
      ask: async () => {
        asked = true;
        return '1';
      },
    });

    expect(selected.kind).toBe('reference');
    expect(asked).toBe(false);
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
