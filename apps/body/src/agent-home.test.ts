import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import {
  hasAmbientTrustySquireConfiguration,
  hasLocalTrustySquireState,
  harnessStateDirsFromEnv,
  prepareRoomAgentHome,
  roomAgentHomeEnv,
} from './agent-home.js';
import { AGENT_PRIVATE_STATE_ENV } from './agent-private-state.js';
import { KNOWN_CREDENTIAL_MASK_PATHS } from './bwrap-sandbox.js';
import { tomlChildTableNames } from './toml-section.js';

const cleanup: string[] = [];

async function scratch(prefix: string): Promise<string> {
  const path = await mkdtemp(resolve(tmpdir(), prefix));
  cleanup.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('per-room harness state isolation', () => {
  it('points every harness state directory at this Room, and never overrides HOME', async () => {
    const operatorHome = await scratch('beeline-operator-home-');
    const roomA = resolve(await scratch('beeline-room-a-'), 'agent-home');
    const roomB = resolve(await scratch('beeline-room-b-'), 'agent-home');

    const envA = await prepareRoomAgentHome({ root: roomA, operatorHome });
    const envB = await prepareRoomAgentHome({ root: roomB, operatorHome });

    for (const key of [
      'CLAUDE_CONFIG_DIR',
      'CODEX_HOME',
      'GROK_HOME',
      'XDG_STATE_HOME',
      'XDG_CACHE_HOME',
      'TMPDIR',
    ]) {
      expect(envA[key]).toBeTruthy();
      expect(envA[key]!.startsWith(roomA)).toBe(true);
      // Two Rooms of the same agent must not share a harness state directory.
      expect(envA[key]).not.toBe(envB[key]);
    }
    // Captain's decision D2: isolate state, share credentials. Overriding HOME
    // would move harness auth too.
    expect(envA.HOME).toBeUndefined();
    expect(envB.HOME).toBeUndefined();
    expect(existsSync(resolve(roomA, 'claude'))).toBe(true);
    expect(existsSync(resolve(roomA, 'tmp'))).toBe(true);
  });

  it('shares the operator credentials into every isolated state directory', async () => {
    const operatorHome = await scratch('beeline-operator-home-');
    await mkdir(resolve(operatorHome, '.claude'), { recursive: true });
    await mkdir(resolve(operatorHome, '.codex'), { recursive: true });
    await mkdir(resolve(operatorHome, '.grok'), { recursive: true });
    await writeFile(resolve(operatorHome, '.claude/.credentials.json'), '{"token":"claude"}');
    await writeFile(resolve(operatorHome, '.codex/auth.json'), '{"token":"codex"}');
    await writeFile(resolve(operatorHome, '.grok/auth.json'), '{"token":"grok"}');

    const roomA = resolve(await scratch('beeline-room-a-'), 'agent-home');
    const roomB = resolve(await scratch('beeline-room-b-'), 'agent-home');
    await prepareRoomAgentHome({ root: roomA, operatorHome });
    await prepareRoomAgentHome({ root: roomB, operatorHome });

    for (const root of [roomA, roomB]) {
      const claude = resolve(root, 'claude/.credentials.json');
      const codex = resolve(root, 'codex/auth.json');
      const grok = resolve(root, 'grok/auth.json');
      expect(readFileSync(claude, 'utf8')).toBe('{"token":"claude"}');
      expect(readFileSync(codex, 'utf8')).toBe('{"token":"codex"}');
      expect(readFileSync(grok, 'utf8')).toBe('{"token":"grok"}');
      // Symlinked, not copied: a refreshed token stays shared with every other
      // room-instance and with the operator's own CLI.
      expect(lstatSync(claude).isSymbolicLink()).toBe(true);
      expect(lstatSync(codex).isSymbolicLink()).toBe(true);
      expect(lstatSync(grok).isSymbolicLink()).toBe(true);
    }
  });

  it('degrades to the daemon state instead of failing a Room it cannot isolate', async () => {
    const blocked = await scratch('beeline-blocked-');
    // A file where the agent home must go: mkdir fails, the Room must not.
    const root = resolve(blocked, 'agent-home');
    await writeFile(root, 'not a directory');

    await expect(prepareRoomAgentHome({ root })).resolves.toEqual({});
    await expect(prepareRoomAgentHome({ root, failClosed: true })).rejects.toThrow();
  });

  it('detects the local Trusty Squire state boundary', async () => {
    const operatorHome = await scratch('beeline-operator-home-');
    expect(hasLocalTrustySquireState(operatorHome)).toBe(false);
    await mkdir(resolve(operatorHome, '.config/trusty-squire'), { recursive: true });
    expect(hasLocalTrustySquireState(operatorHome)).toBe(true);

    const alternateOperatorHome = await scratch('beeline-alternate-operator-');
    const alternateHome = await scratch('beeline-alternate-xdg-');
    await mkdir(resolve(alternateHome, 'trusty-squire'), { recursive: true });
    expect(
      hasLocalTrustySquireState(alternateOperatorHome, { XDG_CONFIG_HOME: alternateHome }),
    ).toBe(true);
  });

  it('detects ambient Trusty Squire MCP declarations without a local vault', async () => {
    const operatorHome = await scratch('beeline-operator-home-');
    await mkdir(resolve(operatorHome, '.codex'), { recursive: true });
    await writeFile(
      resolve(operatorHome, '.codex/config.toml'),
      '[mcp_servers.vault]\ncommand = "npx"\nargs = ["-y", "@trusty-squire/mcp@1.1.12"]\n',
    );
    expect(hasAmbientTrustySquireConfiguration(operatorHome)).toBe(true);
  });

  it('derives the env overlay without touching the filesystem', () => {
    const overlay = roomAgentHomeEnv('/rooms/room-a/agent-home');
    expect(overlay).toEqual({
      CLAUDE_CONFIG_DIR: '/rooms/room-a/agent-home/claude',
      CODEX_HOME: '/rooms/room-a/agent-home/codex',
      GROK_HOME: '/rooms/room-a/agent-home/grok',
      XDG_STATE_HOME: '/rooms/room-a/agent-home/state',
      XDG_CACHE_HOME: '/rooms/room-a/agent-home/cache',
      TMPDIR: '/rooms/room-a/agent-home/tmp',
    });
    expect(existsSync('/rooms/room-a/agent-home')).toBe(false);
  });

  it('includes the explicit agent-private root in the writable sandbox state', () => {
    const { stateDirs } = harnessStateDirsFromEnv({
      [AGENT_PRIVATE_STATE_ENV]: '/rooms/room-a/agent-private',
    });

    expect(stateDirs).toEqual(['/rooms/room-a/agent-private']);
  });
});

describe('operator skills + MCP passthrough', () => {
  const operatorToml = [
    'model = "gpt-5-codex"',
    'approval_policy = "never"',
    'sandbox_mode = "danger-full-access"',
    '',
    '[mcp_servers.squire]',
    'command = "npx"',
    'args = ["-y", "@trusty-squire/mcp"]',
    '',
    '[mcp_servers.vault_tools]',
    'command = "npx"',
    'args = ["-y", "@trusty-squire/mcp@1.1.12"]',
    '',
    '[mcp_servers.stable_vault]',
    'command = "node"',
    'args = ["/opt/node_modules/@trusty-squire/mcp/dist/bin.js", "server"]',
    '',
    '[mcp_servers.project_tools]',
    'command = "project-tools"',
  ].join('\n');

  async function operatorHomeWithHarnessConfigs(): Promise<string> {
    const home = await scratch('beeline-operator-home-');
    for (const dir of ['.claude/skills', '.codex/skills', '.grok/skills']) {
      await mkdir(resolve(home, dir), { recursive: true });
    }
    await mkdir(resolve(home, '.claude/skills/greet'), { recursive: true });
    await writeFile(resolve(home, '.claude/skills/greet/SKILL.md'), 'say hi');
    await writeFile(resolve(home, '.codex/config.toml'), `${operatorToml}\n`);
    await writeFile(
      resolve(home, '.claude.json'),
      JSON.stringify({
        mcpServers: { files: { command: 'files-mcp', args: [] } },
        otherTopLevel: 'stays behind',
      }),
    );
    return home;
  }

  it('provisions a Beeline-managed skills directory per harness home with linked operator entries', async () => {
    const operatorHome = await operatorHomeWithHarnessConfigs();
    const roomRoot = resolve(await scratch('beeline-room-a-'), 'agent-home');

    await prepareRoomAgentHome({ root: roomRoot, operatorHome });

    // The discovery path stays <harness-home>/skills, but it is now a REAL
    // Beeline-managed directory: each OPERATOR entry is a symlink into the
    // operator's own tree, and the managed skill sits alongside them.
    const operatorSkillNames: Record<string, string | undefined> = {
      claude: 'greet',
      codex: undefined,
      grok: undefined,
    };
    for (const dir of ['claude', 'codex', 'grok']) {
      const skillsDir = resolve(roomRoot, dir, 'skills');
      expect(lstatSync(skillsDir).isSymbolicLink()).toBe(false);
      expect(lstatSync(skillsDir).isDirectory()).toBe(true);
      const operatorEntry = operatorSkillNames[dir];
      if (operatorEntry) {
        expect(lstatSync(resolve(skillsDir, operatorEntry)).isSymbolicLink()).toBe(true);
        expect(realpathSync(resolve(skillsDir, operatorEntry))).toBe(
          realpathSync(resolve(operatorHome, `.${dir}/skills/${operatorEntry}`)),
        );
      }
      const managedSkill = resolve(skillsDir, 'using-beeline', 'SKILL.md');
      expect(lstatSync(resolve(skillsDir, 'using-beeline')).isSymbolicLink()).toBe(false);
      expect(readFileSync(managedSkill, 'utf8')).toContain('name: using-beeline');
    }

    // The codex MCP config is a COPY carrying only mcp_servers — never a
    // symlink to the operator's real config.toml (codex-acp MERGES session MCP
    // servers into it and would corrupt the operator's file), and none of the
    // operator's model/sandbox/approval settings ride along.
    const isolatedConfig = resolve(roomRoot, 'codex', 'config.toml');
    const stats = lstatSync(isolatedConfig);
    expect(stats.isSymbolicLink()).toBe(false);
    expect(stats.isFile()).toBe(true);
    const isolatedText = readFileSync(isolatedConfig, 'utf8');
    expect(tomlChildTableNames(isolatedText, ['mcp_servers'])).toEqual(['project_tools']);

    // Writing through the session cannot reach the operator's real config.
    await writeFile(isolatedConfig, '[mcp_servers.scribe]\ncommand = "scribe"\n');
    const operatorText = readFileSync(resolve(operatorHome, '.codex/config.toml'), 'utf8');
    expect(operatorText).toContain('@trusty-squire/mcp');
    expect(operatorText).not.toContain('scribe');
  });

  it('copies claude user-scope MCP servers into the isolated CLAUDE_CONFIG_DIR and grok MCP into GROK_HOME', async () => {
    const operatorHome = await scratch('beeline-operator-home-');
    await mkdir(resolve(operatorHome, '.claude'), { recursive: true });
    await mkdir(resolve(operatorHome, '.grok'), { recursive: true });
    await writeFile(
      resolve(operatorHome, '.claude.json'),
      JSON.stringify({
        mcpServers: {
          files: { command: 'files-mcp' },
          squire: { command: 'npx', args: ['-y', '@trusty-squire/mcp'] },
          vault: { command: 'npx', args: ['-y', '@trusty-squire/mcp@1.1.12'] },
        },
      }),
    );
    await writeFile(
      resolve(operatorHome, '.grok/config.toml'),
      ['theme = "dark"', '', '[mcp_servers.tools]', 'command = "tools-mcp"'].join('\n'),
    );

    const roomRoot = resolve(await scratch('beeline-room-a-'), 'agent-home');
    await prepareRoomAgentHome({ root: roomRoot, operatorHome });

    const claudeJson = resolve(roomRoot, 'claude', '.claude.json');
    expect(lstatSync(claudeJson).isSymbolicLink()).toBe(false);
    const claudeParsed = JSON.parse(readFileSync(claudeJson, 'utf8')) as {
      mcpServers: Record<string, unknown>;
    };
    expect(Object.keys(claudeParsed.mcpServers)).toEqual(['files']);
    expect(claudeParsed).not.toHaveProperty('otherTopLevel');

    const grokConfig = readFileSync(resolve(roomRoot, 'grok', 'config.toml'), 'utf8');
    expect(tomlChildTableNames(grokConfig, ['mcp_servers'])).toEqual(['tools']);
  });

  it('regenerates the copied MCP configs on every prepare so operator edits reach existing rooms', async () => {
    const operatorHome = await scratch('beeline-operator-home-');
    await mkdir(resolve(operatorHome, '.codex/skills'), { recursive: true });
    await writeFile(
      resolve(operatorHome, '.codex/config.toml'),
      '[mcp_servers.one]\ncommand = "one"\n',
    );
    await writeFile(
      resolve(operatorHome, '.claude.json'),
      JSON.stringify({ mcpServers: { one: { command: 'one' } } }),
    );
    const roomRoot = resolve(await scratch('beeline-room-a-'), 'agent-home');

    await prepareRoomAgentHome({ root: roomRoot, operatorHome });
    expect(existsSync(resolve(roomRoot, 'claude', '.claude.json'))).toBe(true);
    await writeFile(
      resolve(operatorHome, '.codex/config.toml'),
      '[mcp_servers.one]\ncommand = "one"\n[mcp_servers.two]\ncommand = "two"\n',
    );
    await prepareRoomAgentHome({ root: roomRoot, operatorHome });

    const regenerated = readFileSync(resolve(roomRoot, 'codex', 'config.toml'), 'utf8');
    expect(regenerated).toContain('[mcp_servers.two]');

    await writeFile(resolve(operatorHome, '.codex/config.toml'), 'model = "gpt-5-codex"\n');
    await writeFile(resolve(operatorHome, '.claude.json'), JSON.stringify({ mcpServers: {} }));
    await prepareRoomAgentHome({ root: roomRoot, operatorHome });
    expect(existsSync(resolve(roomRoot, 'codex', 'config.toml'))).toBe(false);
    expect(existsSync(resolve(roomRoot, 'claude', '.claude.json'))).toBe(false);
  });

  it('replaces a session-authored config symlink instead of writing through it', async () => {
    const operatorHome = await operatorHomeWithHarnessConfigs();
    const roomRoot = resolve(await scratch('beeline-room-a-'), 'agent-home');
    const redirected = resolve(await scratch('beeline-redirected-'), 'config.toml');
    await writeFile(redirected, 'must stay unchanged\n');
    await prepareRoomAgentHome({ root: roomRoot, operatorHome });
    await rm(resolve(roomRoot, 'codex', 'config.toml'));
    await symlink(redirected, resolve(roomRoot, 'codex', 'config.toml'));

    await prepareRoomAgentHome({ root: roomRoot, operatorHome });

    expect(lstatSync(resolve(roomRoot, 'codex', 'config.toml')).isSymbolicLink()).toBe(false);
    expect(readFileSync(resolve(roomRoot, 'codex', 'config.toml'), 'utf8')).toContain(
      '[mcp_servers.project_tools]',
    );
    expect(readFileSync(redirected, 'utf8')).toBe('must stay unchanged\n');
  });

  it('skips cleanly when the operator has no skills or MCP config at all', async () => {
    const operatorHome = await scratch('beeline-operator-home-');
    const roomRoot = resolve(await scratch('beeline-room-a-'), 'agent-home');

    await expect(prepareRoomAgentHome({ root: roomRoot, operatorHome })).resolves.toEqual(
      roomAgentHomeEnv(roomRoot),
    );
    for (const dir of ['claude', 'codex', 'grok']) {
      // No operator skills to link, but the managed skill is still shipped.
      expect(existsSync(resolve(roomRoot, dir, 'skills', 'using-beeline', 'SKILL.md'))).toBe(true);
      expect(existsSync(resolve(roomRoot, dir, 'config.toml'))).toBe(false);
    }
    expect(existsSync(resolve(roomRoot, 'claude', '.claude.json'))).toBe(false);
  });

  it('never links a #376 credential mask store into any harness home', async () => {
    const operatorHome = await scratch('beeline-operator-home-');
    for (const masked of KNOWN_CREDENTIAL_MASK_PATHS) {
      const path = resolve(operatorHome, masked);
      await mkdir(path, { recursive: true }).catch(() => undefined);
      if (!existsSync(path)) await writeFile(path, 'secret');
    }
    await mkdir(resolve(operatorHome, '.codex/skills'), { recursive: true });
    await mkdir(resolve(operatorHome, '.codex/skills/audit'), { recursive: true });
    await writeFile(resolve(operatorHome, '.codex/skills/audit/SKILL.md'), 'operator skill\n');
    await mkdir(resolve(operatorHome, '.claude'), { recursive: true });

    const roomRoot = resolve(await scratch('beeline-room-a-'), 'agent-home');
    await prepareRoomAgentHome({ root: roomRoot, operatorHome });

    const links: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = resolve(dir, entry.name);
        if (entry.isSymbolicLink()) links.push(full);
        else if (entry.isDirectory()) walk(full);
      }
    };
    walk(roomRoot);
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) {
      const target = realpathSync(link);
      for (const masked of KNOWN_CREDENTIAL_MASK_PATHS) {
        const maskedPath = resolve(operatorHome, masked.replace(/\/+$/, ''));
        expect(target === maskedPath || target.startsWith(`${maskedPath}/`)).toBe(false);
      }
    }
  });
});
