import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import {
  AGENT_SKILL_DIRS,
  BEELINE_DEFAULT_SKILL_NAMES,
  hasAmbientTrustySquireConfiguration,
  hasLocalTrustySquireState,
  harnessStateDirsFromEnv,
  prepareRoomAgentHome,
  roomAgentHomeEnv,
} from './agent-home.js';
import { AGENT_PRIVATE_STATE_ENV } from './agent-private-state.js';
import { KNOWN_CREDENTIAL_MASK_PATHS } from './bwrap-sandbox.js';
import { filterModelOptionsByCredentials } from './model-config.js';
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
  it('points every harness state directory and HOME at this Room', async () => {
    const operatorHome = await scratch('beeline-operator-home-');
    const roomA = resolve(await scratch('beeline-room-a-'), 'agent-home');
    const roomB = resolve(await scratch('beeline-room-b-'), 'agent-home');

    const envA = await prepareRoomAgentHome({ root: roomA, operatorHome });
    const envB = await prepareRoomAgentHome({ root: roomB, operatorHome });

    for (const key of [
      'CLAUDE_CONFIG_DIR',
      'CODEX_HOME',
      'GROK_HOME',
      'PI_CODING_AGENT_DIR',
      'XDG_STATE_HOME',
      'XDG_CACHE_HOME',
      'TMPDIR',
      'HOME',
    ]) {
      expect(envA[key]).toBeTruthy();
      expect(envA[key]!.startsWith(roomA)).toBe(true);
      // Two Rooms of the same agent must not share a harness state directory.
      expect(envA[key]).not.toBe(envB[key]);
    }
    expect(envA.HOME).toBe(resolve(roomA, 'user'));
    expect(envB.HOME).toBe(resolve(roomB, 'user'));
    expect(existsSync(resolve(roomA, 'claude'))).toBe(true);
    expect(existsSync(resolve(roomA, 'tmp'))).toBe(true);
  });

  it('shares the operator credentials into every isolated state directory', async () => {
    const operatorHome = await scratch('beeline-operator-home-');
    await mkdir(resolve(operatorHome, '.claude'), { recursive: true });
    await mkdir(resolve(operatorHome, '.codex'), { recursive: true });
    await mkdir(resolve(operatorHome, '.grok'), { recursive: true });
    await mkdir(resolve(operatorHome, '.pi/agent'), { recursive: true });
    await writeFile(resolve(operatorHome, '.claude/.credentials.json'), '{"token":"claude"}');
    await writeFile(resolve(operatorHome, '.codex/auth.json'), '{"token":"codex"}');
    await writeFile(resolve(operatorHome, '.grok/auth.json'), '{"token":"grok"}');
    await writeFile(resolve(operatorHome, '.pi/agent/auth.json'), '{"token":"pi"}');

    const roomA = resolve(await scratch('beeline-room-a-'), 'agent-home');
    const roomB = resolve(await scratch('beeline-room-b-'), 'agent-home');
    await prepareRoomAgentHome({ root: roomA, operatorHome });
    await prepareRoomAgentHome({ root: roomB, operatorHome });

    for (const root of [roomA, roomB]) {
      const claude = resolve(root, 'claude/.credentials.json');
      const codex = resolve(root, 'codex/auth.json');
      const grok = resolve(root, 'grok/auth.json');
      const pi = resolve(root, 'pi/auth.json');
      expect(readFileSync(claude, 'utf8')).toBe('{"token":"claude"}');
      expect(readFileSync(codex, 'utf8')).toBe('{"token":"codex"}');
      expect(readFileSync(grok, 'utf8')).toBe('{"token":"grok"}');
      expect(readFileSync(pi, 'utf8')).toBe('{"token":"pi"}');
      // Symlinked, not copied: a refreshed token stays shared with every other
      // room-instance and with the operator's own CLI.
      expect(lstatSync(claude).isSymbolicLink()).toBe(true);
      expect(lstatSync(codex).isSymbolicLink()).toBe(true);
      expect(lstatSync(grok).isSymbolicLink()).toBe(true);
      expect(lstatSync(pi).isSymbolicLink()).toBe(true);
    }
  });

  it('copies Pi custom providers privately and refreshes them on every activation', async () => {
    const operatorHome = await scratch('beeline-operator-home-');
    await mkdir(resolve(operatorHome, '.pi/agent'), { recursive: true });
    await writeFile(resolve(operatorHome, '.pi/agent/auth.json'), '{}\n');
    await writeFile(
      resolve(operatorHome, '.pi/agent/models.json'),
      JSON.stringify({
        providers: [
          {
            name: 'openrouter-ox',
            apiKey: 'inline-secret',
            models: [{ id: 'z-ai/glm-5.3-flash' }],
          },
        ],
      }),
      { mode: 0o600 },
    );
    await writeFile(
      resolve(operatorHome, '.pi/agent/settings.json'),
      JSON.stringify({ defaultProvider: 'operator-default', theme: 'operator-theme' }),
    );
    const roomRoot = resolve(await scratch('beeline-room-a-'), 'agent-home');

    await prepareRoomAgentHome({ root: roomRoot, operatorHome });

    const isolatedModels = resolve(roomRoot, 'pi/models.json');
    expect(lstatSync(isolatedModels).isFile()).toBe(true);
    expect(lstatSync(isolatedModels).isSymbolicLink()).toBe(false);
    expect(lstatSync(isolatedModels).mode & 0o777).toBe(0o600);
    expect(readFileSync(isolatedModels, 'utf8')).toContain('inline-secret');
    expect(existsSync(resolve(roomRoot, 'pi/settings.json'))).toBe(false);
    const modelOptions = [
      {
        id: 'model',
        category: 'model',
        options: [
          { id: 'openrouter-ox/z-ai/glm-5.3-flash' },
          { id: 'unconfigured-provider/hidden-model' },
        ],
      },
    ];
    expect(
      filterModelOptionsByCredentials(modelOptions, {
        HOME: resolve(roomRoot, 'user'),
        PI_CODING_AGENT_DIR: resolve(roomRoot, 'pi'),
      })[0]?.options.map((choice) => choice.id),
    ).toEqual(['openrouter-ox/z-ai/glm-5.3-flash']);
    expect(
      filterModelOptionsByCredentials(modelOptions, { HOME: operatorHome })[0]?.options.map(
        (choice) => choice.id,
      ),
    ).toEqual(['openrouter-ox/z-ai/glm-5.3-flash']);
    for (const dir of AGENT_SKILL_DIRS) {
      expect(existsSync(resolve(roomRoot, dir, 'skills/models.json'))).toBe(false);
    }

    await writeFile(
      resolve(operatorHome, '.pi/agent/models.json'),
      JSON.stringify({
        providers: [
          {
            name: 'openrouter-ox',
            apiKey: 'rotated-secret',
            models: [{ id: 'z-ai/glm-5.3-flash' }, { id: 'z-ai/glm-5.4' }],
          },
        ],
      }),
      { mode: 0o600 },
    );
    await prepareRoomAgentHome({ root: roomRoot, operatorHome });

    expect(readFileSync(isolatedModels, 'utf8')).toContain('rotated-secret');
    expect(readFileSync(isolatedModels, 'utf8')).toContain('z-ai/glm-5.4');
    expect(lstatSync(isolatedModels).mode & 0o777).toBe(0o600);

    const redirected = resolve(await scratch('beeline-redirected-'), 'models.json');
    await writeFile(redirected, 'must stay unchanged\n');
    await rm(isolatedModels);
    await symlink(redirected, isolatedModels);
    await prepareRoomAgentHome({ root: roomRoot, operatorHome });
    expect(lstatSync(isolatedModels).isSymbolicLink()).toBe(false);
    expect(readFileSync(isolatedModels, 'utf8')).toContain('rotated-secret');
    expect(readFileSync(redirected, 'utf8')).toBe('must stay unchanged\n');

    await rm(resolve(operatorHome, '.pi/agent/models.json'));
    await prepareRoomAgentHome({ root: roomRoot, operatorHome });
    expect(existsSync(isolatedModels)).toBe(false);
  });

  it('rejects a linked Pi provider source instead of copying credential material', async () => {
    const operatorHome = await scratch('beeline-operator-home-');
    const external = resolve(await scratch('beeline-external-models-'), 'models.json');
    await mkdir(resolve(operatorHome, '.pi/agent'), { recursive: true });
    await writeFile(external, '{"providers":{"unsafe":{"apiKey":"secret"}}}', { mode: 0o600 });
    await symlink(external, resolve(operatorHome, '.pi/agent/models.json'));
    const roomRoot = resolve(await scratch('beeline-room-a-'), 'agent-home');

    await expect(
      prepareRoomAgentHome({ root: roomRoot, operatorHome, failClosed: true }),
    ).rejects.toThrow('Pi custom model config is not an ordinary private source file');
    expect(existsSync(resolve(roomRoot, 'pi/models.json'))).toBe(false);
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
      HOME: '/rooms/room-a/agent-home/user',
      CLAUDE_CONFIG_DIR: '/rooms/room-a/agent-home/claude',
      CODEX_HOME: '/rooms/room-a/agent-home/codex',
      GROK_HOME: '/rooms/room-a/agent-home/grok',
      PI_CODING_AGENT_DIR: '/rooms/room-a/agent-home/pi',
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
    '[agents]',
    'enabled = true',
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

  it('provisions the exact Beeline-owned defaults and never inherits ambient operator skills', async () => {
    const operatorHome = await operatorHomeWithHarnessConfigs();
    const roomRoot = resolve(await scratch('beeline-room-a-'), 'agent-home');

    await prepareRoomAgentHome({ root: roomRoot, operatorHome });

    for (const dir of AGENT_SKILL_DIRS) {
      const skillsDir = resolve(roomRoot, dir, 'skills');
      expect(lstatSync(skillsDir).isSymbolicLink()).toBe(false);
      expect(lstatSync(skillsDir).isDirectory()).toBe(true);
      expect(readdirSync(skillsDir).sort()).toEqual([...BEELINE_DEFAULT_SKILL_NAMES].sort());
      expect(existsSync(resolve(skillsDir, 'greet'))).toBe(false);
      const managedSkill = resolve(skillsDir, 'using-beeline', 'SKILL.md');
      expect(lstatSync(resolve(skillsDir, 'using-beeline')).isSymbolicLink()).toBe(false);
      expect(readFileSync(managedSkill, 'utf8')).toContain('name: using-beeline');
    }

    // The codex MCP config is a COPY carrying only mcp_servers — never a
    // symlink to the operator's real config.toml (codex-acp MERGES session MCP
    // servers into it and would corrupt the operator's file). The Beeline-owned
    // internal-agent lockdown is retained, but none of the operator's
    // model/sandbox/approval/agent settings ride along.
    const isolatedConfig = resolve(roomRoot, 'codex', 'config.toml');
    const stats = lstatSync(isolatedConfig);
    expect(stats.isSymbolicLink()).toBe(false);
    expect(stats.isFile()).toBe(true);
    const isolatedText = readFileSync(isolatedConfig, 'utf8');
    // This is the actual per-Room CODEX_HOME artifact, not a mocked option:
    // Codex reads this supported setting to remove its hidden delegation tool
    // family while ordinary Beeline-provisioned MCP tools remain available.
    expect(isolatedText).toContain('[agents]\nenabled = false');
    expect(isolatedText).not.toContain('enabled = true');
    expect(tomlChildTableNames(isolatedText, ['mcp_servers'])).toEqual(['project_tools']);

    // Writing through the session cannot reach the operator's real config.
    await writeFile(isolatedConfig, '[mcp_servers.scribe]\ncommand = "scribe"\n');
    const operatorText = readFileSync(resolve(operatorHome, '.codex/config.toml'), 'utf8');
    expect(operatorText).toContain('@trusty-squire/mcp');
    expect(operatorText).not.toContain('scribe');
  });

  it('copies one explicit per-agent skill without enabling ambient inheritance', async () => {
    const operatorHome = await operatorHomeWithHarnessConfigs();
    await mkdir(resolve(operatorHome, '.agents/skills/review-pr'), { recursive: true });
    await writeFile(
      resolve(operatorHome, '.agents/skills/review-pr/SKILL.md'),
      '---\nname: review-pr\ndescription: Review a PR.\n---\n',
    );
    await writeFile(resolve(operatorHome, '.agents/skills/review-pr/run.sh'), '#!/bin/sh\n');
    await chmod(resolve(operatorHome, '.agents/skills/review-pr/run.sh'), 0o755);
    const sharedAgent = resolve(await scratch('beeline-shared-agent-'), 'agent-home');
    const cleanAgent = resolve(await scratch('beeline-clean-agent-'), 'agent-home');

    await prepareRoomAgentHome({ root: sharedAgent, operatorHome, sharedSkills: ['review-pr'] });
    await prepareRoomAgentHome({ root: cleanAgent, operatorHome });

    for (const dir of AGENT_SKILL_DIRS) {
      expect(readdirSync(resolve(sharedAgent, dir, 'skills')).sort()).toEqual(
        [...BEELINE_DEFAULT_SKILL_NAMES, 'review-pr'].sort(),
      );
      expect(lstatSync(resolve(sharedAgent, dir, 'skills/review-pr')).isSymbolicLink()).toBe(false);
      expect(lstatSync(resolve(sharedAgent, dir, 'skills/review-pr/run.sh')).mode & 0o111).toBe(0);
      expect(existsSync(resolve(cleanAgent, dir, 'skills/review-pr'))).toBe(false);
      expect(existsSync(resolve(sharedAgent, dir, 'skills/greet'))).toBe(false);
    }
  });

  it('rejects unsafe explicit shares and destination escapes', async () => {
    const operatorHome = await scratch('beeline-operator-home-');
    await mkdir(resolve(operatorHome, '.agents/skills'), { recursive: true });
    const outside = await scratch('beeline-outside-skill-');
    await writeFile(resolve(outside, 'SKILL.md'), 'outside');
    await symlink(outside, resolve(operatorHome, '.agents/skills/escaped'));
    const linkedFile = resolve(operatorHome, '.agents/skills/hardlinked');
    await mkdir(linkedFile);
    await writeFile(resolve(outside, 'ordinary.md'), 'hardlink');
    await writeFile(resolve(linkedFile, 'SKILL.md'), '---\nname: hardlinked\n---\n');
    await import('node:fs/promises').then(({ link }) =>
      link(resolve(outside, 'ordinary.md'), resolve(linkedFile, 'payload.md')),
    );
    const fifoSkill = resolve(operatorHome, '.agents/skills/fifo-skill');
    await mkdir(fifoSkill);
    await writeFile(resolve(fifoSkill, 'SKILL.md'), '---\nname: fifo-skill\n---\n');
    execFileSync('mkfifo', [resolve(fifoSkill, 'pipe')]);
    const credentialSkill = resolve(operatorHome, '.agents/skills/credential-skill');
    await mkdir(credentialSkill);
    await writeFile(resolve(credentialSkill, 'SKILL.md'), '---\nname: credential-skill\n---\n');
    await writeFile(resolve(credentialSkill, 'config.toml'), 'token = "secret"\n');
    const pluginSkill = resolve(operatorHome, '.agents/skills/plugin-skill');
    await mkdir(resolve(pluginSkill, '.codex-plugin'), { recursive: true });
    await writeFile(resolve(pluginSkill, 'SKILL.md'), '---\nname: plugin-skill\n---\n');
    const memorySkill = resolve(operatorHome, '.agents/skills/memory-skill');
    await mkdir(memorySkill);
    await writeFile(resolve(memorySkill, 'SKILL.md'), '---\nname: memory-skill\n---\n');
    await writeFile(resolve(memorySkill, 'MEMORY.md'), 'personal\n');

    for (const name of [
      '../escape',
      'using-beeline',
      'escaped',
      'hardlinked',
      'fifo-skill',
      'credential-skill',
      'plugin-skill',
      'memory-skill',
    ]) {
      const root = resolve(await scratch('beeline-unsafe-share-'), 'agent-home');
      await expect(
        prepareRoomAgentHome({ root, operatorHome, sharedSkills: [name] }),
      ).rejects.toThrow();
    }

    const redirectedRoot = resolve(await scratch('beeline-destination-'), 'agent-home');
    await mkdir(redirectedRoot, { recursive: true });
    await symlink(outside, resolve(redirectedRoot, 'codex'));
    await expect(prepareRoomAgentHome({ root: redirectedRoot, operatorHome })).rejects.toThrow();
    expect(readFileSync(resolve(outside, 'SKILL.md'), 'utf8')).toBe('outside');
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
    expect(readFileSync(resolve(roomRoot, 'codex', 'config.toml'), 'utf8')).toBe(
      '[agents]\nenabled = false\n',
    );
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

  it('keeps Codex delegation disabled when the operator has no shared MCP config', async () => {
    const operatorHome = await scratch('beeline-operator-home-');
    const roomRoot = resolve(await scratch('beeline-room-a-'), 'agent-home');

    await expect(prepareRoomAgentHome({ root: roomRoot, operatorHome })).resolves.toEqual(
      roomAgentHomeEnv(roomRoot),
    );
    for (const dir of AGENT_SKILL_DIRS) {
      // No operator skills to link, but the managed skill is still shipped.
      expect(existsSync(resolve(roomRoot, dir, 'skills', 'using-beeline', 'SKILL.md'))).toBe(true);
    }
    // Codex's collaboration tools default on, so its isolated config is
    // intentionally present even without operator configuration. Other
    // harnesses still have no config to generate.
    expect(readFileSync(resolve(roomRoot, 'codex', 'config.toml'), 'utf8')).toBe(
      '[agents]\nenabled = false\n',
    );
    expect(existsSync(resolve(roomRoot, 'claude', 'config.toml'))).toBe(false);
    expect(existsSync(resolve(roomRoot, 'grok', 'config.toml'))).toBe(false);
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
    expect(existsSync(resolve(roomRoot, 'codex/skills/audit'))).toBe(false);
    for (const link of links) {
      const target = realpathSync(link);
      for (const masked of KNOWN_CREDENTIAL_MASK_PATHS) {
        const maskedPath = resolve(operatorHome, masked.replace(/\/+$/, ''));
        expect(target === maskedPath || target.startsWith(`${maskedPath}/`)).toBe(false);
      }
    }
  });
});
