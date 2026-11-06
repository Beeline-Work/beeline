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
import { runtimeAgentCommand, type AgentRuntimeRecord } from './runtime.js';

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
          args: ['install', '-g', '@agentclientprotocol/claude-agent-acp@latest'],
        },
      },
      {
        kind: 'pi',
        status: 'missing-adapter',
        install: { command: 'npm', args: ['install', '-g', 'pi-acp@latest'] },
      },
    ]);
    expect(detected.some((candidate) => candidate.kind === 'goose')).toBe(false);
  });

  it('resolves the Codex CLI and its ACP adapter to an exact command', async () => {
    const codex = await executable('codex');
    const adapter = await executable('codex-acp');
    const selected = resolveAgentCommand({
      kind: 'codex',
      env: {
        HOME: await hermeticHome(),
        PATH: [codex.directory, adapter.directory].join(delimiter),
      },
    });

    expect(selected).toEqual({ kind: 'codex', command: adapter.path, args: [] });
  });

  it('gives an actionable error when Claude Code has no ACP adapter', async () => {
    const claude = await executable('claude');
    const home = await hermeticHome();

    expect(() =>
      resolveAgentCommand({ kind: 'claude', env: { HOME: home, PATH: claude.directory } }),
    ).toThrow('npm install -g @agentclientprotocol/claude-agent-acp@latest');
  });

  it("uses Goose's native ACP subcommand", async () => {
    const goose = await executable('goose');

    expect(
      resolveAgentCommand({
        kind: 'goose',
        env: { HOME: await hermeticHome(), PATH: goose.directory },
      }),
    ).toEqual({
      kind: 'goose',
      command: goose.path,
      args: ['acp'],
    });
  });

  it('detects and resolves OpenCode as a native ACP agent', async () => {
    const opencode = await executable('opencode');
    const env = {
      HOME: await hermeticHome(),
      PATH: opencode.directory,
      BEELINE_HARNESS_PATH_AUGMENT: '0',
    };
    expect(resolveAgentCommand({ kind: 'opencode', env })).toEqual({
      kind: 'opencode',
      command: opencode.path,
      args: ['acp'],
    });
    expect(detectInstalledAgentCommands({ env })).toEqual([
      {
        kind: 'opencode',
        status: 'ready',
        agent: { kind: 'opencode', command: opencode.path, args: ['acp'] },
      },
    ]);
    expect(() => resolveAgentCommand({ kind: 'opencode', env: { ...env, PATH: '' } })).toThrow(
      'npm install -g opencode-ai',
    );
  });

  it('uses the Grok CLI native ACP server with no adapter binary', async () => {
    const grok = await executable('grok');

    expect(
      resolveAgentCommand({
        kind: 'grok',
        env: { HOME: await hermeticHome(), PATH: grok.directory },
      }),
    ).toEqual({
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

  it("resolves a Cursor Agent CLI install through Beeline's owned ACP bridge", async () => {
    const cursorAgent = await executable('cursor-agent');
    const selected = resolveAgentCommand({
      kind: 'cursor',
      env: {
        HOME: await hermeticHome(),
        PATH: cursorAgent.directory,
      },
    });
    expect(selected.kind).toBe('cursor');
    expect(selected.command).toBe(process.execPath);
    expect(selected.args.some((arg) => arg.includes('cursor-acp-bridge'))).toBe(true);
    expect(selected.args).not.toContain('cursor-agent-acp');
  });

  it('gives an actionable install error when the Cursor Agent CLI is missing', async () => {
    const home = await hermeticHome();
    expect(() => resolveAgentCommand({ kind: 'cursor', env: { HOME: home, PATH: '' } })).toThrow(
      'Cursor is not installed on this machine',
    );
  });

  it('detects a cursor-agent install as ready with no adapter step', async () => {
    const cursorAgent = await executable('cursor-agent');
    const home = await hermeticHome();
    const detected = detectInstalledAgentCommands({
      env: { HOME: home, PATH: cursorAgent.directory },
    });
    expect(detected).toContainEqual({
      kind: 'cursor',
      status: 'ready',
      agent: expect.objectContaining({
        kind: 'cursor',
        command: process.execPath,
      }),
    });
    expect(
      detected.some(
        (candidate) => candidate.status === 'missing-adapter' && candidate.kind === 'cursor',
      ),
    ).toBe(false);
  });

  it('re-resolves a stored cursor-agent-acp runtime onto the owned bridge', async () => {
    const cursorAgent = await executable('cursor-agent');
    const selected = runtimeAgentCommand(
      {
        agentKind: 'cursor',
        agentCommand: '/usr/bin/cursor-agent-acp',
        agentArgs: [],
        agentBinary: '/usr/bin/cursor-agent-acp',
      } as AgentRuntimeRecord,
      { HOME: await hermeticHome(), PATH: cursorAgent.directory },
    );
    expect(selected.kind).toBe('cursor');
    expect(selected.command).toBe(process.execPath);
    expect(selected.args.some((arg) => arg.includes('cursor-acp-bridge'))).toBe(true);
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
    ).toThrow('npm install -g pi-acp@latest');
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
    const oldBin = resolve(home, '.local/share/fnm/node-versions/v20.19.6/installation/bin');
    const newBin = resolve(home, '.local/share/fnm/node-versions/v24.16.0/installation/bin');
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
    expect(message).toContain('curl -fsSL https://pi.dev/install.sh | sh');
    expect(message).toContain('Pi is not installed on this machine (pi)');
  });
});

import { afterEach as m20_afterEach, describe as m20_describe, expect as m20_expect, it as m20_it, vi as m20_vi } from 'vitest';

import { chmod as m20_chmod, mkdir as m20_mkdir, mkdtemp as m20_mkdtemp, rm as m20_rm, writeFile as m20_writeFile } from 'node:fs/promises';

import { tmpdir as m20_tmpdir } from 'node:os';

import { join as m20_join } from 'node:path';

import {
  AUTO_DETECT_AGENT_KINDS as m20_AUTO_DETECT_AGENT_KINDS,
  installedAgentProgramEnvironment as m20_installedAgentProgramEnvironment,
  missingAgentProgramMessage as m20_missingAgentProgramMessage,
  explainAgentProgramFailure as m20_explainAgentProgramFailure,
} from "./agent-command.js";

import { collectConnectWizard as m20_collectConnectWizard, CONNECT_HARNESSES as m20_CONNECT_HARNESSES, type ConnectPrompts as m20_ConnectPrompts } from "./connect-command.js";

import { loadBodyConfig as m20_loadBodyConfig } from "./config.js";
import { describe as mergedDescribe20 } from 'vitest';
mergedDescribe20("installed-agent-program.test.ts", () => {

const roots: string[] = [];

m20_afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => m20_rm(path, { recursive: true, force: true })));
});

