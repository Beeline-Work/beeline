import { afterEach, describe, expect, it } from 'vitest';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, resolve } from 'node:path';

import {
  detectInstalledAgentCommands,
  executableOnPath,
  parseAgentCommand,
  resolveAgentCommand,
} from './agent-command.js';

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function executable(name: string): Promise<{ directory: string; path: string }> {
  const directory = await mkdtemp(resolve(tmpdir(), 'beeline-agent-command-'));
  cleanup.push(directory);
  const path = resolve(directory, name);
  await writeFile(path, '#!/bin/sh\nexit 0\n');
  await chmod(path, 0o755);
  return { directory, path };
}

/** Hermetic HOME so the augmented well-known-dir scan never sees this machine. */
async function hermeticHome(): Promise<string> {
  const home = await mkdtemp(resolve(tmpdir(), 'beeline-hermetic-home-'));
  cleanup.push(home);
  return home;
}

describe('agent command selection', () => {
  it('distinguishes ready, missing-adapter, and absent auto-detect presets', async () => {
    const codex = await executable('codex');
    const codexAdapter = await executable('codex-acp');
    const claude = await executable('claude');
    const pi = await executable('pi');

    const detected = detectInstalledAgentCommands({
      env: {
        HOME: await hermeticHome(),
        PATH: [codex.directory, codexAdapter.directory, claude.directory, pi.directory].join(
          delimiter,
        ),
      },
    });

    expect(detected).toEqual([
      {
        kind: 'codex',
        status: 'ready',
        agent: { kind: 'codex', command: codexAdapter.path, args: [] },
      },
      {
        kind: 'claude',
        status: 'missing-adapter',
        install: {
          command: 'npm',
          args: ['install', '-g', '@agentclientprotocol/claude-agent-acp'],
        },
      },
      {
        kind: 'pi',
        status: 'missing-adapter',
        install: { command: 'npm', args: ['install', '-g', 'pi-acp'] },
      },
    ]);
    expect(detected.some((candidate) => candidate.kind === 'goose')).toBe(false);
  });

  it('resolves the Codex CLI and its ACP adapter to an exact command', async () => {
    const codex = await executable('codex');
    const adapter = await executable('codex-acp');
    const selected = resolveAgentCommand({
      kind: 'codex',
      env: { HOME: await hermeticHome(), PATH: [codex.directory, adapter.directory].join(delimiter) },
    });

    expect(selected).toEqual({ kind: 'codex', command: adapter.path, args: [] });
  });

  it('gives an actionable error when Claude Code has no ACP adapter', async () => {
    const claude = await executable('claude');
    const home = await hermeticHome();

    expect(() =>
      resolveAgentCommand({ kind: 'claude', env: { HOME: home, PATH: claude.directory } }),
    ).toThrow('npm install -g @agentclientprotocol/claude-agent-acp');
  });

  it("uses Goose's native ACP subcommand", async () => {
    const goose = await executable('goose');

    expect(resolveAgentCommand({ kind: 'goose', env: { HOME: await hermeticHome(), PATH: goose.directory } })).toEqual({
      kind: 'goose',
      command: goose.path,
      args: ['acp'],
    });
  });

  it('uses the Grok CLI native ACP server with no adapter binary', async () => {
    const grok = await executable('grok');

    expect(resolveAgentCommand({ kind: 'grok', env: { HOME: await hermeticHome(), PATH: grok.directory } })).toEqual({
      kind: 'grok',
      command: grok.path,
      args: ['agent', 'stdio'],
    });
  });

  it('gives an actionable install error when the Grok CLI is missing', async () => {
    const home = await hermeticHome();
    expect(() => resolveAgentCommand({ kind: 'grok', env: { HOME: home, PATH: '' } })).toThrow(
      'curl -fsSL https://x.ai/cli/install.sh | bash',
    );
  });

  it('detects a grok install as ready with no adapter step (native ACP)', async () => {
    const grok = await executable('grok');

    const home = await hermeticHome();
    const detected = detectInstalledAgentCommands({ env: { HOME: home, PATH: grok.directory } });
    expect(detected).toContainEqual({
      kind: 'grok',
      status: 'ready',
      agent: { kind: 'grok', command: grok.path, args: ['agent', 'stdio'] },
    });
  });

  it('resolves a Cursor community-bridge custom command through the custom path', async () => {
    // Cursor's CLI has no native ACP mode; the documented path is the
    // third-party `cursor-acp` bridge driven through `--agent custom`.
    const cursorAcp = await executable('cursor-acp');

    expect(
      resolveAgentCommand({
        kind: 'custom',
        customCommand: 'cursor-acp',
        env: { HOME: await hermeticHome(), PATH: cursorAcp.directory },
      }),
    ).toEqual({ kind: 'custom', command: cursorAcp.path, args: [] });
  });

  it('gives an actionable error when Pi has no ACP adapter', async () => {
    const pi = await executable('pi');
    const home = await hermeticHome();

    expect(() =>
      resolveAgentCommand({ kind: 'pi', env: { HOME: home, PATH: pi.directory } }),
    ).toThrow('npm install -g pi-acp');
  });

  it('parses and resolves a custom command without shell expansion', async () => {
    const custom = await executable('custom-agent');
    const selected = resolveAgentCommand({
      kind: 'custom',
      customCommand: `custom-agent serve --label "two words" escaped\\ value '$HOME'`,
      env: { HOME: await hermeticHome(), PATH: custom.directory },
    });

    expect(selected).toEqual({
      kind: 'custom',
      command: custom.path,
      args: ['serve', '--label', 'two words', 'escaped value', '$HOME'],
    });
  });

  it('rejects malformed and misplaced custom commands', async () => {
    expect(() => parseAgentCommand('agent "unfinished')).toThrow('unterminated');
    const home = await hermeticHome();
    expect(() =>
      resolveAgentCommand({
        kind: 'reference',
        customCommand: 'agent --acp',
        env: { HOME: home, PATH: '' },
      }),
    ).toThrow('--agent-command may only be used with --agent custom');
  });
});

