import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { parse as parseToml } from 'smol-toml';
import { parse as parseYaml } from 'yaml';
import { AGENT_KINDS } from './agent-command.js';
import {
  AGENT_SKILL_DIRS,
  agentSkillDir,
  BEELINE_DEFAULT_SKILL_NAMES,
  hasAmbientTrustySquireConfiguration,
  hasLocalTrustySquireState,
  harnessStateDirsFromEnv,
  hostImportedMcpServerNames,
  expectedMountedImportedMcpServerNames,
  mountedImportedMcpServerNames,
  prepareRoomAgentHome,
  roomAgentHomeEnv,
} from './agent-home.js';
import {
  BEELINE_REVIEW_SKILL_NAME,
  BEELINE_SPEC_SKILL_NAME,
  BEELINE_TRIAGE_SKILL_NAME,
  USING_BEELINE_SKILL_NAME,
} from './beeline-skill.js';
import { OPENROUTER_GLM_5_3_FLASH_ENDPOINTS } from './fixtures/openrouter-endpoints-glm-5.3-flash.js';
const AGENT_PRIVATE_STATE_ENV = 'BUZZY_AGENT_PRIVATE_DIR';
import { MCP_ROUTE_CLASS_KEY, MCP_ROUTE_HOST } from './mcp-route-class.js';
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
  it('pins the selected OpenRouter model to its live-derived provider set, per model', async () => {
    const operatorHome = await scratch('beeline-operator-home-');
    const roomRoot = resolve(await scratch('beeline-room-a-'), 'agent-home');
    const cacheDir = resolve(await scratch('beeline-routing-cache-'), 'openrouter-routing');
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify(OPENROUTER_GLM_5_3_FLASH_ENDPOINTS), { status: 200 }),
    ) as unknown as typeof fetch;

    await prepareRoomAgentHome({
      root: roomRoot,
      operatorHome,
      openRouterRouting: { model: 'z-ai/glm-5.3-flash', cacheDir, fetchImpl },
    });

    const models = JSON.parse(readFileSync(resolve(roomRoot, 'pi/models.json'), 'utf8'));
    const routing =
      models.providers.openrouter.modelOverrides['z-ai/glm-5.3-flash'].compat.openRouterRouting;
    expect(routing).toMatchObject({ allow_fallbacks: true, require_parameters: false });
    expect(routing.only).toEqual(routing.order);
    expect(routing.only.slice(0, 3)).toEqual(['morph', 'baseten', 'modal']);
    expect(routing.only).toContain('deepinfra');
    expect(routing.only).toContain('novita');
    expect(routing.only).not.toContain('gmicloud');
    expect(models.providers.openrouter.compat).toBeUndefined();
    expect(existsSync(resolve(cacheDir, 'z-ai_glm-5.3-flash.json'))).toBe(true);

    // C87: the model's live input modalities are pinned on the same override.
    // Without them a custom-model entry defaults the model to text and pi
    // strips every image from the prompt before it reaches OpenRouter.
    expect(models.providers.openrouter.modelOverrides['z-ai/glm-5.3-flash'].input).toEqual([
      'text',
      'image',
    ]);

    // No OpenRouter selection: nothing is pinned, globally or otherwise.
    await prepareRoomAgentHome({ root: roomRoot, operatorHome });
    expect(JSON.parse(readFileSync(resolve(roomRoot, 'pi/models.json'), 'utf8'))).toEqual({
      providers: {},
    });
  });
  it("restores vision on the operator's own custom-model entry without touching it", async () => {
    const operatorHome = await scratch('beeline-operator-home-');
    const roomRoot = resolve(await scratch('beeline-room-pin-'), 'agent-home');
    const cacheDir = resolve(await scratch('beeline-routing-cache-'), 'openrouter-routing');
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify(OPENROUTER_GLM_5_3_FLASH_ENDPOINTS), { status: 200 }),
    ) as unknown as typeof fetch;
    // The shape every Beeline OpenRouter agent has: the key is fronted by an
    // egress proxy, so the model is a custom definition, and a custom
    // definition without `input` is what pi downgrades to text.
    await mkdir(resolve(operatorHome, '.pi/agent'), { recursive: true });
    await writeFile(
      resolve(operatorHome, '.pi/agent/models.json'),
      JSON.stringify({
        providers: {
          openrouter: {
            baseUrl: 'https://egress.example/v1',
            apiKey: 'k',
            api: 'openai-completions',
            models: [{ id: 'z-ai/glm-5.3-flash', reasoning: true, contextWindow: 98304 }],
          },
        },
      }),
    );

    await prepareRoomAgentHome({
      root: roomRoot,
      operatorHome,
      openRouterRouting: { model: 'z-ai/glm-5.3-flash', cacheDir, fetchImpl },
    });

    const models = JSON.parse(readFileSync(resolve(roomRoot, 'pi/models.json'), 'utf8'));
    expect(models.providers.openrouter.models).toEqual([
      { id: 'z-ai/glm-5.3-flash', reasoning: true, contextWindow: 98304 },
    ]);
    expect(models.providers.openrouter.modelOverrides['z-ai/glm-5.3-flash'].input).toEqual([
      'text',
      'image',
    ]);
  });

  it("carries the operator's Goose configuration in as a copy, and drops it when removed", async () => {
    const operatorHome = await scratch('beeline-operator-home-');
    const roomRoot = resolve(await scratch('beeline-room-goose-'), 'agent-home');
    await mkdir(resolve(operatorHome, '.config/goose'), { recursive: true });
    await writeFile(
      resolve(operatorHome, '.config/goose/config.yaml'),
      'GOOSE_PROVIDER: openrouter\nGOOSE_MODEL: anthropic/claude-sonnet-4.5\n',
    );
    await writeFile(resolve(operatorHome, '.config/goose/secrets.yaml'), 'OPENROUTER_API_KEY: k\n');

    const env = await prepareRoomAgentHome({ root: roomRoot, operatorHome });
    // `connect` may skip the provider and key questions for a Goose that
    // already holds a provider; the daemon has to answer with that same Goose.
    const config = resolve(env.GOOSE_PATH_ROOT!, 'config/config.yaml');
    expect(readFileSync(config, 'utf8')).toContain('GOOSE_PROVIDER: openrouter');
    expect(readFileSync(resolve(env.GOOSE_PATH_ROOT!, 'config/secrets.yaml'), 'utf8')).toContain(
      'OPENROUTER_API_KEY',
    );
    // A copy, never a link: Goose writes a session's model back into its own
    // config, and a Room must not rewrite the operator's default.
    expect(lstatSync(config).isSymbolicLink()).toBe(false);
    // Goose writes its sessions and logs beside that config, inside the Room.
    expect(harnessStateDirsFromEnv(env).stateDirs).toContain(env.GOOSE_PATH_ROOT);

    await rm(resolve(operatorHome, '.config/goose/config.yaml'));
    await prepareRoomAgentHome({ root: roomRoot, operatorHome });
    expect(existsSync(config)).toBe(false);
  });

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
      'CURSOR_HOME',
      'OPENCODE_CONFIG_DIR',
      'PI_CODING_AGENT_DIR',
      'XDG_CONFIG_HOME',
      'XDG_DATA_HOME',
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
    await mkdir(resolve(operatorHome, '.config/cursor'), { recursive: true });
    await mkdir(resolve(operatorHome, '.local/share/opencode'), { recursive: true });
    await writeFile(resolve(operatorHome, '.claude/.credentials.json'), '{"token":"claude"}');
    await writeFile(resolve(operatorHome, '.codex/auth.json'), '{"token":"codex"}');
    await writeFile(resolve(operatorHome, '.grok/auth.json'), '{"token":"grok"}');
    await writeFile(resolve(operatorHome, '.pi/agent/auth.json'), '{"token":"pi"}');
    await writeFile(resolve(operatorHome, '.config/cursor/auth.json'), '{"token":"cursor"}');
    await writeFile(
      resolve(operatorHome, '.local/share/opencode/auth.json'),
      '{"token":"opencode"}',
    );

    const roomA = resolve(await scratch('beeline-room-a-'), 'agent-home');
    const roomB = resolve(await scratch('beeline-room-b-'), 'agent-home');
    await prepareRoomAgentHome({ root: roomA, operatorHome });
    await prepareRoomAgentHome({ root: roomB, operatorHome });

    for (const root of [roomA, roomB]) {
      expect(await readFile(resolve(root, 'user/.local/share/opencode/auth.json'), 'utf8')).toBe(
        '{"token":"opencode"}',
      );
      const claude = resolve(root, 'claude/.credentials.json');
      const codex = resolve(root, 'codex/auth.json');
      const grok = resolve(root, 'grok/auth.json');
      const pi = resolve(root, 'pi/auth.json');
      const cursor = resolve(root, 'user/.config/cursor/auth.json');
      expect(readFileSync(claude, 'utf8')).toBe('{"token":"claude"}');
      expect(readFileSync(codex, 'utf8')).toBe('{"token":"codex"}');
      expect(readFileSync(grok, 'utf8')).toBe('{"token":"grok"}');
      expect(readFileSync(pi, 'utf8')).toBe('{"token":"pi"}');
      expect(readFileSync(cursor, 'utf8')).toBe('{"token":"cursor"}');
      // Symlinked, not copied: a refreshed token stays shared with every other
      // room-instance and with the operator's own CLI.
      expect(lstatSync(claude).isSymbolicLink()).toBe(true);
      expect(lstatSync(codex).isSymbolicLink()).toBe(true);
      expect(lstatSync(grok).isSymbolicLink()).toBe(true);
      expect(lstatSync(pi).isSymbolicLink()).toBe(true);
      expect(lstatSync(cursor).isSymbolicLink()).toBe(true);
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
    expect(JSON.parse(readFileSync(isolatedModels, 'utf8')).providers).toEqual([
      expect.objectContaining({ name: 'openrouter-ox', apiKey: 'inline-secret' }),
    ]);
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
    expect(JSON.parse(readFileSync(isolatedModels, 'utf8'))).toEqual({ providers: {} });
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
    await expect(prepareRoomAgentHome({ root, resourceAuthFile: '/tmp/resource-auth.json' })).rejects.toThrow();
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
      GOOSE_PATH_ROOT: '/rooms/room-a/agent-home/goose',
      GROK_HOME: '/rooms/room-a/agent-home/grok',
      CURSOR_HOME: '/rooms/room-a/agent-home/cursor',
      OPENCODE_CONFIG_DIR: '/rooms/room-a/agent-home/opencode',
      PI_CODING_AGENT_DIR: '/rooms/room-a/agent-home/pi',
      XDG_CONFIG_HOME: '/rooms/room-a/agent-home/user/.config',
      XDG_DATA_HOME: '/rooms/room-a/agent-home/user/.local/share',
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

  it('shares operator skills by default alongside the Beeline-owned managed skill', async () => {
    const operatorHome = await operatorHomeWithHarnessConfigs();
    const roomRoot = resolve(await scratch('beeline-room-a-'), 'agent-home');

    await prepareRoomAgentHome({
      root: roomRoot, grantedHostRoutes: ['project_tools'],
      operatorHome,
      agentKind: 'claude',
      isReviewer: true,
    });

    // Only the SELECTED harness's tree is materialized (C104); the other three
    // are the copies nobody was ever going to read.
    const skillsDir = resolve(roomRoot, 'claude', 'skills');
    expect(lstatSync(skillsDir).isSymbolicLink()).toBe(false);
    expect(lstatSync(skillsDir).isDirectory()).toBe(true);
    // Default share: every validated operator entry rides along.
    expect(readdirSync(skillsDir).sort()).toEqual(['greet', ...BEELINE_DEFAULT_SKILL_NAMES].sort());
    expect(readFileSync(resolve(skillsDir, 'greet', 'SKILL.md'), 'utf8')).toBe('say hi');
    const managedSkill = resolve(skillsDir, 'using-beeline', 'SKILL.md');
    expect(lstatSync(resolve(skillsDir, 'using-beeline')).isSymbolicLink()).toBe(false);
    expect(readFileSync(managedSkill, 'utf8')).toContain('name: using-beeline');
    const reviewSkill = readFileSync(resolve(skillsDir, 'beeline-review', 'SKILL.md'), 'utf8');
    expect(reviewSkill).toContain('PASS: call `approve_merge` with the reviewed head SHA');
    expect(reviewSkill).toContain('@author approved <reviewed sha>, merge');
    expect(reviewSkill).toContain(
      'Approving is your last step as reviewer. The author merges it; you never do, and nothing merges it automatically.',
    );
    expect(reviewSkill).not.toContain('Never merge');
    expect(reviewSkill).not.toContain('approved pending checks');
    expect(reviewSkill).not.toContain('unknown checks');
    expect(reviewSkill).not.toContain('--match-head-commit <reviewed sha>');
    expect(reviewSkill).toContain('P0 - OBJECTIVE FULFILLED, DEMONSTRATED');
    expect(reviewSkill).toContain('If the user-visible Y cannot be produced, FAIL now');
    const triageSkill = readFileSync(resolve(skillsDir, 'beeline-triage', 'SKILL.md'), 'utf8');
    expect(triageSkill).toContain('name: beeline-triage');
    expect(triageSkill).toContain(
      'Warnings inform the user and implementer; they do not block work.',
    );
    expect(triageSkill).toContain('## Bugfix execution');
    expect(triageSkill).toContain('Never condition the fix on reproduction');
    for (const dir of AGENT_SKILL_DIRS.filter((candidate) => candidate !== 'claude')) {
      expect(existsSync(resolve(roomRoot, dir, 'skills'))).toBe(false);
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
    // Native web search is enabled in the isolated codex home.
    expect(isolatedText).toContain('[features]\nstandalone_web_search = true');
    // Claude Code gets only its native web-read tools allowed through generated
    // settings. Filesystem and command tools are not admitted here.
    const claudeSettings = JSON.parse(
      readFileSync(resolve(roomRoot, 'claude', 'settings.json'), 'utf8'),
    ) as { permissions: { allow: string[] } };
    expect(claudeSettings.permissions.allow).toEqual(['WebSearch', 'WebFetch']);
    expect(claudeSettings.permissions.allow).not.toContain('Read');
    expect(claudeSettings.permissions.allow).not.toContain('Bash');
    // Host-classified declarations (Squire by name and by launch) stay out of
    // the isolated home entirely; local ones ride along byte-for-byte.
    expect(tomlChildTableNames(isolatedText, ['mcp_servers'])).toEqual([]);
    expect(parseToml(isolatedText).mcp_servers).toBeUndefined();
    expect(isolatedText).not.toContain('@trusty-squire/mcp');
    expect(isolatedText).not.toBe(`${operatorToml}\n`);
    expect(existsSync(resolve(roomRoot, '.trusty-squire'))).toBe(false);
    expect(existsSync(resolve(roomRoot, 'user/.trusty-squire'))).toBe(false);

    // Writing through the session cannot reach the operator's real config.
    await writeFile(isolatedConfig, '[mcp_servers.scribe]\ncommand = "scribe"\n');
    const operatorText = readFileSync(resolve(operatorHome, '.codex/config.toml'), 'utf8');
    expect(operatorText).toContain('@trusty-squire/mcp');
    expect(operatorText).not.toContain('scribe');
  });

  it('installs the review skill only for the configured reviewer, and retracts it when the flag moves', async () => {
    // An implementer that reads the review procedure mistakes the reviewer's
    // never-merge rule for its own, so a non-reviewer home must not carry it.
    const operatorHome = await scratch('beeline-operator-home-');
    await mkdir(resolve(operatorHome, '.agents/skills/greet'), { recursive: true });
    await writeFile(resolve(operatorHome, '.agents/skills/greet/SKILL.md'), 'say hi');
    const implementerRoot = resolve(await scratch('beeline-implementer-'), 'agent-home');
    const reviewerRoot = resolve(await scratch('beeline-reviewer-'), 'agent-home');

    await prepareRoomAgentHome({ root: implementerRoot, operatorHome, agentKind: 'claude' });
    expect(readdirSync(resolve(implementerRoot, 'claude', 'skills')).sort()).toEqual(
      ['greet', 'draw-avatar', BEELINE_SPEC_SKILL_NAME, BEELINE_TRIAGE_SKILL_NAME, USING_BEELINE_SKILL_NAME].sort(),
    );

    await prepareRoomAgentHome({
      root: reviewerRoot,
      operatorHome,
      agentKind: 'claude',
      isReviewer: true,
    });
    expect(readdirSync(resolve(reviewerRoot, 'claude', 'skills')).sort()).toEqual(
      [
        BEELINE_REVIEW_SKILL_NAME,
        BEELINE_SPEC_SKILL_NAME,
        BEELINE_TRIAGE_SKILL_NAME,
        'draw-avatar',
        'greet',
        USING_BEELINE_SKILL_NAME,
      ].sort(),
    );

    // Provisioning is deletion too: the same home losing its reviewer role
    // loses the skill on the next activation, never keeping a stale copy.
    await prepareRoomAgentHome({ root: reviewerRoot, operatorHome, agentKind: 'claude' });
    expect(readdirSync(resolve(reviewerRoot, 'claude', 'skills')).sort()).not.toContain(
      BEELINE_REVIEW_SKILL_NAME,
    );
  });

  it('reports malformed ambient skills as concise skipped-entry lines', async () => {
    const operatorHome = await scratch('beeline-operator-home-');
    const skillsRoot = resolve(operatorHome, '.claude/skills');
    const danglingOne = resolve(skillsRoot, 'dangling-one');
    const danglingTwo = resolve(skillsRoot, 'dangling-two');
    const skillless = resolve(skillsRoot, 'skillless');
    await mkdir(skillsRoot, { recursive: true });
    await symlink(resolve(skillsRoot, 'gone-one'), danglingOne);
    await symlink(resolve(skillsRoot, 'gone-two'), danglingTwo);
    await mkdir(skillless);
    const roomRoot = resolve(await scratch('beeline-room-a-'), 'agent-home');
    const warnings: string[] = [];
    const warn = vi.spyOn(console, 'warn').mockImplementation((...parts: unknown[]) => {
      warnings.push(parts.map(String).join(' '));
    });

    try {
      await prepareRoomAgentHome({ root: roomRoot, operatorHome, agentKind: 'claude' });
    } finally {
      warn.mockRestore();
    }

    expect(warnings).toEqual(
      expect.arrayContaining([
        `[body] skipping operator skill ${danglingOne}: dangling symlink`,
        `[body] skipping operator skill ${danglingTwo}: dangling symlink`,
        `[body] skipping operator skill ${skillless}: missing SKILL.md`,
        '[body] 2 skill entries skipped: dangling symlink',
      ]),
    );
    expect(warnings).toHaveLength(4);
    expect(warnings.every((line) => !line.includes('\n'))).toBe(true);
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

    await prepareRoomAgentHome({
      root: sharedAgent,
      operatorHome,
      sharedSkills: ['review-pr'],
      agentKind: 'pi',
      isReviewer: true,
    });
    await prepareRoomAgentHome({ root: cleanAgent, operatorHome, agentKind: 'pi' });

    expect(readdirSync(resolve(sharedAgent, 'pi', 'skills')).sort()).toEqual(
      [...BEELINE_DEFAULT_SKILL_NAMES, 'review-pr'].sort(),
    );
    expect(lstatSync(resolve(sharedAgent, 'pi', 'skills/review-pr')).isSymbolicLink()).toBe(false);
    expect(lstatSync(resolve(sharedAgent, 'pi', 'skills/review-pr/run.sh')).mode & 0o111).toBe(0);
    // A default-share agent gets every operator entry, review-pr included.
    expect(existsSync(resolve(cleanAgent, 'pi', 'skills/review-pr'))).toBe(true);
    // Explicit narrowing excludes the operator's other skills.
    expect(readdirSync(resolve(sharedAgent, 'pi', 'skills')).sort()).not.toContain('greet');
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
    await prepareRoomAgentHome({ root: roomRoot, grantedHostRoutes: ['files', 'tools'], operatorHome });

    const claudeJson = resolve(roomRoot, 'claude', '.claude.json');
    expect(lstatSync(claudeJson).isSymbolicLink()).toBe(false);
    const claudeParsed = JSON.parse(readFileSync(claudeJson, 'utf8')) as {
      mcpServers: Record<string, unknown>;
    };
    expect(Object.keys(claudeParsed.mcpServers)).toEqual(['files']);
    expect(claudeParsed.mcpServers.files).toMatchObject({ command: 'files-mcp' });
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

    await prepareRoomAgentHome({ root: roomRoot, grantedHostRoutes: ['one', 'two'], operatorHome });
    expect(existsSync(resolve(roomRoot, 'claude', '.claude.json'))).toBe(true);
    await writeFile(
      resolve(operatorHome, '.codex/config.toml'),
      '[mcp_servers.one]\ncommand = "one"\n[mcp_servers.two]\ncommand = "two"\n',
    );
    await prepareRoomAgentHome({ root: roomRoot, grantedHostRoutes: ['one', 'two'], operatorHome });

    const regenerated = readFileSync(resolve(roomRoot, 'codex', 'config.toml'), 'utf8');
    expect(regenerated).toContain('[mcp_servers.two]');

    await writeFile(resolve(operatorHome, '.codex/config.toml'), 'model = "gpt-5-codex"\n');
    await writeFile(resolve(operatorHome, '.claude.json'), JSON.stringify({ mcpServers: {} }));
    await prepareRoomAgentHome({ root: roomRoot, grantedHostRoutes: ['one', 'two'], operatorHome });
    expect(readFileSync(resolve(roomRoot, 'codex', 'config.toml'), 'utf8')).toBe(
      '[agents]\nenabled = false\n\n[features]\nstandalone_web_search = true\n',
    );
    expect(existsSync(resolve(roomRoot, 'claude', '.claude.json'))).toBe(false);
  });

  it('replaces a session-authored config symlink instead of writing through it', async () => {
    const operatorHome = await operatorHomeWithHarnessConfigs();
    const roomRoot = resolve(await scratch('beeline-room-a-'), 'agent-home');
    const redirected = resolve(await scratch('beeline-redirected-'), 'config.toml');
    await writeFile(redirected, 'must stay unchanged\n');
    await prepareRoomAgentHome({ root: roomRoot, grantedHostRoutes: ['project_tools'], operatorHome });
    await rm(resolve(roomRoot, 'codex', 'config.toml'));
    await symlink(redirected, resolve(roomRoot, 'codex', 'config.toml'));

    await prepareRoomAgentHome({ root: roomRoot, grantedHostRoutes: ['project_tools'], operatorHome });

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
    // No operator skills to link, but the managed skill is still shipped —
    // into the selected harness's tree, and only that one.
    expect(existsSync(resolve(roomRoot, 'codex', 'skills', 'using-beeline', 'SKILL.md'))).toBe(
      true,
    );
    for (const dir of AGENT_SKILL_DIRS.filter((candidate) => candidate !== 'codex')) {
      expect(existsSync(resolve(roomRoot, dir, 'skills'))).toBe(false);
    }
    // Codex's collaboration tools default on, so its isolated config is
    // intentionally present even without operator configuration. Other
    // harnesses still have no config to generate.
    expect(readFileSync(resolve(roomRoot, 'codex', 'config.toml'), 'utf8')).toBe(
      '[agents]\nenabled = false\n\n[features]\nstandalone_web_search = true\n',
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
    // The default skill share crosses skills dirs but never a credential store.
    expect(existsSync(resolve(roomRoot, 'codex/skills/audit'))).toBe(true);
    for (const link of links) {
      const target = realpathSync(link);
      for (const masked of KNOWN_CREDENTIAL_MASK_PATHS) {
        const maskedPath = resolve(operatorHome, masked.replace(/\/+$/, ''));
        expect(target === maskedPath || target.startsWith(`${maskedPath}/`)).toBe(false);
      }
    }
  });
});

describe('mounted imported MCP server names', () => {
  it('lists every imported server the operator currently has, not only Squire', async () => {
    const operatorHome = await scratch('beeline-mounted-mcp-operator-');
    await mkdir(resolve(operatorHome, '.codex'), { recursive: true });
    await mkdir(resolve(operatorHome, '.grok'), { recursive: true });
    await mkdir(resolve(operatorHome, '.config/goose'), { recursive: true });
    await writeFile(
      resolve(operatorHome, '.codex/config.toml'),
      [
        '[mcp_servers.files]',
        'command = "files-mcp"',
        '',
        '[mcp_servers.squire]',
        'command = "npx"',
        'args = ["-y", "@trusty-squire/mcp"]',
      ].join('\n'),
    );
    await writeFile(
      resolve(operatorHome, '.grok/config.toml'),
      ['[mcp_servers.linear]', 'command = "linear-mcp"'].join('\n'),
    );
    await writeFile(
      resolve(operatorHome, '.claude.json'),
      JSON.stringify({
        mcpServers: {
          typescript: { command: 'typescript-mcp' },
          vault: { command: 'npx', args: ['-y', '@trusty-squire/mcp'] },
        },
      }),
    );
    await writeFile(
      resolve(operatorHome, '.config/goose/config.yaml'),
      ['extensions:', '  filesystem:', '    cmd: filesystem-mcp', '  squire:', '    cmd: npx'].join(
        '\n',
      ),
    );

    expect(mountedImportedMcpServerNames({ operatorHome })).toEqual([]);
    expect(hostImportedMcpServerNames({ operatorHome })).toEqual(['files', 'filesystem', 'linear', 'squire', 'typescript', 'vault']);
  });

  it.each(['codex', 'grok'] as const)(
    'tracks every preserved TOML server declaration for %s',
    async (agentKind) => {
      const operatorHome = await scratch('beeline-toml-inventory-op-');
      const agentHomeRoot = resolve(await scratch('beeline-toml-inventory-home-'), 'agent-home');
      await mkdir(resolve(operatorHome, `.${agentKind}`), { recursive: true });
      const sourcePath = resolve(operatorHome, `.${agentKind}/config.toml`);
      const input = { operatorHome, agentKind };
      for (const source of [
        '[mcp_servers]\nfiles = { command = "files-mcp", args = ["--stdio"] }\n',
        '[mcp_servers]\n"files".command = "files-mcp"\n',
        "[mcp_servers.'files']\ncommand = 'files-mcp'\n",
        '[mcp_servers.files.env]\nMODE = "read"\n[mcp_servers.files]\ncommand = "files-mcp"\n',
      ]) {
        await writeFile(sourcePath, source);
        const preparedEnv = await prepareRoomAgentHome({
          root: agentHomeRoot,
      grantedHostRoutes: ['files', 'context7', 'typescript'],
          operatorHome,
          agentKind,
        });
        expect(mountedImportedMcpServerNames(input)).toEqual([]);
        expect(mountedImportedMcpServerNames({ ...input, preparedEnv })).toEqual(['files']);
        await writeFile(sourcePath, '');
        expect(mountedImportedMcpServerNames(input)).toEqual([]);
        await prepareRoomAgentHome({ root: agentHomeRoot, operatorHome, agentKind });
        expect(mountedImportedMcpServerNames({ ...input, preparedEnv })).toEqual([]);
      }
    },
  );

  it.each([
    'extensions:\n    files:\n        cmd: files-mcp\n    squire:\n        cmd: squire-mcp\n',
    'extensions:\n  "files": {cmd: files-mcp}\n  \'squire\': {cmd: squire-mcp}\n',
    'extensions: {files: {cmd: files-mcp}, squire: {cmd: squire-mcp}}\n',
  ])('tracks the Goose inventory copied by preparation: %s', async (source) => {
    const operatorHome = await scratch('beeline-goose-inventory-op-');
    const agentHomeRoot = resolve(await scratch('beeline-goose-inventory-home-'), 'agent-home');
    const sourcePath = resolve(operatorHome, '.config/goose/config.yaml');
    await mkdir(resolve(operatorHome, '.config/goose'), { recursive: true });
    await writeFile(sourcePath, source);
    const input = { operatorHome, agentKind: 'goose' as const };
    const preparedEnv = await prepareRoomAgentHome({
      root: agentHomeRoot,
      grantedHostRoutes: ['files', 'context7', 'typescript'],
      operatorHome,
      agentKind: 'goose',
    });
    expect(mountedImportedMcpServerNames(input)).toEqual([]);
    expect(mountedImportedMcpServerNames({ ...input, preparedEnv })).toEqual(['files']);
    expect(hostImportedMcpServerNames(input)).toEqual(['files','squire']);
    const isolatedGoose = readFileSync(
      resolve(preparedEnv.GOOSE_PATH_ROOT!, 'config/config.yaml'),
      'utf8',
    );
    expect(isolatedGoose).not.toBe(source);
    const extensions = (
      parseYaml(isolatedGoose) as {
        extensions: Record<string, { cmd?: string; envs?: Record<string, string> }>;
      }
    ).extensions;
    expect(extensions.files.cmd).toBe('files-mcp');
    expect(extensions.squire).toBeUndefined();
    await writeFile(sourcePath, 'extensions: {}\n');
    expect(mountedImportedMcpServerNames(input)).toEqual([]);
    expect(mountedImportedMcpServerNames({ ...input, preparedEnv })).toEqual(['files']);
    await prepareRoomAgentHome({ root: agentHomeRoot, operatorHome, agentKind: 'goose' });
    expect(mountedImportedMcpServerNames({ ...input, preparedEnv })).toEqual([]);
    await rm(sourcePath);
    expect(mountedImportedMcpServerNames(input)).toEqual([]);
  });

  it('keeps inline-declared local servers when the bare table also holds a host one', async () => {
    const operatorHome = await scratch('beeline-inline-local-op-');
    const agentHomeRoot = resolve(await scratch('beeline-inline-local-home-'), 'agent-home');
    await mkdir(resolve(operatorHome, '.codex'), { recursive: true });
    const sourcePath = resolve(operatorHome, '.codex/config.toml');
    const inlineDeclarations = [
      '[mcp_servers]',
      'squire = { command = "npx", args = ["-y", "@trusty-squire/mcp@latest", "server"] }',
      'context7 = { command = "npx", args = ["-y", "@upstash/context7-mcp"] }',
    ];
    await writeFile(
      sourcePath,
      [...inlineDeclarations, '', '[mcp_servers.files]', 'command = "files-mcp"'].join('\n'),
    );
    const input = { operatorHome, agentKind: 'codex' as const };
    const preparedEnv = await prepareRoomAgentHome({
      root: agentHomeRoot,
      grantedHostRoutes: ['files', 'context7', 'typescript'],
      operatorHome,
      agentKind: 'codex',
    });
    const isolatedText = readFileSync(resolve(preparedEnv.CODEX_HOME!, 'config.toml'), 'utf8');
    const isolated = parseToml(isolatedText) as {
      mcp_servers: Record<string, { command?: string; args?: string[] }>;
    };
    expect(Object.keys(isolated.mcp_servers).sort()).toEqual(['context7', 'files']);
    expect(isolated.mcp_servers.context7.args).toEqual(['-y', '@upstash/context7-mcp']);
    expect(isolated.mcp_servers.files.command).toBe('files-mcp');
    expect(isolatedText).not.toContain('@trusty-squire/mcp');
    expect(mountedImportedMcpServerNames(input)).toEqual([]);
    expect(mountedImportedMcpServerNames({ ...input, preparedEnv })).toEqual(['context7', 'files']);

    await writeFile(sourcePath, inlineDeclarations.join('\n'));
    const inlineOnlyEnv = await prepareRoomAgentHome({
      root: agentHomeRoot,
      grantedHostRoutes: ['files', 'context7', 'typescript'],
      operatorHome,
      agentKind: 'codex',
    });
    expect(mountedImportedMcpServerNames(input)).toEqual([]);
    expect(mountedImportedMcpServerNames({ ...input, preparedEnv: inlineOnlyEnv })).toEqual([
      'context7',
    ]);
  });

  it('keeps an inline-declared host server out of the isolated config', async () => {
    const operatorHome = await scratch('beeline-inline-host-op-');
    const agentHomeRoot = resolve(await scratch('beeline-inline-host-home-'), 'agent-home');
    await mkdir(resolve(operatorHome, '.codex'), { recursive: true });
    await writeFile(
      resolve(operatorHome, '.codex/config.toml'),
      [
        '[mcp_servers]',
        'squire = { command = "npx", args = ["-y", "@trusty-squire/mcp@latest", "server"] }',
        `browser = { command = "browser-mcp", ${MCP_ROUTE_CLASS_KEY} = "${MCP_ROUTE_HOST}" }`,
        '',
        '[mcp_servers.files]',
        'command = "files-mcp"',
      ].join('\n'),
    );
    const preparedEnv = await prepareRoomAgentHome({
      root: agentHomeRoot,
      grantedHostRoutes: ['files', 'context7', 'typescript'],
      operatorHome,
      agentKind: 'codex',
    });
    const isolatedText = readFileSync(resolve(preparedEnv.CODEX_HOME!, 'config.toml'), 'utf8');
    const isolated = parseToml(isolatedText) as {
      mcp_servers: Record<string, { command?: string }>;
    };
    expect(Object.keys(isolated.mcp_servers)).toEqual(['files']);
    expect(isolated.mcp_servers.files.command).toBe('files-mcp');
    expect(isolatedText).not.toContain('@trusty-squire/mcp');
    expect(isolatedText).not.toContain('browser-mcp');
    expect(hostImportedMcpServerNames({ operatorHome, agentKind: 'codex' })).toEqual([
      'browser',
      'files',
      'squire',
    ]);
    expect(
      mountedImportedMcpServerNames({ operatorHome, agentKind: 'codex', preparedEnv }),
    ).toEqual(['files']);
  });

  it('keeps an operator-marked host server out of the isolated config', async () => {
    const operatorHome = await scratch('beeline-marked-host-op-');
    const agentHomeRoot = resolve(await scratch('beeline-marked-host-home-'), 'agent-home');
    await mkdir(resolve(operatorHome, '.codex'), { recursive: true });
    await writeFile(
      resolve(operatorHome, '.codex/config.toml'),
      [
        `[mcp_servers.browser]`,
        `command = "browser-mcp"`,
        `${MCP_ROUTE_CLASS_KEY} = "${MCP_ROUTE_HOST}"`,
        '',
        '[mcp_servers.files]',
        'command = "files-mcp"',
      ].join('\n'),
    );
    const preparedEnv = await prepareRoomAgentHome({
      root: agentHomeRoot,
      grantedHostRoutes: ['files', 'context7', 'typescript'],
      operatorHome,
      agentKind: 'codex',
    });
    const isolatedText = readFileSync(resolve(preparedEnv.CODEX_HOME!, 'config.toml'), 'utf8');
    const isolated = parseToml(isolatedText) as {
      mcp_servers: Record<string, { command?: string; env?: Record<string, string> }>;
    };
    expect(isolated.mcp_servers.files).toMatchObject({ command: 'files-mcp' });
    expect(isolated.mcp_servers.browser).toBeUndefined();
    expect(isolatedText).not.toContain('browser-mcp');
    expect(hostImportedMcpServerNames({ operatorHome, agentKind: 'codex' })).toEqual(['browser','files']);
    expect(mountedImportedMcpServerNames({ operatorHome, agentKind: 'codex' })).toEqual([]);
    expect(
      mountedImportedMcpServerNames({ operatorHome, agentKind: 'codex', preparedEnv }),
    ).toEqual(['files']);
  });

  it('reads only the selected harness inventory after preparation', async () => {
    const operatorHome = await scratch('beeline-mounted-mcp-prepared-op-');
    const agentHomeRoot = resolve(
      await scratch('beeline-mounted-mcp-prepared-home-'),
      'agent-home',
    );
    await mkdir(resolve(operatorHome, '.codex'), { recursive: true });
    await writeFile(
      resolve(operatorHome, '.codex/config.toml'),
      '[mcp_servers.files]\ncommand = "files-mcp"\n',
    );
    await writeFile(
      resolve(operatorHome, '.claude.json'),
      JSON.stringify({
        mcpServers: { typescript: { command: 'typescript-mcp' } },
      }),
    );
    const preparedEnv = await prepareRoomAgentHome({ root: agentHomeRoot, operatorHome, grantedHostRoutes: ['files','typescript'] });
    expect(mountedImportedMcpServerNames({ agentKind: 'codex', preparedEnv })).toEqual(['files']);
    expect(mountedImportedMcpServerNames({ agentKind: 'claude', preparedEnv })).toEqual([
      'typescript',
    ]);
    await writeFile(
      resolve(preparedEnv.CODEX_HOME!, 'config.toml'),
      '[mcp_servers.squire]\nurl = "http://localhost:1234/mcp"\n',
    );
    expect(mountedImportedMcpServerNames({ agentKind: 'codex', preparedEnv })).toEqual(['squire']);
    await prepareRoomAgentHome({ root: agentHomeRoot, operatorHome, grantedHostRoutes: ['files','typescript'] });
    expect(mountedImportedMcpServerNames({ agentKind: 'codex', preparedEnv })).toEqual(['files']);
  });

  it('does not infer grants from isolated declarations preparation replaces', async () => {
    const operatorHome = await scratch('beeline-mounted-mcp-grant-op-');
    const agentHomeRoot = resolve(await scratch('beeline-mounted-mcp-grant-home-'), 'agent-home');
    const input = { operatorHome, agentKind: 'codex' as const };
    const preparedEnv = await prepareRoomAgentHome({ root: agentHomeRoot, ...input });
    await writeFile(
      resolve(preparedEnv.CODEX_HOME!, 'config.toml'),
      '[mcp_servers.squire]\ncommand = "squire-mcp"\n',
    );
    expect(mountedImportedMcpServerNames(input)).toEqual([]);
    await prepareRoomAgentHome({ root: agentHomeRoot, ...input });
    expect(mountedImportedMcpServerNames({ ...input, preparedEnv })).toEqual([]);
  });

  it('rewrites a granted host route into the isolated home and drops it when revoked', async () => {
    const operatorHome = await scratch('beeline-granted-host-op-');
    const agentHomeRoot = resolve(await scratch('beeline-granted-host-home-'), 'agent-home');
    await mkdir(resolve(operatorHome, '.codex'), { recursive: true });
    await writeFile(
      resolve(operatorHome, '.codex/config.toml'),
      [
        '[mcp_servers.files]',
        'command = "files-mcp"',
        '[mcp_servers.squire]',
        'command = "npx"',
        'args = ["-y", "@trusty-squire/mcp@latest", "server"]',
      ].join('\n'),
    );
    const input = { operatorHome, agentKind: 'codex' as const };
    const preparedEnv = await prepareRoomAgentHome({
      root: agentHomeRoot,
      ...input,
      grantedHostRoutes: ['files', 'squire'],
    });
    const isolated = readFileSync(resolve(preparedEnv.CODEX_HOME!, 'config.toml'), 'utf8');
    expect(isolated).toContain('files-mcp');
    expect(isolated).toContain('TRUSTY_SQUIRE_BROKER_SOCKET');
    expect(isolated).toContain('squire-facade');
    expect(isolated).not.toContain('@trusty-squire/mcp@latest');
    expect(mountedImportedMcpServerNames({ ...input, preparedEnv })).toEqual(['files', 'squire']);
    expect(
      expectedMountedImportedMcpServerNames({ ...input, grantedHostRoutes: ['files', 'squire'] }),
    ).toEqual(['files', 'squire']);

    await prepareRoomAgentHome({ root: agentHomeRoot, ...input });
    expect(mountedImportedMcpServerNames({ ...input, preparedEnv })).toEqual([]);
    expect(expectedMountedImportedMcpServerNames(input)).toEqual([]);
  });

  it('rewrites a standing mcp grant into the isolated pi mcp.json', async () => {
    // Candy's shape: kind=mcp target=squire status=approved, expires_at null.
    // Operator pi keeps MCP in ~/.pi/agent/mcp.json (here named
    // trusty-squire). Isolated homes write local copies and the granted
    // squire route into $PI_CODING_AGENT_DIR/mcp.json like the other
    // harnesses — not a pi-only standing-grant special case.
    const operatorHome = await scratch('beeline-pi-mcp-op-');
    const agentHomeRoot = resolve(await scratch('beeline-pi-mcp-home-'), 'agent-home');
    await mkdir(resolve(operatorHome, '.pi/agent'), { recursive: true });
    await writeFile(
      resolve(operatorHome, '.pi/agent/mcp.json'),
      JSON.stringify({
        mcpServers: {
          files: { command: 'files-mcp' },
          'trusty-squire': {
            command: 'npx',
            args: ['-y', '@trusty-squire/mcp@next'],
          },
        },
      }),
    );
    const input = { operatorHome, agentKind: 'pi' as const };
    expect(mountedImportedMcpServerNames(input)).toEqual([]);
    expect(hostImportedMcpServerNames(input)).toEqual(['files','trusty-squire']);
    expect(
      expectedMountedImportedMcpServerNames({ ...input, grantedHostRoutes: ['files', 'squire'] }),
    ).toEqual(['files', 'squire']);

    const preparedEnv = await prepareRoomAgentHome({
      root: agentHomeRoot,
      ...input,
      grantedHostRoutes: ['files', 'squire'],
    });
    const isolated = JSON.parse(
      readFileSync(resolve(preparedEnv.PI_CODING_AGENT_DIR!, 'mcp.json'), 'utf8'),
    ) as { mcpServers: Record<string, { command?: string; args?: string[] }> };
    expect(Object.keys(isolated.mcpServers)).toEqual(['files', 'squire']);
    expect(isolated.mcpServers.files).toMatchObject({ command: 'files-mcp' });
    expect(isolated.mcpServers.squire?.args).toEqual(
      expect.arrayContaining([expect.stringMatching(/squire-facade/)]),
    );
    expect(JSON.stringify(isolated)).not.toContain('@trusty-squire/mcp@next');
    expect(mountedImportedMcpServerNames({ ...input, preparedEnv })).toEqual(['files', 'squire']);

    await prepareRoomAgentHome({ root: agentHomeRoot, ...input });
    expect(mountedImportedMcpServerNames({ ...input, preparedEnv })).toEqual([]);
    expect(expectedMountedImportedMcpServerNames(input)).toEqual([]);
  });

  it('keeps a standing mcp grant on a pi home after a restart', () => {
    // Grant target is the code-owned name `squire`, even when the operator
    // file used another key or this harness has no declaration yet.
    const operatorHome = '/no-such-pi-operator-home';
    expect(
      expectedMountedImportedMcpServerNames({
        operatorHome,
        agentKind: 'pi',
        grantedHostRoutes: ['files', 'squire'],
      }),
    ).toEqual(['squire']);
    expect(
      expectedMountedImportedMcpServerNames({
        operatorHome,
        agentKind: 'pi',
        grantedHostRoutes: ['files', 'squire'],
      }),
    ).toEqual(['squire']);
  });

  it('does not treat a stale copied local server as still mounted after the operator removes it', async () => {
    const operatorHome = await scratch('beeline-mounted-mcp-stale-op-');
    const agentHomeRoot = resolve(await scratch('beeline-mounted-mcp-stale-home-'), 'agent-home');
    await mkdir(resolve(agentHomeRoot, 'codex'), { recursive: true });
    await writeFile(
      resolve(agentHomeRoot, 'codex/config.toml'),
      ['[mcp_servers.files]', 'command = "files-mcp"'].join('\n'),
    );

    expect(mountedImportedMcpServerNames({ operatorHome, agentKind: 'codex' })).toEqual([]);
  });
});

describe('skill provision reuse', () => {
  /**
   * Provision twice and report whether the second call rebuilt the tree. The
   * inode of the skills directory is the honest witness: a rebuild stages a
   * fresh directory and renames it into place, so reuse is exactly the case
   * where the directory the harness reads is still the same directory.
   */
  async function provisionTwice(
    input: Parameters<typeof prepareRoomAgentHome>[0],
    between?: () => Promise<void>,
  ): Promise<{ rebuilt: boolean; skills: string }> {
    const skills = resolve(input.root, agentSkillDir(input.agentKind), 'skills');
    await prepareRoomAgentHome(input);
    const before = lstatSync(skills).ino;
    await between?.();
    await prepareRoomAgentHome(input);
    return { rebuilt: lstatSync(skills).ino !== before, skills };
  }

  async function operatorWithSkill(content: string): Promise<string> {
    const operatorHome = await scratch('beeline-reuse-operator-');
    await mkdir(resolve(operatorHome, '.agents/skills/greet'), { recursive: true });
    await writeFile(resolve(operatorHome, '.agents/skills/greet/SKILL.md'), content);
    return operatorHome;
  }

  it('reuses a provision whose every byte still matches the plan', async () => {
    const operatorHome = await operatorWithSkill('say hi');
    const root = resolve(await scratch('beeline-reuse-'), 'agent-home');

    const { rebuilt, skills } = await provisionTwice({
      root,
      operatorHome,
      agentKind: 'claude',
      skillReleaseId: 'release-1',
    });

    expect(rebuilt).toBe(false);
    expect(readFileSync(resolve(skills, 'greet', 'SKILL.md'), 'utf8')).toBe('say hi');
  });

  it('rebuilds when the operator edits, adds or deletes a source skill', async () => {
    const edited = await operatorWithSkill('say hi');
    const editedRoot = resolve(await scratch('beeline-reuse-edit-'), 'agent-home');
    // Same length, same mtime: only the CONTENT moved, which is the case a
    // stat-based reuse test would wave through.
    const skillMd = resolve(edited, '.agents/skills/greet/SKILL.md');
    const stamp = new Date(1_700_000_000_000);
    await utimes(skillMd, stamp, stamp);
    expect(
      (
        await provisionTwice(
          { root: editedRoot, operatorHome: edited, agentKind: 'claude' },
          async () => {
            await writeFile(skillMd, 'say HI');
            await utimes(skillMd, stamp, stamp);
          },
        )
      ).rebuilt,
    ).toBe(true);
    expect(readFileSync(resolve(editedRoot, 'claude', 'skills', 'greet', 'SKILL.md'), 'utf8')).toBe(
      'say HI',
    );

    const added = await operatorWithSkill('say hi');
    const addedRoot = resolve(await scratch('beeline-reuse-add-'), 'agent-home');
    expect(
      (
        await provisionTwice(
          { root: addedRoot, operatorHome: added, agentKind: 'claude' },
          async () => {
            await mkdir(resolve(added, '.agents/skills/audit'), { recursive: true });
            await writeFile(resolve(added, '.agents/skills/audit/SKILL.md'), 'audit');
          },
        )
      ).rebuilt,
    ).toBe(true);
    expect(readdirSync(resolve(addedRoot, 'claude', 'skills')).sort()).toContain('audit');

    const deleted = await operatorWithSkill('say hi');
    const deletedRoot = resolve(await scratch('beeline-reuse-delete-'), 'agent-home');
    expect(
      (
        await provisionTwice(
          {
            root: deletedRoot,
            operatorHome: deleted,
            agentKind: 'claude',
            isReviewer: true,
          },
          () => rm(resolve(deleted, '.agents/skills/greet'), { recursive: true }),
        )
      ).rebuilt,
    ).toBe(true);
    expect(readdirSync(resolve(deletedRoot, 'claude', 'skills')).sort()).toEqual([
      ...BEELINE_DEFAULT_SKILL_NAMES,
    ]);
  });

  it('rebuilds when the release stamped into the managed skill moves', async () => {
    const operatorHome = await operatorWithSkill('say hi');
    const root = resolve(await scratch('beeline-reuse-release-'), 'agent-home');
    await prepareRoomAgentHome({ root, operatorHome, agentKind: 'claude', skillReleaseId: 'r1' });
    const before = lstatSync(resolve(root, 'claude', 'skills')).ino;
    await prepareRoomAgentHome({ root, operatorHome, agentKind: 'claude', skillReleaseId: 'r2' });
    expect(lstatSync(resolve(root, 'claude', 'skills')).ino).not.toBe(before);
    expect(
      readFileSync(resolve(root, 'claude', 'skills', 'using-beeline', 'SKILL.md'), 'utf8'),
    ).toContain('r2');
  });

  it('never reuses a destination the session could have changed underneath it', async () => {
    const operatorHome = await operatorWithSkill('say hi');
    const cases: Array<{ what: string; tamper: (skills: string) => Promise<void> }> = [
      {
        what: 'an edited file',
        tamper: (skills) => writeFile(resolve(skills, 'greet/SKILL.md'), 'own words'),
      },
      {
        what: 'an added file',
        tamper: (skills) => writeFile(resolve(skills, 'greet/extra.md'), 'extra'),
      },
      { what: 'a deleted file', tamper: (skills) => rm(resolve(skills, 'greet/SKILL.md')) },
      {
        what: 'a symlink standing in for a file',
        tamper: async (skills) => {
          const outside = await scratch('beeline-reuse-outside-');
          await writeFile(resolve(outside, 'SKILL.md'), 'say hi');
          await rm(resolve(skills, 'greet/SKILL.md'));
          await symlink(resolve(outside, 'SKILL.md'), resolve(skills, 'greet/SKILL.md'));
        },
      },
      {
        // Same bytes, but a second name for the same inode: the session keeps a
        // mutable handle on what the harness reads, so it is not reusable even
        // though every hash matches.
        what: 'a hardlink to the same bytes',
        tamper: async (skills) => {
          const outside = await scratch('beeline-reuse-hardlink-');
          const shared = resolve(outside, 'SKILL.md');
          await writeFile(shared, 'say hi');
          await rm(resolve(skills, 'greet/SKILL.md'));
          await link(shared, resolve(skills, 'greet/SKILL.md'));
        },
      },
    ];

    for (const { what, tamper } of cases) {
      const root = resolve(await scratch('beeline-reuse-tamper-'), 'agent-home');
      const { rebuilt, skills } = await provisionTwice(
        { root, operatorHome, agentKind: 'claude' },
        () => tamper(resolve(root, 'claude', 'skills')),
      );
      expect(rebuilt, what).toBe(true);
      const restored = resolve(skills, 'greet', 'SKILL.md');
      expect(lstatSync(restored).isSymbolicLink(), what).toBe(false);
      expect(lstatSync(restored).nlink, what).toBe(1);
      expect(readFileSync(restored, 'utf8'), what).toBe('say hi');
      expect(readdirSync(resolve(skills, 'greet')), what).toEqual(['SKILL.md']);
    }
  });

  it('provisions the newly selected harness when the agent switches harness', async () => {
    const operatorHome = await operatorWithSkill('say hi');
    const root = resolve(await scratch('beeline-reuse-harness-'), 'agent-home');

    await prepareRoomAgentHome({ root, operatorHome, agentKind: 'claude' });
    expect(existsSync(resolve(root, 'pi', 'skills'))).toBe(false);

    await prepareRoomAgentHome({ root, operatorHome, agentKind: 'pi' });
    expect(readFileSync(resolve(root, 'pi', 'skills', 'greet', 'SKILL.md'), 'utf8')).toBe('say hi');
  });

  it('delivers release-managed guidance to newly paired homes across every agent kind', async () => {
    const operatorHome = await operatorWithSkill('say hi');
    for (const agentKind of AGENT_KINDS) {
      const root = resolve(await scratch(`beeline-spec-${agentKind}-`), 'agent-home');
      await prepareRoomAgentHome({ root, operatorHome, agentKind, isReviewer: true });
      const skills = resolve(root, agentSkillDir(agentKind), 'skills');
      const spec = readFileSync(resolve(skills, 'beeline-spec', 'SKILL.md'), 'utf8');
      const review = readFileSync(resolve(skills, 'beeline-review', 'SKILL.md'), 'utf8');
      expect(spec).toContain('name: beeline-spec');
      expect(spec).toContain('Ask one focused question only when an unresolved choice materially changes the result.');
      expect(review).toContain('Read the server-assigned brief and its current revision');
      expect(review).toContain('Build one visible validation record for the brief revision and code head.');
    }
  });
});