async function fixture() {
  const root = await m20_mkdtemp(m20_join(m20_tmpdir(), 'beeline-installed-program-'));
  roots.push(root);
  const bin = m20_join(root, 'bin');
  await m20_mkdir(bin);
  return { root, bin, env: { HOME: root, PATH: bin, BEELINE_HARNESS_PATH_AUGMENT: '0' } };
}

m20_describe('installed agent programs', () => {
  m20_it.each(m20_AUTO_DETECT_AGENT_KINDS)(
    'stops the wizard before probing a missing %s program',
    async (kind) => {
      const { env } = await fixture();
      const loadModels = m20_vi.fn();
      const prompts = {
        select: async (input: { options: { value: string }[] }) => {
          m20_expect(input.options.map((option) => option.value)).toEqual([...m20_CONNECT_HARNESSES]);
          return kind;
        },
      } as unknown as m20_ConnectPrompts;
      await m20_expect(
        m20_collectConnectWizard(
          prompts,
          loadModels,
          { read: async () => undefined, save: async () => {} },
          env,
          async () => undefined,
          { detect: () => [] },
        ),
      ).rejects.toThrow(m20_missingAgentProgramMessage(kind));
      m20_expect(loadModels).not.toHaveBeenCalled();
    },
  );
  m20_it.each([
    ['claude', 'claude', 'CLAUDE_CODE_EXECUTABLE'],
    ['codex', 'codex', 'CODEX_PATH'],
    ['pi', 'pi', 'PI_ACP_PI_COMMAND'],
  ] as const)('sets the %s adapter launch to the user program', async (kind, binary, variable) => {
    const { bin, env, root } = await fixture();
    const program = m20_join(bin, binary);
    await m20_writeFile(program, '#!/bin/sh\necho 2.0.0\n');
    await m20_chmod(program, 0o755);
    const overrides = m20_installedAgentProgramEnvironment(kind, env);
    m20_expect(overrides).toEqual({ [variable]: program });
    const config = m20_loadBodyConfig({
      workspaceRoot: root,
      agent: { kind, command: m20_join(bin, `${kind}-acp`), args: [] },
      env: { ...env, BUZZ_DEV_MCP_BIN: '/bin/true', BEELINE_READONLY_MCP_BIN: '/bin/true' },
    });
    m20_expect(config.agentEnv[variable]).toBe(program);
  });
  m20_it('names the installed Claude version and remedy when an old CLI rejects adapter flags', async () => {
    const { bin, env } = await fixture();
    const program = m20_join(bin, 'claude');
    await m20_writeFile(program, '#!/bin/sh\necho 1.0.0\n');
    await m20_chmod(program, 0o755);
    const error = await m20_explainAgentProgramFailure(new Error('unknown option --settings'), {
      ...env,
      CLAUDE_CODE_EXECUTABLE: program,
    });
    m20_expect(String(error)).toContain('Claude Code 1.0.0 could not start');
    m20_expect(String(error)).toContain('curl -fsSL https://claude.ai/install.sh | bash');
  });
});
});