describe('augmented harness lookup', () => {
  it('finds a harness under a synthetic fnm layout when PATH lacks it, preferring the newest node version', async () => {
    const home = await mkdtemp(resolve(tmpdir(), 'beeline-fnm-lookup-'));
    cleanup.push(home);
    const oldBin = resolve(
      home,
      '.local/share/fnm/node-versions/v20.19.6/installation/bin',
    );
    const newBin = resolve(
      home,
      '.local/share/fnm/node-versions/v24.16.0/installation/bin',
    );
    const { mkdir } = await import('node:fs/promises');
    await mkdir(oldBin, { recursive: true });
    await mkdir(newBin, { recursive: true });
    for (const bin of [oldBin, newBin]) {
      for (const name of ['pi', 'pi-acp']) {
        await writeFile(resolve(bin, name), '#!/bin/sh\nexit 0\n');
        await chmod(resolve(bin, name), 0o755);
      }
    }
    const env = { HOME: home, PATH: '/usr/bin:/bin' };

    expect(executableOnPath('pi-acp', env)).toBe(resolve(newBin, 'pi-acp'));
    expect(resolveAgentCommand({ kind: 'pi', env })).toEqual({
      kind: 'pi',
      command: resolve(newBin, 'pi-acp'),
      args: [],
    });
  });

  it('scans a synthetic nvm layout newest-first and honors BEELINE_LAUNCHER_PATH last', async () => {
    const home = await mkdtemp(resolve(tmpdir(), 'beeline-nvm-lookup-'));
    cleanup.push(home);
    const { mkdir } = await import('node:fs/promises');
    const nvmBin = resolve(home, '.nvm/versions/node/v22.23.2/bin');
    const launcherBin = await executable('pi-acp');
    await mkdir(nvmBin, { recursive: true });
    await writeFile(resolve(nvmBin, 'pi'), '#!/bin/sh\nexit 0\n');
    await chmod(resolve(nvmBin, 'pi'), 0o755);

    const env = {
      HOME: home,
      PATH: '/usr/bin:/bin',
      BEELINE_LAUNCHER_PATH: `${launcherBin.directory}:/usr/bin`,
    };
    expect(executableOnPath('pi-acp', env)).toBe(launcherBin.path);
    expect(executableOnPath('pi', env)).toBe(resolve(nvmBin, 'pi'));
  });

  it('lists the searched locations and the install command when a harness is missing', async () => {
    const home = await mkdtemp(resolve(tmpdir(), 'beeline-lookup-miss-'));
    cleanup.push(home);
    let message = '';
    try {
      resolveAgentCommand({ kind: 'pi', env: { HOME: home, PATH: '/usr/bin:/bin' } });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('npm install -g @mariozechner/pi-coding-agent');
    expect(message).toContain('Searched:');
    expect(message).toContain('/usr/bin');
    expect(message).toContain(resolve(home, '.local', 'bin'));
  });
});
