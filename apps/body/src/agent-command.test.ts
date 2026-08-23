import { afterEach, describe, expect, it } from 'vitest';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, resolve } from 'node:path';

import {
  detectInstalledAgentCommands,
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

describe('agent command selection', () => {
  it('distinguishes ready, missing-adapter, and absent auto-detect presets', async () => {
    const codex = await executable('codex');
    const codexAdapter = await executable('codex-acp');
    const claude = await executable('claude');
    const pi = await executable('pi');

    const detected = detectInstalledAgentCommands({
      env: {
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
      env: { PATH: [codex.directory, adapter.directory].join(delimiter) },
    });

    expect(selected).toEqual({ kind: 'codex', command: adapter.path, args: [] });
  });

  it('gives an actionable error when Claude Code has no ACP adapter', async () => {
    const claude = await executable('claude');

    expect(() => resolveAgentCommand({ kind: 'claude', env: { PATH: claude.directory } })).toThrow(
      'npm install -g @agentclientprotocol/claude-agent-acp',
    );
  });

  it("uses Goose's native ACP subcommand", async () => {
    const goose = await executable('goose');

    expect(resolveAgentCommand({ kind: 'goose', env: { PATH: goose.directory } })).toEqual({
      kind: 'goose',
      command: goose.path,
      args: ['acp'],
    });
  });

  it('uses the Grok CLI native ACP server with no adapter binary', async () => {
    const grok = await executable('grok');

    expect(resolveAgentCommand({ kind: 'grok', env: { PATH: grok.directory } })).toEqual({
      kind: 'grok',
      command: grok.path,
      args: ['agent', 'stdio'],
    });
  });

  it('gives an actionable install error when the Grok CLI is missing', () => {
    expect(() => resolveAgentCommand({ kind: 'grok', env: { PATH: '' } })).toThrow(
      'curl -fsSL https://x.ai/cli/install.sh | bash',
    );
  });

  it('detects a grok install as ready with no adapter step (native ACP)', async () => {
    const grok = await executable('grok');

    const detected = detectInstalledAgentCommands({ env: { PATH: grok.directory } });
    expect(detected).toEqual([
      { kind: 'grok', status: 'ready', agent: { kind: 'grok', command: grok.path, args: ['agent', 'stdio'] } },
    ]);
  });

  it('resolves a Cursor community-bridge custom command through the custom path', async () => {
    // Cursor's CLI has no native ACP mode; the documented path is the
    // third-party `cursor-acp` bridge driven through `--agent custom`.
    const cursorAcp = await executable('cursor-acp');

    expect(
      resolveAgentCommand({
        kind: 'custom',
        customCommand: 'cursor-acp',
        env: { PATH: cursorAcp.directory },
      }),
    ).toEqual({ kind: 'custom', command: cursorAcp.path, args: [] });
  });

  it('gives an actionable error when Pi has no ACP adapter', async () => {
    const pi = await executable('pi');

    expect(() => resolveAgentCommand({ kind: 'pi', env: { PATH: pi.directory } })).toThrow(
      'npm install -g pi-acp',
    );
  });

  it('parses and resolves a custom command without shell expansion', async () => {
    const custom = await executable('custom-agent');
    const selected = resolveAgentCommand({
      kind: 'custom',
      customCommand: `custom-agent serve --label "two words" escaped\\ value '$HOME'`,
      env: { PATH: custom.directory },
    });

    expect(selected).toEqual({
      kind: 'custom',
      command: custom.path,
      args: ['serve', '--label', 'two words', 'escaped value', '$HOME'],
    });
  });

  it('rejects malformed and misplaced custom commands', () => {
    expect(() => parseAgentCommand('agent "unfinished')).toThrow('unterminated');
    expect(() =>
      resolveAgentCommand({
        kind: 'reference',
        customCommand: 'agent --acp',
        env: { PATH: '' },
      }),
    ).toThrow('--agent-command may only be used with --agent custom');
  });
});
