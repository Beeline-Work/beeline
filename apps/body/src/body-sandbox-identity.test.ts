/**
 * Hermetic unit tests for body modules.
 * These tests do NOT require a relay or LLM endpoint.
 */
import { afterAll, afterEach, describe, it, expect, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { hasWriteTools, inventoryForMcpServers } from './mcp-inventory.js';
import { parseEnvFile, hasLlmCredentials, type BodyConfig } from './config.js';
import { prepareCornerAgentPrivateState } from './agent-private-state.js';
import { mediaUploadResponse, relayQueryResponse } from './relay-test-helper.js';

const mocks = vi.hoisted(() => ({
  createBuzzClient: vi.fn(),
  realCreateBuzzClient:
    undefined as unknown as typeof import('@beeline/buzz-client').createBuzzClient,
}));

// Most tests here rely on the real createBuzzClient (talking to a stubbed
// global fetch/WS). Default the spy to delegate to it so only tests that
// explicitly override the return value change its behavior.
vi.mock('@beeline/buzz-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@beeline/buzz-client')>();
  mocks.realCreateBuzzClient = actual.createBuzzClient;
  mocks.createBuzzClient.mockImplementation(actual.createBuzzClient);
  return { ...actual, createBuzzClient: mocks.createBuzzClient };
});

import {
  AGENT_EXCHANGE_MAX_MESSAGES,
  agentTurnFailureJournalDetail,
  agentTurnFailureReply,
  agentExchangeTurnPrompt,
  abandonedCornerCloseRetryDelayMs,
  ABANDONED_CORNER_CLOSE_RETRY_BASE_MS,
  ABANDONED_CORNER_CLOSE_RETRY_CAP_MS,
  UNTRACKED_CORNER_SCAN_INTERVAL_MS,
  assertRelayCornerArchiveTarget,
  assertSubchannelArchiveTarget,
  Body,
  conciseCornerTurnSummary,
  conciseLandSummary,
  isMovedTargetLandFailure,
  cornerArchiveSummary,
  CORNER_CLOSE_TAG,
  CORNER_TARGET_SYNC_INSTRUCTION,
  CORNER_TURN_SUMMARY_INSTRUCTION,
  CORNER_TURN_SUMMARY_MAX_CHARS,
  cornerNameForIntent,
  slugifyCornerTask,
  createAgentSubchannel,
  cornerOpenTaskPrompt,
  cornerTurnPrompt,
  taskDescriptionFromCornerRequest,
  taskSlugForCornerIntent,
  isChannelAddressedMessage,
  isChannelWorkIntent,
  isReadOnlyInformationRequest,
  isRepositoryMutationRequest,
  CORNER_APPROVED_REPO_UNRESTORABLE,
  isNonRetryableRelayError,
  isTransientPermissionPollError,
  humanAgentExchangeRequest,
  ReadOnlyToolsUnavailableError,
  isAcpPromptStallError,
  ROOM_AGENT_PROMPT_TIMEOUT_MS,
  ROOM_POLL_FAILURE_BACKOFF_CAP_MS,
  RoomPollBackoff,
  type ChannelTaskRequest,
  type RoomReplyOutcome,
  codegraphMcpServer,
  readOnlyMcpServer,
  roomEditPolicyInstructions,
  roomTurnPrompt,
  roomViewConversationHistory,
  WRITE_PERMISSION_BACKSTOP_POLL_MS,
} from './body.js';
import {
  buildPermissionDecision,
  buildPermissionRequest,
  defaultPermissionGrantEnvelope,
  parsePermissionDecision,
  parsePermissionRequest,
  type PermissionFreshReader,
  type PermissionRequestV1,
} from '@beeline/buzz-client';
import { AcpClient, isMutatingPermissionRequest } from './acp.js';
import { newIdentity } from '@beeline/gate';
import {
  WRITE_PERMISSION_RESPONSE_TAG,
  setAgentModelConfig,
  AGENT_PRESENCE_HEARTBEAT_MS,
  AGENT_PRESENCE_STALE_MS,
  isAgentPresenceOnline,
  KIND_AGENT_MODEL_CATALOG,
  KIND_AGENT_MODEL_CONFIG,
  KIND_CHANNEL_ADMINS,
  KIND_CHANNEL_MEMBERS,
  KIND_CREATE_GROUP,
  KIND_STREAM_MESSAGE,
  TAG_AGENT,
  TAG_AGENT_MODEL_CATALOG,
  TAG_COMMUNITY,
  DEFAULT_AGENT_IDENTITY_NAME,
  deriveAgentDisplayName,
  fallbackAgentName,
  parseAgentCommands,
  type AgentHistoryEntry,
  type RoomViewMessage,
} from '@beeline/buzz-client';
import { signEvent, verifyEvent, type NostrEvent } from '@beeline/nostr';
import {
  buildAgentMessage,
  postAgentMessage,
  postAgentPresence,
  startAgentPresence,
  agentPresenceRetryDelayMs,
  AGENT_PRESENCE_RETRY_MAX_ATTEMPTS,
  stripAgentReplyPreamble,
  replyRootIdForEvent,
  STEER_QUEUED_TAG,
  SLASH_COMMAND_NOTICE_TAG,
} from './activity.js';
import {
  isBeelineAgentToolPermissionRequest,
  isReadOnlyMcpPermissionRequest,
} from './read-only-policy.js';
import { targetBranchProposalFromAgentText } from './target-branch.js';
import {
  CLAUDE_ACP_MCP_GIT_LOG_PERMISSION,
  CLAUDE_ACP_MCP_GIT_SHOW_PERMISSION,
  CLAUDE_ACP_MCP_READ_FILE_PERMISSION,
  CLAUDE_ACP_NATIVE_BASH_PERMISSION,
  CLAUDE_ACP_NATIVE_READ_TOOL_CALL,
  CLAUDE_ACP_NATIVE_WRITE_PERMISSION,
  CODEX_ACP_MCP_READ_FILE_PERMISSION,
} from './fixtures/claude-agent-acp-permissions.js';
import { ROOM_READ_ONLY_STEER } from './session-sandbox.js';
import { detectBwrapSandbox } from './bwrap-sandbox.js';
import { SessionScheduler } from './session-scheduler.js';
import { GROK_WARM_SESSION_IDLE_MS } from './harness-capabilities.js';
import { ModelSelectionUnavailableError } from './model-config.js';
import {
  agentDelegationDedupe,
  agentDelegationTags,
  type AgentDelegationEnvelope,
} from './agent-mention.js';

/**
 * Whether this host can actually build the bwrap namespace `sessionSpawnCommand`
 * targets, per the product's own start-up viability probe. A `bwrap` binary
 * that exists but cannot unshare (e.g. AppArmor-restricted unprivileged user
 * namespaces, common on CI runners) must not fail a test asserting only that
 * Body constructs the right argv — only tests that actually execute the
 * resulting command need this gate.
 */
const bwrapExecutionViable = detectBwrapSandbox().path !== undefined;

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  mocks.createBuzzClient.mockReset();
  mocks.createBuzzClient.mockImplementation(mocks.realCreateBuzzClient);
});

function stubEmptyAgentHistory(body: Body): void {
  vi.spyOn(body as never, 'agentHistory' as never).mockResolvedValue([] as never);
}
describe('mcp-inventory', () => {
  it('hasWriteTools returns false for empty list', () => {
    expect(hasWriteTools([])).toBe(false);
  });

  it('hasWriteTools detects write tools by name', () => {
    expect(hasWriteTools(['read_file', 'view_image'])).toBe(false);
    expect(hasWriteTools(['shell'])).toBe(true);
    expect(hasWriteTools(['str_replace'])).toBe(true);
    expect(hasWriteTools(['write'])).toBe(true);
  });

  it('inventoryForMcpServers returns empty for no servers', async () => {
    const tools = await inventoryForMcpServers([]);
    expect(tools).toEqual([]);
  });

  it('binds the read-only MCP to the exact paired checkout', () => {
    expect(
      readOnlyMcpServer(
        {
          agentBinary: '/agent',
          mcpBinary: '/buzz-dev-mcp',
          readonlyMcpCommand: '/buzz-readonly-mcp',
          readonlyMcpArgs: ['--fixed-entrypoint'],
          agentEnv: {},
          workspaceRoot: '/workspace',
          relayBaseUrl: 'http://relay.test',
          relayHost: 'relay.test',
          relayScheme: 'http',
          relayWsUrl: 'ws://relay.test',
          autoApprovePermissions: true,
        },
        '/paired/repository',
      ),
    ).toEqual({
      name: 'buzz-readonly-mcp',
      command: '/buzz-readonly-mcp',
      args: ['--fixed-entrypoint'],
      env: [{ name: 'BUZZ_READONLY_ROOT', value: '/paired/repository' }],
    });
  });

  it('pins agent self-reads to this agent home and Workspace memory only', () => {
    for (const kind of ['claude', 'codex', 'grok', 'pi'] as const) {
      expect(
        readOnlyMcpServer(
          {
            agentBinary: '/agent',
            agentKind: kind,
            mcpBinary: '/buzz-dev-mcp',
            readonlyMcpCommand: '/buzz-readonly-mcp',
            agentEnv: {},
            workspaceRoot: '/workspace',
            agentHomeRoot: '/runtime/agents/agent-a/home',
            relayBaseUrl: 'http://relay.test',
            relayHost: 'relay.test',
            relayScheme: 'http',
            relayWsUrl: 'ws://relay.test',
            autoApprovePermissions: true,
          },
          '/paired/repository',
          '/runtime/agents/agent-a/memory/workspace-a',
        ).env,
      ).toEqual([
        { name: 'BUZZ_READONLY_ROOT', value: '/paired/repository' },
        {
          name: 'BUZZ_READONLY_AGENT_SKILLS_ROOT',
          value: `/runtime/agents/agent-a/home/${kind}/skills`,
        },
        {
          name: 'BUZZ_READONLY_AGENT_MEMORY_ROOT',
          value: '/runtime/agents/agent-a/memory/workspace-a',
        },
      ]);
    }
  });

  it('refuses to construct a Room server when read-only tools are unavailable', () => {
    expect(() =>
      readOnlyMcpServer(
        {
          agentBinary: '/agent',
          mcpBinary: '/buzz-dev-mcp',
          agentEnv: {},
          workspaceRoot: '/workspace',
          relayBaseUrl: 'http://relay.test',
          relayHost: 'relay.test',
          relayScheme: 'http',
          relayWsUrl: 'ws://relay.test',
          autoApprovePermissions: true,
        },
        '/paired/repository',
      ),
    ).toThrow('read-only tools unavailable');
  });

  it('mounts codegraph as an MCP server when the binary is configured', () => {
    expect(
      codegraphMcpServer({
        agentBinary: '/agent',
        mcpBinary: '/buzz-dev-mcp',
        codegraphCommand: '/usr/local/bin/codegraph',
        agentEnv: {},
        workspaceRoot: '/workspace',
        relayBaseUrl: 'http://relay.test',
        relayHost: 'relay.test',
        relayScheme: 'http',
        relayWsUrl: 'ws://relay.test',
        autoApprovePermissions: true,
      }),
    ).toEqual({
      name: 'codegraph',
      command: '/usr/local/bin/codegraph',
      args: ['serve', '--mcp'],
      env: [],
    });
  });

  it('omits codegraph rather than throwing when the binary is not configured', () => {
    expect(
      codegraphMcpServer({
        agentBinary: '/agent',
        mcpBinary: '/buzz-dev-mcp',
        agentEnv: {},
        workspaceRoot: '/workspace',
        relayBaseUrl: 'http://relay.test',
        relayHost: 'relay.test',
        relayScheme: 'http',
        relayWsUrl: 'ws://relay.test',
        autoApprovePermissions: true,
      }),
    ).toBeUndefined();
  });
});

describe('config', () => {
  it('parseEnvFile handles basic key=value', () => {
    const result = parseEnvFile('/nonexistent');
    expect(result).toEqual({});
  });

  it('hasLlmCredentials detects openai setup', () => {
    expect(hasLlmCredentials({})).toBe(false);
    expect(
      hasLlmCredentials({
        OPENAI_COMPAT_API_KEY: 'sk-test',
        OPENAI_COMPAT_MODEL: 'gpt-4',
      }),
    ).toBe(true);
  });
});

describe('acp', () => {
  it('journals known activation failures without leaking unknown error text', () => {
    expect(
      agentTurnFailureJournalDetail(
        new Error('Trusty Squire storage or IPC boundary cannot be masked from the agent sandbox'),
      ),
    ).toBe('Trusty Squire storage or IPC boundary cannot be masked from the agent sandbox');
    expect(
      agentTurnFailureJournalDetail(
        new Error('ACP session/prompt timed out after 8000ms of inactivity'),
      ),
    ).toBe('ACP session/prompt timed out after 8000ms of inactivity');
    expect(agentTurnFailureJournalDetail(new Error('provider token=must-not-appear'))).toBe(
      'Error',
    );
    expect(agentTurnFailureJournalDetail(new Error('Trusty Squire bearer skLiveSecret'))).toBe(
      'Error',
    );
    const named = new Error('unknown');
    named.name = 'token=must-not-appear';
    expect(agentTurnFailureJournalDetail(named)).toBe('Error');
    expect(agentTurnFailureReply(named)).toBeUndefined();
    expect(agentTurnFailureReply(new Error('provider token=must-not-appear'))).toBeUndefined();
  });

  it('AcpClient must be started before use', async () => {
    const { AcpClient } = await import('./acp.js');
    const client = new AcpClient({
      agentBinary: '/nonexistent',
      agentEnv: {},
    });
    await expect(client.sessionNew({ cwd: '/tmp' })).rejects.toThrow('AcpClient not started');
  });

  it('classifies edit, write, and shell permissions without treating reads as writes', () => {
    expect(isMutatingPermissionRequest({ toolCall: { kind: 'edit', title: 'str_replace' } })).toBe(
      true,
    );
    expect(isMutatingPermissionRequest({ toolCall: { kind: 'execute', title: 'Run shell' } })).toBe(
      true,
    );
    expect(
      isMutatingPermissionRequest({ toolCall: { kind: 'read', title: 'Read package.json' } }),
    ).toBe(false);
  });

  /**
   * The live regression these pin: a claude-backed Room reported EVERY
   * read-only tool call — `read_file`, `git_log`, `git_show` — coming back
   * "User refused permission to run tool". Every request below marked as
   * captured is the verbatim payload a real claude-agent-acp process sent
   * (`src/fixtures/claude-agent-acp-permissions.ts`, reproducible with
   * `scripts/capture-acp-permissions.mjs`), so the detector is tested against
   * the shape that actually arrives rather than an assumed one.
   */
  it('allows the exact read-only MCP requests a real claude-agent-acp sends', () => {
    for (const captured of [
      CLAUDE_ACP_MCP_READ_FILE_PERMISSION,
      CLAUDE_ACP_MCP_GIT_LOG_PERMISSION,
      CLAUDE_ACP_MCP_GIT_SHOW_PERMISSION,
    ]) {
      // The two properties that decide this, both as captured: nothing marks
      // the call as MCP, and the tool name is double-underscore separated.
      expect(captured.toolCall.kind).toBe('other');
      expect(captured).not.toHaveProperty('_meta');
      expect(captured.toolCall.rawInput).not.toHaveProperty('server');
      expect(captured.toolCall.title).toMatch(/^mcp__buzz-readonly-mcp__/);
      expect(isReadOnlyMcpPermissionRequest(captured)).toBe(true);
    }
  });

  it("denies the same adapter's captured native write and shell requests", () => {
    expect(isReadOnlyMcpPermissionRequest(CLAUDE_ACP_NATIVE_WRITE_PERMISSION)).toBe(false);
    expect(isReadOnlyMcpPermissionRequest(CLAUDE_ACP_NATIVE_BASH_PERMISSION)).toBe(false);
  });

  it('denies adapter-native read/search because their host paths are not daemon-pinned', () => {
    expect(isReadOnlyMcpPermissionRequest({ toolCall: CLAUDE_ACP_NATIVE_READ_TOOL_CALL })).toBe(
      false,
    );
    expect(
      isReadOnlyMcpPermissionRequest({ toolCall: { kind: 'search', title: 'grep "beeline"' } }),
    ).toBe(false);
    expect(
      isReadOnlyMcpPermissionRequest({
        toolCall: {
          kind: 'read',
          title: 'Read src/write.ts',
          rawInput: { file_path: 'src/write.ts' },
        },
      }),
    ).toBe(false);
    expect(
      isReadOnlyMcpPermissionRequest({
        toolCall: { kind: 'read', title: 'read_file', rawInput: { path: '/etc/passwd' } },
      }),
    ).toBe(false);
    expect(
      isReadOnlyMcpPermissionRequest({
        toolCall: {
          kind: 'read',
          title: 'Read /tmp/buzz-readonly-mcp/read_file',
          rawInput: { path: '/tmp/buzz-readonly-mcp/read_file' },
        },
      }),
    ).toBe(false);
  });

  it("recognizes the inspection toolset across the other adapters' spellings", () => {
    // codex-acp forwards a real MCP envelope and spells the tool with dots.
    expect(isReadOnlyMcpPermissionRequest(CODEX_ACP_MCP_READ_FILE_PERMISSION)).toBe(true);
    for (const title of [
      'mcp.buzz-readonly-mcp.search_text',
      'buzz-readonly-mcp/git_show',
      'buzz-readonly-mcp:list_files',
      'mcp__buzz-readonly-mcp__git_diff',
      'mcp__buzz-readonly-mcp__read_agent_file',
      'buzz-readonly-mcp (read_file)',
    ]) {
      expect(isReadOnlyMcpPermissionRequest({ toolCall: { kind: 'other', title } })).toBe(true);
    }
  });

  it('recognizes Beeline agent tools as host-governed MCP calls, never native mutations', () => {
    for (const request of [
      {
        toolCall: {
          kind: 'execute',
          title: 'mcp.beeline-agent-tools.open_corner',
          rawInput: {
            server: 'beeline-agent-tools',
            tool: 'open_corner',
            arguments: { objective: 'Fix the incident' },
          },
        },
      },
      { toolCall: { kind: 'other', title: 'mcp__beeline-agent-tools__open_corner' } },
    ]) {
      expect(isBeelineAgentToolPermissionRequest(request)).toBe(true);
    }
    expect(
      isBeelineAgentToolPermissionRequest({
        toolCall: {
          kind: 'execute',
          title: 'rm -rf /tmp/beeline-agent-tools/open_corner',
          rawInput: { command: 'rm -rf /tmp/beeline-agent-tools/open_corner' },
        },
      }),
    ).toBe(false);
  });

  it('stays fail-closed on every non-read shape', () => {
    for (const request of [
      // A tool on the inspection server that is not one of its six.
      {
        _meta: { is_mcp_tool_approval: true },
        toolCall: {
          kind: 'execute',
          title: 'mcp.buzz-readonly-mcp.shell',
          rawInput: { server: 'buzz-readonly-mcp', tool: 'shell', arguments: {} },
        },
      },
      { toolCall: { kind: 'other', title: 'mcp__buzz-readonly-mcp__write_file' } },
      // Kinds that are neither reads nor recognized inspection calls.
      { toolCall: { kind: 'other', title: 'SomeBrandNewTool' } },
      { toolCall: { kind: 'think', title: 'Update TODOs: ship it' } },
      { toolCall: { kind: 'edit', title: 'Write' } },
      {},
    ]) {
      expect(isReadOnlyMcpPermissionRequest(request)).toBe(false);
    }
  });

  /**
   * Identifying a tool by the tail of its title is only safe while the title is
   * a tool NAME. A native shell tool's title is its COMMAND LINE, so a command
   * ending in an inspection tool name under a path containing the server name
   * satisfies the same suffix match — and an auto-allow there walks straight
   * through the Room read-only boundary the detector exists to hold.
   */
  it('never resolves a shell payload by name, however its command text reads', () => {
    for (const command of [
      'rm -rf /tmp/buzz-readonly-mcp/read_file',
      'cat /opt/buzz-readonly-mcp/read_file',
      'git -C /srv/buzz-readonly-mcp commit -am buzz-readonly-mcp/read_file',
    ]) {
      expect(
        isReadOnlyMcpPermissionRequest({
          toolCall: { kind: 'execute', title: command, rawInput: { command } },
        }),
      ).toBe(false);
      expect(
        isReadOnlyMcpPermissionRequest({
          toolCall: { kind: 'execute', title: command, rawInput: { cmd: command } },
        }),
      ).toBe(false);
      expect(
        isReadOnlyMcpPermissionRequest({
          toolCall: { kind: 'execute', title: command, rawInput: command },
        }),
      ).toBe(false);
    }
  });
});

describe('agent identity boundary', () => {
  const config = {
    agentBinary: '/nonexistent',
    mcpBinary: '/nonexistent',
    agentEnv: {},
    workspaceRoot: '/tmp/buzzy-body-unit',
    relayBaseUrl: 'http://relay.test',
    relayHost: 'relay.test',
    relayScheme: 'http',
    relayWsUrl: 'ws://relay.test',
    autoApprovePermissions: true,
  };

  it('always assigns the agent a key distinct from the operator', () => {
    const body = new Body(config, newIdentity('operator'));
    expect(body.agent.publicKey).not.toBe(body.identity.publicKey);
  });

  it('mints fresh identities with the Beeline default marker, never the pre-rebrand name', () => {
    const body = new Body(config);
    expect(body.agent.name).toBe('beeline-agent');
    expect(body.identity.name).toBe('beeline-body');
    // The marker is a placeholder, not a display identity: it resolves to a
    // stable spoken seed name derived from each agent's own pubkey. Display
    // names have a finite vocabulary, so uniqueness belongs to the pubkeys.
    const first = newIdentity(DEFAULT_AGENT_IDENTITY_NAME);
    const second = newIdentity(DEFAULT_AGENT_IDENTITY_NAME);
    expect(deriveAgentDisplayName(first.name, first.publicKey)).toBe(
      fallbackAgentName(first.publicKey),
    );
    expect(deriveAgentDisplayName(second.name, second.publicKey)).toBe(
      fallbackAgentName(second.publicKey),
    );
    expect(first.publicKey).not.toBe(second.publicKey);
  });

  describe('persona delivery to harnesses that drop the session system prompt', () => {
    it('re-sends a set persona at the top of every turn prompt for codex/pi-class harnesses', async () => {
      const scheduler = new SessionScheduler({ maxLiveSessions: 4, idleMs: 60_000 });
      try {
        const body = new Body(
          {
            ...config,
            agentCommand: '/usr/local/bin/codex-acp',
            workspaceRoot: '/tmp/beeline-persona-turn',
          },
          newIdentity('persona-operator'),
          newIdentity('persona-agent'),
          { scheduler },
        );
        const durable = (
          body as unknown as {
            durableState: Record<string, ReturnType<typeof vi.fn> & (() => Promise<undefined>)>;
          }
        ).durableState;
        vi.spyOn(durable as never, 'recordModelTurn' as never).mockResolvedValue(
          undefined as never,
        );
        const sessionPrompt = vi.fn().mockResolvedValue({ agentText: 'ok', updates: [] });
        const session = {
          channelId: 'persona-room',
          sessionId: 'persona-session-1',
          mode: 'readonly' as const,
          client: { sessionPrompt, sessionCancel: vi.fn() },
          lifecycle: {
            activate: vi.fn().mockResolvedValue('persona-session-1'),
            suspend: vi.fn().mockResolvedValue(undefined),
          },
          personaTurnPrefix: [
            'Human-authored agent persona for this Workspace:',
            'Name: Clara',
            'Soul: Steady, practical, and ready to help this Workspace.',
          ].join('\n'),
        } as never;

        await Reflect.get(body, 'promptAgent').call(body, session, 'What is my name?', {
          channelId: 'persona-room',
          requestId: 'persona-request',
          originalRequestId: 'persona-request',
          cause: 'room-message',
        });

        expect(sessionPrompt).toHaveBeenCalledTimes(1);
        const wirePrompt = sessionPrompt.mock.calls[0]![1] as string;
        expect(wirePrompt).toContain('Name: Clara');
        expect(wirePrompt).toContain('What is my name?');
        expect(wirePrompt.indexOf('Name: Clara')).toBeLessThan(
          wirePrompt.indexOf('What is my name?'),
        );
      } finally {
        await scheduler.dispose();
      }
    });

    it('sends the bare prompt when the session carries no persona prefix', async () => {
      const scheduler = new SessionScheduler({ maxLiveSessions: 4, idleMs: 60_000 });
      try {
        const body = new Body(
          { ...config, workspaceRoot: '/tmp/beeline-persona-turn-bare' },
          newIdentity('bare-operator'),
          newIdentity('bare-agent'),
          { scheduler },
        );
        const durable = (
          body as unknown as {
            durableState: Record<string, ReturnType<typeof vi.fn> & (() => Promise<undefined>)>;
          }
        ).durableState;
        vi.spyOn(durable as never, 'recordModelTurn' as never).mockResolvedValue(
          undefined as never,
        );
        const sessionPrompt = vi.fn().mockResolvedValue({ agentText: 'ok', updates: [] });
        const session = {
          channelId: 'bare-room',
          sessionId: 'bare-session-1',
          mode: 'readonly' as const,
          client: { sessionPrompt, sessionCancel: vi.fn() },
          lifecycle: {
            activate: vi.fn().mockResolvedValue('bare-session-1'),
            suspend: vi.fn().mockResolvedValue(undefined),
          },
        } as never;

        await Reflect.get(body, 'promptAgent').call(body, session, 'plain question', {
          channelId: 'bare-room',
          requestId: 'bare-request',
          originalRequestId: 'bare-request',
          cause: 'room-message',
        });

        expect(sessionPrompt.mock.calls[0]![1]).toBe('plain question');
      } finally {
        await scheduler.dispose();
      }
    });

    it('refreshes a warm session persona on the next turn after a soul is saved', async () => {
      // Pins the fix for a saved soul edit not reaching a warm session: the
      // daemon used to apply persona only at session ACTIVATION
      // (createManagedSession's activate()), so an already-live session kept
      // serving the persona it started with indefinitely. This exercises the
      // fix end to end: refreshPersonaForSoulUpdate() suspends the idle
      // session so the NEXT turn goes through activate() again and picks up
      // the newly saved soul, never touching the FIRST (still in-flight) turn.
      const scheduler = new SessionScheduler({ maxLiveSessions: 4, idleMs: 60_000 });
      try {
        const body = new Body(
          {
            ...config,
            agentCommand: '/usr/local/bin/codex-acp',
            workspaceRoot: '/tmp/beeline-persona-soul-refresh',
          },
          newIdentity('soul-refresh-operator'),
          newIdentity('soul-refresh-agent'),
          { scheduler },
        );
        const durable = (
          body as unknown as {
            durableState: Record<string, ReturnType<typeof vi.fn> & (() => Promise<undefined>)>;
          }
        ).durableState;
        vi.spyOn(durable as never, 'recordModelTurn' as never).mockResolvedValue(
          undefined as never,
        );
        const sessionPrompt = vi.fn().mockResolvedValue({ agentText: 'ok', updates: [] });
        const souls = [
          'Soul: Steady, practical, and ready to help this Workspace.',
          'Soul: Japanese cosplay girl personality, bubbly and playful.',
        ];
        let activations = 0;
        const session = {
          channelId: 'soul-refresh-room',
          sessionId: 'soul-refresh-session-1',
          mode: 'readonly' as const,
          client: { sessionPrompt, sessionCancel: vi.fn() },
          lifecycle: {
            // Models real activation: `createManagedSession`'s activate()
            // resolves the CURRENT soul from the relay every time it runs,
            // never only once at first start.
            activate: vi.fn().mockImplementation(async () => {
              session.personaTurnPrefix = souls[activations] ?? souls[souls.length - 1];
              activations += 1;
              return 'soul-refresh-session-1';
            }),
            suspend: vi.fn().mockResolvedValue(undefined),
          },
        } as never;
        body.registerSession(session);

        await Reflect.get(body, 'promptAgent').call(body, session, 'first question', {
          channelId: 'soul-refresh-room',
          requestId: 'soul-refresh-request-1',
          originalRequestId: 'soul-refresh-request-1',
          cause: 'room-message',
        });
        expect(sessionPrompt.mock.calls[0]![1]).toContain(souls[0]);

        // The soul is saved here, while the session is still warm/live.
        await body.refreshPersonaForSoulUpdate();

        await Reflect.get(body, 'promptAgent').call(body, session, 'second question', {
          channelId: 'soul-refresh-room',
          requestId: 'soul-refresh-request-2',
          originalRequestId: 'soul-refresh-request-2',
          cause: 'room-message',
        });

        expect(session.lifecycle.activate).toHaveBeenCalledTimes(2);
        expect(sessionPrompt.mock.calls[1]![1]).toContain(souls[1]);
        expect(sessionPrompt.mock.calls[1]![1]).not.toContain(souls[0]);
      } finally {
        await scheduler.dispose();
      }
    });

    it.each([
      {
        directive: 'Stop the launch pack. Explain what Ethereum is instead.',
        expected: 'Ethereum is a programmable blockchain network.',
      },
      {
        directive: 'Trade crypto.',
        expected:
          "I can't trade crypto because this Room has no trading capability. I will stop here.",
      },
      {
        directive: 'Continue the launch pack by outlining its pricing section.',
        expected: 'Continuing the launch pack with its pricing section.',
      },
    ])(
      'makes the newest human directive authoritative over a standing plan: $directive',
      async ({ directive, expected }) => {
        const scheduler = new SessionScheduler({ maxLiveSessions: 4, idleMs: 60_000 });
        try {
          const body = new Body(
            {
              ...config,
              agentCommand: '/usr/local/bin/codex-acp',
              workspaceRoot: '/tmp/beeline-human-directive-primacy',
            },
            newIdentity('directive-operator'),
            newIdentity('directive-agent'),
            { scheduler },
          );
          const durable = (
            body as unknown as {
              durableState: Record<string, ReturnType<typeof vi.fn> & (() => Promise<undefined>)>;
            }
          ).durableState;
          vi.spyOn(durable as never, 'recordModelTurn' as never).mockResolvedValue(
            undefined as never,
          );
          const sessionPrompt = vi.fn(async (_sessionId: string, wirePrompt: string) => {
            // Hermetic model of the reported failure: a standing plan wins a
            // one-off contradiction, while repeating the unchanged directive
            // at the final prompt boundary makes that directive salient. This
            // deliberately knows nothing about Body's marker or policy prose.
            const directiveMentions = wirePrompt.split(directive).length - 1;
            const agentText =
              directiveMentions < 2
                ? 'Planning self-contained launch pack HTML.'
                : directive === 'Stop the launch pack. Explain what Ethereum is instead.'
                  ? 'Ethereum is a programmable blockchain network.'
                  : directive === 'Trade crypto.'
                    ? "I can't trade crypto because this Room has no trading capability. I will stop here."
                    : directive === 'Continue the launch pack by outlining its pricing section.'
                      ? 'Continuing the launch pack with its pricing section.'
                      : 'Planning self-contained launch pack HTML.';
            return { stopReason: 'end_turn', updates: [], agentText, toolCalls: [] };
          });
          const session = {
            channelId: 'directive-room',
            sessionId: 'directive-session-1',
            mode: 'readonly' as const,
            client: { sessionPrompt, sessionCancel: vi.fn() },
            lifecycle: {
              activate: vi.fn().mockResolvedValue('directive-session-1'),
              suspend: vi.fn().mockResolvedValue(undefined),
            },
            personaTurnPrefix: [
              'Use the workbench for a self-contained HTML mockup.',
              'Serving is single-file v1: inline assets into one HTML file.',
            ].join('\n'),
          } as never;
          const standingPlanPrompt = [
            'Host-provided shared Room context follows.',
            'Recent Room transcript (oldest to newest):',
            '[Agent Codex]: I will build the web-agency launch pack now.',
            '',
            'Current human-addressed request:',
            directive,
          ].join('\n');

          const result = await Reflect.get(body, 'promptAgent').call(
            body,
            session,
            standingPlanPrompt,
            {
              channelId: 'directive-room',
              requestId: 'directive-request',
              originalRequestId: 'directive-request',
              cause: 'room-message',
            },
            {
              request: {
                eventId: 'directive-request',
                authorPubkey: 'a'.repeat(64),
                content: directive,
                createdAt: 1,
              },
              boundRepo: { repo: 'repo' },
              editPolicy: 'repository',
              permissionHandled: false,
              transitionedToCorner: false,
              readOnlyInformationRequest: true,
            },
          );

          expect(result.agentText).toBe(expected);
          const wirePrompt = sessionPrompt.mock.calls[0]![1] as string;
          expect(wirePrompt).toContain('I will build the web-agency launch pack now.');
          expect(wirePrompt).toContain(
            'If you cannot or will not comply because a capability is unavailable or model policy forbids it, say that explicitly and stop.',
          );
          expect(wirePrompt).toContain(
            'All host-provided permission, tool, repository, and safety boundaries above remain binding and take precedence',
          );
          expect(wirePrompt.split(directive)).toHaveLength(3);
          expect(wirePrompt.indexOf('CURRENT EXPLICIT HUMAN DIRECTIVE')).toBeGreaterThan(
            wirePrompt.indexOf('I will build the web-agency launch pack now.'),
          );
        } finally {
          await scheduler.dispose();
        }
      },
    );

    it('delivers the direct open_corner contract to pi turn content', async () => {
      const scheduler = new SessionScheduler({ maxLiveSessions: 4, idleMs: 60_000 });
      try {
        const body = new Body(
          {
            ...config,
            agentCommand: '/usr/local/bin/pi-acp',
            workspaceRoot: '/tmp/beeline-pi-corner-turn',
          },
          newIdentity('pi-operator'),
          newIdentity('pi-agent'),
          { scheduler },
        );
        const durable = (
          body as unknown as {
            durableState: Record<string, ReturnType<typeof vi.fn> & (() => Promise<undefined>)>;
          }
        ).durableState;
        vi.spyOn(durable as never, 'recordModelTurn' as never).mockResolvedValue(
          undefined as never,
        );
        const sessionPrompt = vi
          .fn()
          .mockResolvedValue({ agentText: 'No edit needed.', updates: [] });
        const session = {
          channelId: 'pi-room',
          sessionId: 'pi-session-1',
          mode: 'readonly' as const,
          client: { sessionPrompt, sessionCancel: vi.fn() },
        } as unknown as {
          channelId: string;
          sessionId: string;
          mode: 'readonly';
          client: { sessionPrompt: typeof sessionPrompt; sessionCancel: ReturnType<typeof vi.fn> };
          personaTurnPrefix?: string;
          lifecycle?: {
            activate: () => Promise<string>;
            suspend: () => Promise<void>;
          };
        };
        session.lifecycle = {
          activate: vi.fn(async () => {
            session.personaTurnPrefix = roomEditPolicyInstructions('repository', 'pi-acp').join(
              '\n',
            );
            return 'pi-session-1';
          }),
          suspend: vi.fn().mockResolvedValue(undefined),
        };

        await Reflect.get(body, 'promptAgent').call(
          body,
          session as never,
          'Please change README.md.',
          {
            channelId: 'pi-room',
            requestId: 'pi-request',
            originalRequestId: 'pi-request',
            cause: 'room-message',
          },
        );

        const wirePrompt = sessionPrompt.mock.calls[0]![1] as string;
        expect(wirePrompt).toContain('mounted open_corner tool');
        expect(wirePrompt).not.toContain('CORNER_REQUEST:');
        expect(wirePrompt).toContain('Please change README.md.');
        expect(wirePrompt.indexOf('mounted open_corner tool')).toBeLessThan(
          wirePrompt.indexOf('Please change README.md.'),
        );
      } finally {
        await scheduler.dispose();
      }
    });
  });

  describe('OS sandbox wiring', () => {
    // A real git repository, because `sessionSpawnCommand` resolves a corner's
    // git common directory by asking git rather than guessing a path.
    const sandboxRoot = mkdtempSync(join(tmpdir(), 'buzzy-sandbox-wiring-'));
    const repoRoot = join(sandboxRoot, 'repo');
    const notARepo = join(sandboxRoot, 'plain');
    mkdirSync(repoRoot, { recursive: true });
    mkdirSync(notARepo, { recursive: true });
    spawnSync('git', ['init', '-q', '-b', 'main', repoRoot]);

    afterAll(() => rmSync(sandboxRoot, { recursive: true, force: true }));

    type SpawnProbe = {
      sessionSpawnCommand(
        input: {
          mode: 'readonly' | 'edit';
          cwd: string;
          worktreePath?: string;
          protectedPaths?: string[];
          additionalWritablePaths?: string[];
          workbench?: { dir: string; storageDir: string };
        },
        env: Record<string, string>,
      ): Promise<{ command: string; args: string[] }>;
    };

    it('spawns a Room child with a read-only filesystem and no writable bind', async () => {
      const body = new Body({ ...config, bwrapPath: '/usr/bin/bwrap' }, newIdentity('operator'));
      const spawn = await (body as unknown as SpawnProbe).sessionSpawnCommand(
        { mode: 'readonly', cwd: '/srv/checkout' },
        { CLAUDE_CONFIG_DIR: '/srv/rooms/r1/agent-home/claude' },
      );
      expect(spawn.command).toBe('/usr/bin/bwrap');
      expect(spawn.args.slice(0, 4)).toEqual(['--unshare-pid', '--ro-bind', '/', '/']);
      // Harness state is writable (codex/pi cannot start otherwise); the Room's
      // cwd — the canonical checkout — is bound nowhere and so stays read-only.
      const binds = spawn.args
        .map((argument, index) => (argument === '--bind-try' ? spawn.args[index + 1] : undefined))
        .filter(Boolean);
      expect(binds).toEqual(['/srv/rooms/r1/agent-home/claude']);
      expect(binds).not.toContain('/srv/checkout');
      expect(spawn.args.slice(-1)).toEqual(['/nonexistent']);
    });

    it('spawns a corner child with its worktree and git dir writable', async () => {
      const body = new Body({ ...config, bwrapPath: '/usr/bin/bwrap' }, newIdentity('operator'));
      const spawn = await (body as unknown as SpawnProbe).sessionSpawnCommand(
        {
          mode: 'edit',
          cwd: repoRoot,
          worktreePath: repoRoot,
          protectedPaths: [sandboxRoot],
        },
        { TMPDIR: '/srv/rooms/r1/agent-home/tmp' },
      );
      expect(spawn.command).toBe('/usr/bin/bwrap');
      expect(spawn.args.slice(0, 4)).toEqual(['--unshare-pid', '--bind', '/', '/']);
      const protectedAt = spawn.args.indexOf(sandboxRoot);
      expect(spawn.args.slice(protectedAt - 1, protectedAt + 2)).toEqual([
        '--ro-bind',
        sandboxRoot,
        sandboxRoot,
      ]);
      const binds = spawn.args
        .map((argument, index) => (argument === '--bind-try' ? spawn.args[index + 1] : undefined))
        .filter(Boolean);
      expect(binds).toContain(repoRoot);
      expect(binds).toContain(join(repoRoot, '.git'));
      expect(binds).toContain('/srv/rooms/r1/agent-home/tmp');
    });

    it('keeps a repo-less corner sandboxed in a Git-blocked quota workbench', async () => {
      const body = new Body({ ...config, bwrapPath: '/usr/bin/bwrap' }, newIdentity('operator'));
      const spawn = await (body as unknown as SpawnProbe).sessionSpawnCommand(
        {
          mode: 'edit',
          cwd: notARepo,
          protectedPaths: [sandboxRoot],
          additionalWritablePaths: [notARepo],
          workbench: { dir: notARepo, storageDir: notARepo },
        },
        {},
      );
      expect(spawn.command).toBe('/usr/bin/bwrap');
      expect(spawn.args.slice(0, 4)).toEqual(['--unshare-pid', '--unshare-user', '--uid', '0']);
      expect(spawn.args).toContain('--size');
      expect(spawn.args).toContain(join(notARepo, '.git'));
      const binds = spawn.args
        .map((argument, index) => (argument === '--bind-try' ? spawn.args[index + 1] : undefined))
        .filter(Boolean);
      expect(binds).toContain(notARepo);
    });

    it('masks operator credential stores out of a session instead of leaving them read-only', async () => {
      // Acceptance: a session's filesystem must contain NO readable operator
      // credential store. The whole-home ro-bind makes them read-only, which
      // is not enough — a readable gh token can push main out-of-band — so
      // every existing known store plus the owner-configured extras are
      // masked ABSENT (dir → empty tmpfs, file → /dev/null).
      const secretDir = join(sandboxRoot, 'operator-secrets');
      mkdirSync(secretDir, { recursive: true });
      writeFileSync(join(secretDir, 'token'), 'do-not-read');
      const body = new Body(
        {
          ...config,
          bwrapPath: '/usr/bin/bwrap',
          sandboxMaskPaths: [secretDir],
        },
        newIdentity('operator'),
      );
      const spawn = await (body as unknown as SpawnProbe).sessionSpawnCommand(
        { mode: 'readonly', cwd: '/srv/checkout' },
        {},
      );
      // The owner-configured extra is masked as an empty tmpfs.
      const secretAt = spawn.args.indexOf(secretDir);
      expect(spawn.args[secretAt - 1]).toBe('--tmpfs');
      // Masks ride AFTER the whole-home ro-bind they override.
      expect(secretAt).toBeGreaterThan(2);
      // Every built-in known credential store that exists on this host is
      // masked too — in BOTH modes; this is the Room shape.
      for (const entry of ['.config/gh', '.ssh', '.netrc', '.git-credentials', '.secrets.env']) {
        const path = join(homedir(), entry);
        if (!existsSync(path)) continue;
        const at = spawn.args.indexOf(path);
        expect(at).toBeGreaterThan(0);
        const kind =
          spawn.args[at - 1] === '--tmpfs'
            ? 'dir'
            : spawn.args[at - 1] === '/dev/null' && spawn.args[at - 2] === '--ro-bind'
              ? 'file'
              : undefined;
        expect(kind).toBeDefined();
      }
    });

    it('spawns the bare command when no bwrap was detected at daemon start', async () => {
      // An empty, non-ambient operatorHome: this host's real home may carry
      // Trusty Squire state, which would make squireIsolationRequired() true
      // and turn "no bwrap" into a rejection instead of the bare-command
      // fallback under test.
      const operatorHome = mkdtempSync(join(tmpdir(), 'buzzy-no-ambient-squire-'));
      try {
        const body = new Body({ ...config, operatorHome }, newIdentity('operator'));
        const spawn = await (body as unknown as SpawnProbe).sessionSpawnCommand(
          { mode: 'edit', cwd: repoRoot, worktreePath: repoRoot },
          {},
        );
        // Today's behaviour, unchanged: bwrap missing must never fail a session.
        expect(spawn).toEqual({ command: '/nonexistent', args: [] });
      } finally {
        rmSync(operatorHome, { recursive: true, force: true });
      }
    });

    it('fails open rather than sandboxing a corner it cannot resolve a git dir for', async () => {
      const operatorHome = mkdtempSync(join(tmpdir(), 'buzzy-no-ambient-squire-'));
      try {
        const body = new Body(
          { ...config, bwrapPath: '/usr/bin/bwrap', operatorHome },
          newIdentity('operator'),
        );
        const spawn = await (body as unknown as SpawnProbe).sessionSpawnCommand(
          // Not a git repository: a wrapped session here could edit but never
          // commit, which is worse than an unwrapped one.
          { mode: 'edit', cwd: notARepo, worktreePath: notARepo },
          {},
        );
        expect(spawn).toEqual({ command: '/nonexistent', args: [] });
      } finally {
        rmSync(operatorHome, { recursive: true, force: true });
      }
    });
  });

  describe('corner worktree isolation wiring', () => {
    it('resolves a paired-checkout corner to a clean sibling, not inside the primary', () => {
      const body = new Body(
        { ...config, workspaceRoot: '/home/op/proj-buzzy/.git/beeline/rooms/r1' },
        newIdentity('operator'),
      );
      const path = (
        body as unknown as {
          cornerWorktreePath(repo: { localPath: string }, id: string): string;
        }
      ).cornerWorktreePath({ localPath: '/home/op/proj-buzzy' }, 'corner-xyz');
      // Never nested inside the primary checkout or its .git.
      expect(path.startsWith('/home/op/proj-buzzy/')).toBe(false);
      expect(path).toBe('/home/op/.beeline-corners/proj-buzzy/corner-xyz');
    });

    it('builds the corner denylist from every shared and daemon-owned root', async () => {
      const body = new Body(
        {
          ...config,
          workspaceRoot: '/srv/beeline/workspace',
          agentHomeRoot: '/srv/beeline/rooms/r1/agent-home',
          agentPrivateRoot: '/srv/beeline/agent-private',
        },
        newIdentity('operator'),
      );
      const policy = await (
        body as unknown as {
          cornerFilesystemPolicy(
            repo: { repo: string; localPath: string },
            worktree: string,
            agentPrivate?: string,
          ): Promise<{
            protectedPaths: string[];
            writablePaths: string[];
            additionalWritablePaths: string[];
          }>;
        }
      ).cornerFilesystemPolicy(
        { repo: 'proj-buzzy', localPath: '/home/op/proj-buzzy' },
        '/home/op/.beeline-corners/proj-buzzy/c1',
        '/srv/beeline/agent-private/r1/c1',
      );

      expect(policy.protectedPaths).toEqual(
        expect.arrayContaining([
          '/srv/beeline/workspace',
          '/home/op/.beeline-corners/proj-buzzy',
          '/home/op/proj-buzzy',
          '/srv/beeline/rooms/r1/agent-home',
          '/srv/beeline/agent-private',
        ]),
      );
      expect(policy.writablePaths).toContain('/home/op/.beeline-corners/proj-buzzy/c1');
      expect(policy.additionalWritablePaths).toEqual(['/srv/beeline/agent-private/r1/c1']);
    });

    it('the edit-session fallback rejects protected writes without blocking general movement', async () => {
      const body = new Body(config, newIdentity('operator'));
      const handler = (
        body as unknown as {
          cornerPermissionHandler(
            worktree: string,
            protectedPaths: string[],
            writablePaths: string[],
          ): (req: unknown) => Promise<'allow' | 'reject'>;
        }
      ).cornerPermissionHandler(
        '/pool/.beeline-corners/proj/c1',
        ['/pool/.beeline-corners/proj', '/home/op/proj-buzzy'],
        ['/pool/.beeline-corners/proj/c1'],
      );

      const escape = await handler({
        toolCall: {
          kind: 'execute',
          rawInput: { command: 'cp README.md /home/op/proj-buzzy/README.md' },
        },
      });
      expect(escape).toBe('reject');

      const ok = await handler({
        toolCall: { kind: 'execute', rawInput: { command: 'cd /tmp && npm run build' } },
      });
      expect(ok).toBe('allow');

      // A relative in-worktree edit stays allowed by the guard.
      const edit = await handler({ toolCall: { kind: 'edit', rawInput: { path: 'a.ts' } } });
      expect(edit).toBe('allow');
    });

    it('the edit-session guard rejects denylist writes but allows other outside writes', async () => {
      const body = new Body(config, newIdentity('operator'));
      const handler = (
        body as unknown as {
          cornerPermissionHandler(
            worktree: string,
            protectedPaths: string[],
            writablePaths: string[],
          ): (req: unknown) => Promise<'allow' | 'reject'>;
        }
      ).cornerPermissionHandler(
        '/pool/.beeline-corners/proj/c1',
        ['/pool/.beeline-corners/proj', '/home/op/proj-buzzy'],
        ['/pool/.beeline-corners/proj/c1'],
      );

      // The live breach shape: an absolute path into the operator's own tree.
      await expect(
        handler({
          toolCall: {
            kind: 'edit',
            title: 'Write',
            rawInput: { file_path: '/home/op/proj-buzzy/apps/mobile/sources/x.ts' },
          },
        }),
      ).resolves.toBe('reject');
      await expect(
        handler({ toolCall: { kind: 'edit', rawInput: { path: '../../../etc/hosts' } } }),
      ).resolves.toBe('allow');
      // Reads outside the worktree stay allowed, per the pre-existing policy.
      await expect(
        handler({
          toolCall: { kind: 'read', rawInput: { path: '/home/op/proj-buzzy/README.md' } },
        }),
      ).resolves.toBe('allow');
    });
  });

  describe('Room sessions cannot write or execute at all', () => {
    it('allows only a path-pinned file write in the Room workbench while repo writes stay refused', async () => {
      const root = await mkdtemp(join(tmpdir(), 'buzzy-room-workbench-permission-'));
      const workbench = join(root, 'agent-private', 'workbench');
      mkdirSync(workbench, { recursive: true });
      const body = new Body(config, newIdentity('operator'), newIdentity('agent'));
      Reflect.get(body, 'sessions').set('room-1', {
        workbench: { dir: workbench, storageDir: workbench },
      });
      const handle = Reflect.get(body, 'handleRoomPermissionRequest').bind(body);

      try {
        await expect(
          handle('room-1', {
            toolCall: {
              kind: 'edit',
              title: 'Write preview',
              rawInput: { file_path: join(workbench, 'preview.html') },
            },
          }),
        ).resolves.toBe('allow');
        await expect(
          handle('room-1', {
            toolCall: {
              kind: 'edit',
              title: 'Write repo',
              rawInput: { file_path: '/home/op/proj-buzzy/README.md' },
            },
          }),
        ).resolves.toBe('reject');
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    it('denies a write and a shell command', async () => {
      const body = new Body(config, newIdentity('operator'), newIdentity('agent'));

      const handle = (
        body as unknown as {
          handleRoomPermissionRequest(
            channelId: string,
            permission: unknown,
            editPolicy?: string,
          ): Promise<'allow' | 'reject'>;
        }
      ).handleRoomPermissionRequest.bind(body);

      // No pending turn at all: still denied, never allowed. cwd isolation does
      // not constrain absolute-path reach, so the path is irrelevant here.
      await expect(
        handle('room-1', {
          toolCall: {
            kind: 'edit',
            title: 'Write',
            rawInput: { file_path: '/home/op/proj-buzzy/apps/mobile/sources/x.ts' },
          },
        }),
      ).resolves.toBe('reject');
      await expect(
        handle('room-1', {
          toolCall: { kind: 'execute', rawInput: { command: 'npm run typecheck' } },
        }),
      ).resolves.toBe('reject');
      await expect(
        handle('room-1', {
          toolCall: { kind: 'execute', rawInput: { command: 'git commit -am wip' } },
        }),
      ).resolves.toBe('reject');
    });

    /**
     * The same regression at the layer that actually answers the harness.
     * `handleRoomPermissionRequest` is where a Room's read-only rule is
     * ENFORCED, and its fail-closed default is what turned an unrecognized
     * inspection call into "User refused permission to run tool". These drive
     * it with the verbatim captured claude-agent-acp payloads.
     */
    it('answers a real claude read_file/git_log/git_show with allow, and its write/bash with reject', async () => {
      const body = new Body(config, newIdentity('operator'), newIdentity('agent'));
      const handle = (
        body as unknown as {
          handleRoomPermissionRequest(
            channelId: string,
            permission: unknown,
          ): Promise<'allow' | 'reject'>;
        }
      ).handleRoomPermissionRequest.bind(body);

      // Reads flow with no pending turn at all — the state a Room read runs in
      // when the human only asked a question.
      for (const captured of [
        CLAUDE_ACP_MCP_READ_FILE_PERMISSION,
        CLAUDE_ACP_MCP_GIT_LOG_PERMISSION,
        CLAUDE_ACP_MCP_GIT_SHOW_PERMISSION,
      ]) {
        await expect(handle('room-1', captured)).resolves.toBe('allow');
      }
      await expect(handle('room-1', { toolCall: CLAUDE_ACP_NATIVE_READ_TOOL_CALL })).resolves.toBe(
        'reject',
      );
      await expect(handle('room-1', CLAUDE_ACP_NATIVE_WRITE_PERMISSION)).resolves.toBe('reject');
      await expect(handle('room-1', CLAUDE_ACP_NATIVE_BASH_PERMISSION)).resolves.toBe('reject');
    });

    it('rejects a shell command whose text merely spells an inspection tool', async () => {
      const body = new Body(config, newIdentity('operator'), newIdentity('agent'));
      const handle = (
        body as unknown as {
          handleRoomPermissionRequest(
            channelId: string,
            permission: unknown,
          ): Promise<'allow' | 'reject'>;
        }
      ).handleRoomPermissionRequest.bind(body);

      const command = 'rm -rf /tmp/buzz-readonly-mcp/read_file';
      await expect(
        handle('room-1', { toolCall: { kind: 'execute', title: command, rawInput: { command } } }),
      ).resolves.toBe('reject');
    });

    it('lets a Beeline action-tool call reach its own authority kernel without a Room denial', async () => {
      const body = new Body(config, newIdentity('operator'), newIdentity('agent'));
      const noteDenial = vi.spyOn(body as never, 'noteRoomReadOnlyDenial' as never);
      const handle = Reflect.get(body, 'handleRoomPermissionRequest').bind(body);

      await expect(
        handle('room-1', {
          toolCall: {
            kind: 'execute',
            title: 'mcp.beeline-agent-tools.open_corner',
            rawInput: {
              server: 'beeline-agent-tools',
              tool: 'open_corner',
              arguments: { objective: 'Fix the incident' },
            },
          },
        }),
      ).resolves.toBe('allow');
      expect(noteDenial).not.toHaveBeenCalled();
    });

    it('still auto-allows an exact read-only MCP inspection call', async () => {
      const body = new Body(config, newIdentity('operator'), newIdentity('agent'));
      const handle = (
        body as unknown as {
          handleRoomPermissionRequest(
            channelId: string,
            permission: unknown,
          ): Promise<'allow' | 'reject'>;
        }
      ).handleRoomPermissionRequest.bind(body);

      await expect(
        handle('room-1', {
          _meta: { is_mcp_tool_approval: true },
          toolCall: {
            kind: 'execute',
            title: 'mcp.buzz-readonly-mcp.read_file',
            rawInput: { server: 'buzz-readonly-mcp', tool: 'read_file', arguments: {} },
          },
        }),
      ).resolves.toBe('allow');
      await expect(
        handle('room-1', {
          toolCall: {
            kind: 'execute',
            title: 'mcp.buzz-readonly-mcp.read_agent_file',
            rawInput: {
              server: 'buzz-readonly-mcp',
              tool: 'read_agent_file',
              arguments: { area: 'skills', path: 'using-beeline/SKILL.md' },
            },
          },
        }),
      ).resolves.toBe('allow');
      await expect(
        handle('room-1', {
          toolCall: {
            kind: 'execute',
            title: 'mcp.buzz-readonly-mcp.write_memory',
            rawInput: {
              server: 'buzz-readonly-mcp',
              tool: 'write_memory',
              arguments: { content: '# Agent memory\n' },
            },
          },
        }),
      ).resolves.toBe('allow');
    });

    it('allows creator-scoped Squire tools as standing authority', async () => {
      const safeRequest = {
        toolCall: {
          kind: 'other',
          title: 'mcp__squire__list_credentials',
          rawInput: { server: 'squire', tool: 'list_credentials', arguments: {} },
        },
      };
      const creatorBody = new Body(
        {
          ...config,
          accessPolicy: 'creator',
          externalMcpCapabilities: ['squire-credential-use'],
        },
        newIdentity('operator'),
        newIdentity('agent'),
      );
      const everyoneBody = new Body(
        {
          ...config,
          accessPolicy: 'everyone',
          externalMcpCapabilities: ['squire-credential-use'],
        },
        newIdentity('operator'),
        newIdentity('agent'),
      );
      await expect(
        Reflect.get(creatorBody, 'handleRoomPermissionRequest').call(
          creatorBody,
          'room-1',
          safeRequest,
        ),
      ).resolves.toBe('allow');
      await expect(
        Reflect.get(everyoneBody, 'handleRoomPermissionRequest').call(
          everyoneBody,
          'room-1',
          safeRequest,
        ),
      ).resolves.toBe('reject');

      const govern = vi.spyOn(creatorBody as never, 'handleGovernedSquirePermission' as never);
      const credentialRequest = {
        toolCall: {
          kind: 'other',
          title: 'mcp__squire__use_credential',
          rawInput: {
            server: 'squire',
            tool: 'use_credential',
            arguments: {
              service: 'github',
              http: { method: 'GET', url: 'https://api.github.com/user' },
            },
          },
        },
      };
      await expect(
        Reflect.get(creatorBody, 'handleRoomPermissionRequest').call(
          creatorBody,
          'room-1',
          credentialRequest,
        ),
      ).resolves.toBe('allow');
      expect(govern).not.toHaveBeenCalled();
      await expect(
        Reflect.get(creatorBody, 'handleRoomPermissionRequest').call(creatorBody, 'room-1', {
          toolCall: {
            kind: 'other',
            title: 'mcp__squire__delete_vault',
            rawInput: { server: 'squire', tool: 'delete_vault', arguments: {} },
          },
        }),
      ).resolves.toBe('reject');
    });

    it('keeps the creator-scoped Squire standing mandate in corners', async () => {
      const body = new Body(
        { ...config, accessPolicy: 'creator', externalMcpCapabilities: ['squire-app-access'] },
        newIdentity('operator'),
        newIdentity('agent'),
      );
      const govern = vi
        .spyOn(body as never, 'handleGovernedSquirePermission' as never)
        .mockResolvedValue('allow' as never);
      const request = {
        sessionId: 'corner-session',
        toolCall: {
          toolCallId: 'tool-1',
          kind: 'other',
          title: 'mcp__squire__grant_app_access',
          rawInput: {
            server: 'squire',
            tool: 'grant_app_access',
            arguments: { service: 'github', rate_limit_per_hour: 20 },
          },
        },
      };
      const handler = Reflect.get(body, 'cornerPermissionHandler').call(
        body,
        '/worktree',
        ['/protected'],
        ['/worktree'],
        'corner-1',
      );
      await expect(handler(request)).resolves.toBe('allow');
      expect(govern).not.toHaveBeenCalled();
    });

    it('accepts only the first current human-owner P1 decision for Squire', async () => {
      const agent = newIdentity('squire-agent');
      const owner = newIdentity('squire-owner');
      const rogueAgent = newIdentity('squire-rogue-agent');
      const body = new Body(config, newIdentity('operator'), agent);
      const now = Math.floor(Date.now() / 1_000) - 10;
      const scope = {
        type: 'operation.execute' as const,
        connectorId: 'squire',
        tool: 'use_credential',
        argumentsDigest: 'a'.repeat(64),
        target: 'GET https://api.github.com/user via service:github',
        risk: 'out-of-scope' as const,
      };
      const value: PermissionRequestV1 = {
        version: 1,
        permissionId: '11111111-1111-4111-8111-111111111111',
        roomId: 'room-1',
        workspaceId: 'workspace-1',
        requesterAgentPubkey: agent.publicKey,
        audience: 'owner',
        summary: 'Use the exact GitHub credential call',
        scope,
        provenance: {
          immediateTurnEventId: '1'.repeat(64),
          rootEventId: '2'.repeat(64),
        },
        requestedAt: now,
        requestExpiresAt: now + 600,
      };
      const request = parsePermissionRequest(
        buildPermissionRequest(agent, value, [owner.publicKey]),
      )!;
      const decision = (
        signer: ReturnType<typeof newIdentity>,
        verdict: 'grant' | 'deny',
        decidedAt: number,
      ) =>
        parsePermissionDecision(
          buildPermissionDecision(signer, request, {
            version: 1,
            permissionId: value.permissionId,
            requestEventId: request.event.id,
            decision: verdict,
            decidedAt,
            ...(verdict === 'grant'
              ? { grant: defaultPermissionGrantEnvelope(scope, decidedAt) }
              : {}),
          }),
          request,
        )!;
      const rogue = decision(rogueAgent, 'grant', now + 1);
      const deny = decision(owner, 'deny', now + 2);
      const laterGrant = decision(owner, 'grant', now + 3);
      const reader: PermissionFreshReader = {
        readEvent: async () => undefined,
        isRegisteredAgent: async (pubkey) =>
          pubkey === agent.publicKey || pubkey === rogueAgent.publicKey,
        isRoomMember: async () => true,
        isWorkspaceMember: async () => true,
        roleForRoom: async (_roomId, pubkey) => (pubkey === owner.publicKey ? 'owner' : 'member'),
        hasDeviceCustody: async (pubkey) => pubkey === owner.publicKey,
        permissionHistory: async () => [],
      };
      Reflect.set(body, 'permissionReader', reader);

      await expect(
        Reflect.get(body, 'firstGovernedSquireDecision').call(body, request, [
          laterGrant.event,
          rogue.event,
          deny.event,
        ]),
      ).resolves.toEqual(deny);
    });

    it('records an explicitly failed Squire tool result as failed', async () => {
      const body = new Body(config, newIdentity('operator'), newIdentity('agent'));
      const revoke = vi.fn();
      Reflect.set(body, 'squireBroker', { revoke });
      const runtime = Reflect.get(body, 'permissionRuntime');
      const complete = vi.spyOn(runtime, 'complete').mockResolvedValue({ status: 'succeeded' });
      const execution = {
        action: {
          roomId: 'room-1',
          scope: {
            type: 'operation.execute',
            connectorId: 'squire',
            tool: 'use_credential',
            argumentsDigest: 'a'.repeat(64),
          },
        },
      };
      Reflect.get(body, 'governedToolExecutions').set('session-1\0tool-1', {
        execution,
        brokerAuthorizationId: 'broker-auth-1',
      });
      const client = new AcpClient({ agentBinary: '/nonexistent', agentEnv: {} });
      const unsubscribe = Reflect.get(body, 'attachGovernedToolCompletion').call(body, client);

      client.emit('session/update', {
        sessionId: 'session-1',
        update: { sessionUpdate: 'tool_result', toolCallId: 'tool-1', status: 'failed' },
      });

      await vi.waitFor(() =>
        expect(complete).toHaveBeenCalledWith(
          expect.objectContaining({ status: 'failed', result: 'squire:use_credential:failed' }),
        ),
      );
      expect(revoke).toHaveBeenCalledWith('room-1', 'broker-auth-1');
      unsubscribe();
    });

    it('finalizes a pending Squire action before every managed-session stop', async () => {
      const body = new Body(config, newIdentity('operator'), newIdentity('agent'));
      const revokeAuthorizations = vi.fn();
      Reflect.set(body, 'squireBroker', { revokeAuthorizations });
      const runtime = Reflect.get(body, 'permissionRuntime');
      const complete = vi.spyOn(runtime, 'complete').mockResolvedValue({ status: 'succeeded' });
      const execution = {
        action: {
          roomId: 'room-2',
          scope: {
            type: 'operation.execute',
            connectorId: 'squire',
            tool: 'grant_app_access',
            argumentsDigest: 'b'.repeat(64),
          },
        },
      };
      Reflect.get(body, 'governedToolExecutions').set('session-2\0tool-2', { execution });
      const stop = vi.fn(async () => undefined);
      const session = {
        channelId: 'room-2',
        sessionId: 'session-2',
        client: { isAlive: true, stop },
      };

      await Reflect.get(body, 'stopManagedSession').call(body, session);

      expect(complete).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'unknown',
          result: 'squire:session-ended-before-terminal-update',
        }),
      );
      expect(complete.mock.invocationCallOrder[0]).toBeLessThan(stop.mock.invocationCallOrder[0]);
      expect(revokeAuthorizations).toHaveBeenCalledWith(session.channelId);
    });

    it('retries a terminal receipt after relay failure, teardown, and restart', async () => {
      const root = mkdtempSync(join(tmpdir(), 'squire-receipt-outbox-'));
      const statePath = join(root, 'state.json');
      const agent = newIdentity('receipt-agent');
      const receipt = signEvent(
        {
          pubkey: agent.publicKey,
          created_at: 1_700_000_000,
          kind: 9,
          tags: [['t', 'factory-permission-execution']],
          content: JSON.stringify({ status: 'failed' }),
        },
        agent.secretKey,
      );
      const failedPublish = vi.fn(async () => {
        throw new Error('relay unavailable');
      });
      const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      try {
        const first = new Body(config, undefined, agent, {
          statePath,
          publishPermissionReceipt: failedPublish,
        });
        await Reflect.get(first, 'publishTerminalPermissionReceipt').call(first, receipt);
        await first.dispose();
        expect(failedPublish).toHaveBeenCalled();

        const delivered: NostrEvent[] = [];
        const restarted = new Body(config, undefined, agent, {
          statePath,
          publishPermissionReceipt: async (event) => {
            delivered.push(event);
          },
        });
        await vi.waitFor(() => expect(delivered.map((event) => event.id)).toEqual([receipt.id]));
        await restarted.dispose();
      } finally {
        error.mockRestore();
        rmSync(root, { recursive: true, force: true });
      }
    });

    it('fails closed before launch when Squire cannot use an isolated governable harness', async () => {
      const root = mkdtempSync(join(tmpdir(), 'squire-launch-boundary-'));
      try {
        const operatorHome = join(root, 'operator');
        mkdirSync(join(operatorHome, '.config/trusty-squire'), { recursive: true });
        const squireConfigRoot = join(root, 'runtime', 'squire-config');
        mkdirSync(join(squireConfigRoot, 'trusty-squire'), { recursive: true });
        const sessionBus = join(root, 'run', 'bus');
        mkdirSync(join(root, 'run'), { recursive: true });
        const alternateConfig = join(root, 'alternate-xdg');
        const unsupported = new Body({
          ...config,
          externalMcpCapabilities: ['squire-credential-use'],
          agentKind: 'pi',
          agentHomeRoot: join(root, 'pi-home'),
          operatorHome,
        });
        await expect(Reflect.get(unsupported, 'sessionAgentEnv').call(unsupported)).rejects.toThrow(
          /Codex or Claude/,
        );

        const ambient = new Body({
          ...config,
          agentKind: 'codex',
          operatorHome,
        });
        await expect(Reflect.get(ambient, 'sessionAgentEnv').call(ambient)).rejects.toThrow(
          /isolated agent home/,
        );

        const blockedHome = join(root, 'blocked-home');
        writeFileSync(blockedHome, 'not a directory');
        const unprovisioned = new Body({
          ...config,
          agentKind: 'claude',
          agentHomeRoot: blockedHome,
          operatorHome,
          bwrapPath: '/usr/bin/bwrap',
          squireConfigRoot,
        });
        await expect(
          Reflect.get(unprovisioned, 'sessionAgentEnv').call(unprovisioned),
        ).rejects.toThrow();

        const isolatedRoot = join(root, 'codex-home');
        const unwrapped = new Body({
          ...config,
          agentKind: 'codex',
          agentHomeRoot: isolatedRoot,
          operatorHome,
        });
        await expect(Reflect.get(unwrapped, 'sessionAgentEnv').call(unwrapped)).rejects.toThrow(
          /bubblewrap credential-mask boundary/,
        );

        const supported = new Body({
          ...config,
          agentKind: 'codex',
          agentHomeRoot: isolatedRoot,
          operatorHome,
          bwrapPath: '/usr/bin/bwrap',
          squireConfigRoot,
          agentEnv: {
            ...config.agentEnv,
            XDG_CONFIG_HOME: alternateConfig,
            DBUS_SESSION_BUS_ADDRESS: `unix:path=${sessionBus}`,
            DBUS_STARTER_ADDRESS: `unix:path=${sessionBus}`,
            DBUS_STARTER_BUS_TYPE: 'session',
          },
        });
        const supportedEnv = await Reflect.get(supported, 'sessionAgentEnv').call(supported);
        expect(supportedEnv).toMatchObject({ CODEX_HOME: join(isolatedRoot, 'codex') });
        expect(supportedEnv).not.toHaveProperty('DBUS_SESSION_BUS_ADDRESS');
        expect(supportedEnv).not.toHaveProperty('DBUS_STARTER_ADDRESS');
        const masks = Reflect.get(supported, 'sandboxCredentialMaskPaths').call(supported);
        expect(masks).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ path: join(squireConfigRoot, 'trusty-squire') }),
            // The daemon creates every legacy store mountpoint — including
            // the XDG_CONFIG_HOME variant — before computing the mask plan
            // (see sessionAgentEnv's trustySquireLegacyStorePaths loop), so
            // this one is an existing directory, not a missing one to create.
            expect.objectContaining({
              path: join(alternateConfig, 'trusty-squire'),
              kind: 'dir',
            }),
            expect.objectContaining({ path: sessionBus, create: true }),
          ]),
        );

        const abstractBus = new Body({
          ...config,
          agentKind: 'codex',
          agentHomeRoot: join(root, 'abstract-bus-home'),
          operatorHome,
          bwrapPath: '/usr/bin/bwrap',
          squireConfigRoot,
          agentEnv: {
            ...config.agentEnv,
            DBUS_SESSION_BUS_ADDRESS: 'unix:abstract=/tmp/dbus-session',
          },
        });
        await expect(Reflect.get(abstractBus, 'sessionAgentEnv').call(abstractBus)).rejects.toThrow(
          /session IPC cannot be masked safely/,
        );
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it.each(['legacy-store', 'ambient-config'] as const)(
      'scrubs %s Squire state without requiring a governed store',
      async (legacyShape) => {
        const root = mkdtempSync(join(tmpdir(), 'squire-legacy-scrub-'));
        try {
          const operatorHome = join(root, 'operator');
          mkdirSync(join(operatorHome, '.codex'), { recursive: true });
          writeFileSync(join(operatorHome, '.codex/auth.json'), '{"test":"opaque"}');
          if (legacyShape === 'legacy-store') {
            mkdirSync(join(operatorHome, '.config/trusty-squire'), { recursive: true });
          }
          writeFileSync(
            join(operatorHome, '.codex/config.toml'),
            legacyShape === 'ambient-config'
              ? [
                  '[mcp_servers.squire]',
                  'command = "npx"',
                  'args = ["-y", "@trusty-squire/mcp"]',
                  '',
                  '[mcp_servers.project_tools]',
                  'command = "project-tools"',
                ].join('\n')
              : '[mcp_servers.project_tools]\ncommand = "project-tools"\n',
          );
          const agentHomeRoot = join(root, 'agent-home');
          const squireConfigRoot = join(root, 'runtime', 'squire-host-config');
          const body = new Body({
            ...config,
            agentBinary: '/bin/true',
            agentCommand: '/bin/true',
            externalMcpCapabilities: [],
            agentKind: 'codex',
            agentHomeRoot,
            operatorHome,
            bwrapPath: '/usr/bin/bwrap',
            squireConfigRoot,
          });

          const sessionEnv = await Reflect.get(body, 'sessionAgentEnv').call(body);
          expect(sessionEnv).toMatchObject({
            CODEX_HOME: join(agentHomeRoot, 'codex'),
          });
          const spawnCommand = await Reflect.get(body, 'sessionSpawnCommand').call(
            body,
            { mode: 'readonly', cwd: root },
            sessionEnv,
          );
          expect(spawnCommand.command).toBe('/usr/bin/bwrap');
          expect(spawnCommand.args).toContain('--unshare-pid');
          expect(spawnCommand.args).toContain(join(agentHomeRoot, 'codex'));
          expect(existsSync(squireConfigRoot)).toBe(true);
          // The masked-argv shape is asserted above unconditionally; actually
          // executing it needs a host that can build the namespace at all
          // (see `bwrapExecutionViable`), which the product's own start-up
          // probe would likewise refuse to rely on.
          if (bwrapExecutionViable) {
            const launched = spawnSync(spawnCommand.command, spawnCommand.args, {
              cwd: root,
              env: sessionEnv,
              encoding: 'utf8',
            });
            expect({
              status: launched.status,
              signal: launched.signal,
              stderr: launched.stderr,
            }).toEqual({ status: 0, signal: null, stderr: '' });
          }
          expect(readlinkSync(join(agentHomeRoot, 'codex/auth.json'))).toBe(
            join(operatorHome, '.codex/auth.json'),
          );
          const isolatedConfig = readFileSync(join(agentHomeRoot, 'codex/config.toml'), 'utf8');
          expect(isolatedConfig).toContain('[mcp_servers.project_tools]');
          expect(isolatedConfig).not.toContain('[mcp_servers.squire]');
          expect(Reflect.get(body, 'sandboxCredentialMaskPaths').call(body)).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                path: join(operatorHome, '.config/trusty-squire'),
                kind: 'dir',
              }),
              expect.objectContaining({
                path: join(squireConfigRoot, 'trusty-squire'),
                kind: 'dir',
              }),
            ]),
          );

          const governed = new Body({
            ...config,
            externalMcpCapabilities: ['squire-credential-use'],
            agentKind: 'codex',
            agentHomeRoot: join(root, 'governed-agent-home'),
            operatorHome,
            bwrapPath: '/usr/bin/bwrap',
            squireConfigRoot,
          });
          await expect(Reflect.get(governed, 'sessionAgentEnv').call(governed)).rejects.toThrow(
            /storage or IPC boundary/,
          );
        } finally {
          rmSync(root, { recursive: true, force: true });
        }
      },
    );

    it('treats legacy Squire state as isolation-only for Pi while governed Pi fails closed', async () => {
      const root = mkdtempSync(join(tmpdir(), 'squire-legacy-pi-'));
      try {
        const operatorHome = join(root, 'operator');
        mkdirSync(join(operatorHome, '.config/trusty-squire'), { recursive: true });
        const squireConfigRoot = join(root, 'runtime', 'squire-host-config');
        const isolated = new Body({
          ...config,
          agentBinary: '/bin/true',
          agentCommand: '/bin/true',
          agentKind: 'pi',
          externalMcpCapabilities: [],
          agentHomeRoot: join(root, 'pi-home'),
          operatorHome,
          bwrapPath: '/usr/bin/bwrap',
          squireConfigRoot,
        });
        const env = await Reflect.get(isolated, 'sessionAgentEnv').call(isolated);
        const spawnCommand = await Reflect.get(isolated, 'sessionSpawnCommand').call(
          isolated,
          { mode: 'readonly', cwd: root },
          env,
        );
        // See `bwrapExecutionViable`: only actually run the sandboxed command
        // on a host that can build the namespace at all.
        if (bwrapExecutionViable) {
          const launched = spawnSync(spawnCommand.command, spawnCommand.args, {
            cwd: root,
            env,
            encoding: 'utf8',
          });
          expect({
            status: launched.status,
            signal: launched.signal,
            stderr: launched.stderr,
          }).toEqual({ status: 0, signal: null, stderr: '' });
        }
        expect(spawnCommand.args).toContain('--unshare-pid');

        const governed = new Body({
          ...config,
          agentKind: 'pi',
          externalMcpCapabilities: ['squire-credential-use'],
          agentHomeRoot: join(root, 'governed-pi-home'),
          operatorHome,
          bwrapPath: '/usr/bin/bwrap',
          squireConfigRoot,
        });
        await expect(Reflect.get(governed, 'sessionAgentEnv').call(governed)).rejects.toThrow(
          /Codex or Claude harness/,
        );
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it('reserves an empty legacy Squire mask mountpoint idempotently across activations', async () => {
      const root = mkdtempSync(join(tmpdir(), 'squire-legacy-concurrent-'));
      try {
        const operatorHome = join(root, 'operator');
        mkdirSync(join(operatorHome, '.config/trusty-squire'), { recursive: true });
        const squireConfigRoot = join(root, 'runtime', 'squire-host-config');
        const makeBody = (name: string) =>
          new Body({
            ...config,
            agentKind: 'pi',
            externalMcpCapabilities: [],
            agentHomeRoot: join(root, name),
            operatorHome,
            bwrapPath: '/usr/bin/bwrap',
            squireConfigRoot,
          });
        const first = makeBody('first');
        const second = makeBody('second');

        await expect(
          Promise.all([
            Reflect.get(first, 'sessionAgentEnv').call(first),
            Reflect.get(second, 'sessionAgentEnv').call(second),
          ]),
        ).resolves.toHaveLength(2);
        expect(readdirSync(join(squireConfigRoot, 'trusty-squire'))).toEqual([]);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it('keeps the owned Squire store isolated after capability removal and downgrade', async () => {
      const root = mkdtempSync(join(tmpdir(), 'squire-owned-store-boundary-'));
      try {
        const operatorHome = join(root, 'operator');
        const squireConfigRoot = join(root, 'beeline', 'squire-host-config');
        mkdirSync(join(squireConfigRoot, 'trusty-squire'), { recursive: true });
        writeFileSync(join(squireConfigRoot, 'trusty-squire/credential-state.json'), '{}');

        const removed = new Body({
          ...config,
          externalMcpCapabilities: [],
          agentKind: 'codex',
          agentHomeRoot: join(root, 'codex-home'),
          operatorHome,
          squireConfigRoot,
        });
        await expect(Reflect.get(removed, 'sessionAgentEnv').call(removed)).rejects.toThrow(
          /bubblewrap credential-mask boundary/,
        );

        const downgraded = new Body({
          ...config,
          externalMcpCapabilities: [],
          agentKind: 'pi',
          agentHomeRoot: join(root, 'pi-home'),
          operatorHome,
          bwrapPath: '/usr/bin/bwrap',
          squireConfigRoot,
        });
        await expect(Reflect.get(downgraded, 'sessionAgentEnv').call(downgraded)).rejects.toThrow(
          /Codex or Claude/,
        );

        const isolated = new Body({
          ...config,
          externalMcpCapabilities: [],
          agentKind: 'claude',
          agentHomeRoot: join(root, 'claude-home'),
          operatorHome,
          bwrapPath: '/usr/bin/bwrap',
          squireConfigRoot,
        });
        await expect(
          Reflect.get(isolated, 'sessionAgentEnv').call(isolated),
        ).resolves.toMatchObject({ CLAUDE_CONFIG_DIR: join(root, 'claude-home', 'claude') });
        expect(Reflect.get(isolated, 'sandboxCredentialMaskPaths').call(isolated)).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ path: join(squireConfigRoot, 'trusty-squire') }),
          ]),
        );
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });

  it('refuses to collapse the agent onto the operator identity', () => {
    const operator = newIdentity('operator');
    const body = new Body(config, operator);
    expect(() => body.setAgentIdentity(operator)).toThrow('must be distinct');
  });

  it('provisions a Room without spawning its ACP process until the first turn', async () => {
    const scheduler = new SessionScheduler({ maxLiveSessions: 4, idleMs: 60_000 });
    const run = vi.spyOn(scheduler, 'run');
    const body = new Body(
      {
        ...config,
        agentCommand: '/usr/local/bin/grok',
        agentArgs: ['agent', 'stdio'],
        readonlyMcpCommand: '/buzz-readonly-mcp',
        readonlyMcpArgs: [],
      },
      newIdentity('operator'),
      newIdentity('agent'),
      { scheduler },
    );
    vi.spyOn(body as never, 'ensureAgentInChannel' as never).mockResolvedValue(undefined as never);
    vi.spyOn(body as never, 'ensureAgentEntity' as never).mockResolvedValue(undefined as never);
    vi.spyOn(body as never, 'channelCommunityId' as never).mockResolvedValue(null as never);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ accepted: true }), { status: 200 })),
    );

    const session = await body.provision('room-id', { repo: 'repo', localPath: '/paired/repo' });

    // Eagerly activating every provisioned Room used to spawn N ACP processes
    // at startup and immediately evict most of them.
    expect(run).not.toHaveBeenCalled();
    expect(session.sessionId).toBe('');
    expect(session.lifecycle?.idleMs).toBe(GROK_WARM_SESSION_IDLE_MS);

    let activations = 0;
    session.lifecycle = {
      activate: async () => {
        activations += 1;
        return 'physical-1';
      },
      suspend: async () => undefined,
    };
    await body.ensureSessionReady('room-id');

    expect(activations).toBe(1);
    expect(run).toHaveBeenCalledWith(
      'room-id',
      expect.anything(),
      expect.any(Function),
      expect.objectContaining({ priority: 'interactive', roomKey: 'room-id' }),
    );
    await scheduler.dispose();
  });

  it('budgets a corner against its parent Room, not as its own Room', async () => {
    const scheduler = new SessionScheduler({ maxLiveSessions: 4, idleMs: 60_000 });
    const run = vi.spyOn(scheduler, 'run');
    const body = new Body(config, newIdentity('operator'), newIdentity('agent'), {
      scheduler,
    });
    const client = new AcpClient({ agentBinary: '/nonexistent', agentEnv: {} });
    const corner = {
      channelId: 'corner-1',
      sessionId: 'corner-session',
      client,
      mode: 'edit' as const,
      parentChannelId: 'room-a',
      lifecycle: { activate: async () => 'physical-1', suspend: async () => undefined },
    };
    body.registerSession(corner);

    await (
      Reflect.get(body, 'runOnSession') as (
        session: unknown,
        task: () => Promise<void>,
      ) => Promise<void>
    ).call(body, corner, async () => undefined);

    expect(run).toHaveBeenCalledWith(
      'corner-1',
      expect.anything(),
      expect.any(Function),
      expect.objectContaining({ priority: 'background', roomKey: 'room-a' }),
    );
    await scheduler.dispose();
  });

  it('mounts only the release-owned read and Beeline tool servers when provisioning a Room', async () => {
    const body = new Body({
      ...config,
      readonlyMcpCommand: '/buzz-readonly-mcp',
      readonlyMcpArgs: ['--fixed-entrypoint'],
    });
    const client = new AcpClient({ agentBinary: '/nonexistent', agentEnv: {} });
    const session = {
      channelId: 'room-id',
      sessionId: 'readonly-session',
      client,
      mode: 'readonly' as const,
    };
    vi.spyOn(body as never, 'ensureAgentInChannel' as never).mockResolvedValue(undefined as never);
    vi.spyOn(body as never, 'ensureAgentEntity' as never).mockResolvedValue(undefined as never);
    vi.spyOn(body as never, 'channelCommunityId' as never).mockResolvedValue(null as never);
    const create = vi
      .spyOn(body as never, 'createManagedSession' as never)
      .mockResolvedValue(session as never);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ accepted: true }), { status: 200 })),
    );

    await expect(
      body.provision('room-id', { repo: 'repo', localPath: '/paired/repo' }),
    ).resolves.toBe(session);

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: 'room-id',
        mode: 'readonly',
        autoApprovePermissions: false,
        mcpServers: [
          {
            name: 'buzz-readonly-mcp',
            command: '/buzz-readonly-mcp',
            args: ['--fixed-entrypoint'],
            env: [{ name: 'BUZZ_READONLY_ROOT', value: '/paired/repo' }],
          },
          expect.objectContaining({
            name: 'beeline-agent-tools',
            command: process.execPath,
            env: [],
          }),
        ],
      }),
    );
    const systemPrompt = create.mock.calls[0]![0].systemPrompt;
    expect(systemPrompt).toContain(
      'Read-only means the repository is visible but cannot be changed',
    );
    expect(systemPrompt).toContain(
      'Never tell a Room member that you cannot view the repository unless a buzz-readonly-mcp inspection call actually fails',
    );
    expect(JSON.stringify(create.mock.calls)).not.toContain('buzz-dev-mcp');
  });

  it('adds only the explicitly granted squire profile to a creator Room', async () => {
    const body = new Body({
      ...config,
      agentKind: 'codex',
      accessPolicy: 'creator',
      externalMcpCapabilities: ['squire-credential-use'],
      squireConfigRoot: join(tmpdir(), 'beeline-squire-config-unit'),
      readonlyMcpCommand: '/buzz-readonly-mcp',
    });
    vi.spyOn(body as never, 'ensureAgentInChannel' as never).mockResolvedValue(undefined as never);
    vi.spyOn(body as never, 'ensureAgentEntity' as never).mockResolvedValue(undefined as never);
    vi.spyOn(body as never, 'channelCommunityId' as never).mockResolvedValue(null as never);
    const create = vi.spyOn(body as never, 'createManagedSession' as never).mockResolvedValue({
      channelId: 'room-id',
      sessionId: 'readonly-session',
      client: new AcpClient({ agentBinary: '/nonexistent', agentEnv: {} }),
      mode: 'readonly',
    } as never);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ accepted: true }), { status: 200 })),
    );

    await body.provision('room-id', { repo: 'repo', localPath: '/paired/repo' });

    expect(create.mock.calls[0]![0].mcpServers[0]).toEqual({
      name: 'buzz-readonly-mcp',
      command: '/buzz-readonly-mcp',
      args: [],
      env: [{ name: 'BUZZ_READONLY_ROOT', value: '/paired/repo' }],
    });
    expect(create.mock.calls[0]![0].mcpServers[1]).toMatchObject({
      name: 'beeline-agent-tools',
      command: process.execPath,
      env: [],
    });
    expect(create.mock.calls[0]![0].mcpServers[2]).toMatchObject({
      name: 'squire',
      command: process.execPath,
      env: [],
    });
    expect(create.mock.calls[0]![0].mcpServers[2].args[0]).toContain('squire-mcp-proxy.js');
    expect(create.mock.calls[0]![0].mcpServers[2].args).not.toContain('@trusty-squire/mcp');
    await body.dispose();
  });

  it('fails a research Room closed when buzz-readonly-mcp is unresolved', async () => {
    const body = new Body({ ...config, workspaceRoot: '/tmp/buzzy-readonly-unavailable-unit' });
    stubEmptyAgentHistory(body);
    const open = vi.spyOn(body, 'openSubchannel');
    const create = vi.spyOn(body as never, 'createManagedSession' as never);
    const published: NostrEvent[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        published.push(JSON.parse(String(init?.body)) as NostrEvent);
        return new Response(JSON.stringify({ accepted: true }), { status: 200 });
      }),
    );

    await expect(
      Reflect.get(body, 'replyInRoom').call(
        body,
        'research-room',
        { repo: 'repo' },
        {
          eventId: 'research-request',
          authorPubkey: body.identity.publicKey,
          content: 'Research how session scheduling works.',
          createdAt: 1,
        },
      ),
    ).resolves.toEqual({ openedCorner: false, producedReply: true });

    expect(create).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    expect(body.listSessions()).toEqual([]);
    expect(published).toHaveLength(2);
    expect(published[0]!.tags).toContainEqual(['status', 'working']);
    expect(published[1]!.tags).toContainEqual(['status', 'complete']);
  });

  it('does no relay or session work when buzz-readonly-mcp is unresolved', async () => {
    const body = new Body({ ...config, workspaceRoot: '/tmp/buzzy-readonly-unavailable-unit' });
    const create = vi.spyOn(body as never, 'createManagedSession' as never);
    const relayRequest = vi.fn();
    vi.stubGlobal('fetch', relayRequest);

    await expect(body.provision('new-room')).rejects.toBeInstanceOf(ReadOnlyToolsUnavailableError);

    expect(relayRequest).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(body.listSessions()).toEqual([]);
  });

  it('never reuses an edit session as a read-only Room session', async () => {
    const body = new Body({ ...config, readonlyMcpCommand: '/buzz-readonly-mcp' });
    stubEmptyAgentHistory(body);
    const client = new AcpClient({ agentBinary: '/nonexistent', agentEnv: {} });
    body.registerSession({
      channelId: 'room-id',
      sessionId: 'edit-session',
      client,
      mode: 'edit',
    });
    const open = vi.spyOn(body, 'openSubchannel');
    const prompt = vi.spyOn(client, 'sessionPrompt');
    const published: NostrEvent[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        published.push(JSON.parse(String(init?.body)) as NostrEvent);
        return new Response(JSON.stringify({ accepted: true }), { status: 200 });
      }),
    );

    await expect(body.provision('room-id')).rejects.toBeInstanceOf(ReadOnlyToolsUnavailableError);
    await expect(
      Reflect.get(body, 'replyInRoom').call(
        body,
        'room-id',
        { repo: 'repo' },
        {
          eventId: 'research-request',
          authorPubkey: body.identity.publicKey,
          content: 'Explain how the scheduler works.',
          createdAt: 1,
        },
      ),
    ).resolves.toEqual({ openedCorner: false, producedReply: true });

    expect(prompt).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    expect(published).toHaveLength(2);
    expect(published[0]!.tags).toContainEqual(['status', 'working']);
    expect(published[1]!.tags).toContainEqual(['status', 'complete']);
  });

  it('NIP-98-authenticates repository safety reads as the agent', async () => {
    const operator = newIdentity('operator');
    const agent = newIdentity('agent');
    const roomId = '11111111-1111-4111-8111-111111111111';
    const authEvents: NostrEvent[] = [];
    const projection = (kind: number, members: string[]): NostrEvent =>
      signEvent(
        {
          pubkey: operator.publicKey,
          created_at: 1_700_000_000,
          kind,
          tags: [['d', roomId], ...members.map((pubkey) => ['p', pubkey])],
          content: '',
        },
        operator.secretKey,
      );

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const authorization = new Headers(init?.headers).get('authorization');
        if (!authorization?.startsWith('Nostr ')) {
          return new Response(JSON.stringify({ error: 'missing Nostr auth' }), { status: 401 });
        }
        const authEvent = JSON.parse(
          Buffer.from(authorization.slice('Nostr '.length), 'base64').toString('utf8'),
        ) as NostrEvent;
        authEvents.push(authEvent);
        expect(verifyEvent(authEvent)).toBe(true);
        expect(authEvent.pubkey).toBe(agent.publicKey);
        expect(authEvent.tags).toContainEqual(['u', String(input)]);
        expect(authEvent.tags).toContainEqual(['method', 'POST']);

        const filter = (JSON.parse(String(init?.body)) as Record<string, unknown>[])[0]!;
        const kind = (filter.kinds as number[])[0];
        const events = kind === 39002 ? [projection(39002, [agent.publicKey])] : [];
        return new Response(JSON.stringify(events), { status: 200 });
      }),
    );

    const body = new Body(config, operator, agent);
    await expect(
      body.assertRepositorySafety(roomId, { repo: 'local-repo', localOnly: true }),
    ).resolves.toBeUndefined();
    expect(authEvents.length).toBeGreaterThanOrEqual(2);
  });
});

describe('agent presence', () => {
  it('publishes signed online and offline markers as replaceable Room records', async () => {
    const agent = newIdentity('presence-agent');
    const published: NostrEvent[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        published.push(JSON.parse(String(init?.body)) as NostrEvent);
        return new Response(JSON.stringify({ accepted: true }), { status: 200 });
      }),
    );

    await postAgentPresence('presence-room', agent, 'online');
    await postAgentPresence('presence-room', agent, 'offline');

    expect(published).toHaveLength(2);
    expect(published.map((event) => event.kind)).toEqual([30078, 30078]);
    expect(published.map((event) => verifyEvent(event))).toEqual([true, true]);
    expect(published[0]!.tags).toEqual(
      expect.arrayContaining([
        ['h', 'presence-room'],
        ['d', 'agent-presence:presence-room'],
        ['t', 'agent-presence'],
        ['agent', agent.publicKey],
        ['status', 'online'],
      ]),
    );
    expect(published[1]!.tags).toContainEqual(['status', 'offline']);
  });

  it('heartbeats periodically and marks a clean stop offline', async () => {
    vi.useFakeTimers();
    const agent = newIdentity('heartbeat-agent');
    const statuses: string[] = [];
    const generations: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        const event = JSON.parse(String(init?.body)) as NostrEvent;
        statuses.push(event.tags.find((tag) => tag[0] === 'status')?.[1] ?? '');
        generations.push(event.tags.find((tag) => tag[0] === 'generation')?.[1] ?? '');
        return new Response(JSON.stringify({ accepted: true }), { status: 200 });
      }),
    );

    const stop = startAgentPresence('presence-room', agent, 1_000);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1_000);
    await stop();

    // A graceful stop goes QUIET — no offline marker. A planned restart inside
    // the 120s lease must be a non-event in every client, and a genuinely dead
    // daemon is still detected when the lease expires. See startAgentPresence.
    expect(statuses).toEqual(['online', 'online']);
    expect(new Set(generations)).toEqual(new Set([stop.generationId]));
    vi.useRealTimers();
  });

  it('switches availability offline during a failed Room poll and back online on recovery', async () => {
    const agent = newIdentity('recovery-presence-agent');
    const statuses: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        const event = JSON.parse(String(init?.body)) as NostrEvent;
        statuses.push(event.tags.find((tag) => tag[0] === 'status')?.[1] ?? '');
        return new Response(JSON.stringify({ accepted: true }), { status: 200 });
      }),
    );
    const presence = startAgentPresence('presence-room', agent, 60_000);
    await presence.setStatus('offline');
    await presence.setStatus('online');
    await presence();

    // Explicit setStatus('offline') (a relay outage outliving the lease) is
    // the only offline source; stop() itself publishes nothing.
    expect(statuses).toEqual(['online', 'offline', 'online']);
  });

  it('a planned restart is a non-event: the stop publishes nothing and a fresh daemon keeps the lease alive', async () => {
    // The owner-reported flicker (2026-08-23): every self-update restart
    // published an explicit offline marker, so every client flipped the agent
    // OFFLINE for the whole handover window. Now the old controller goes quiet,
    // the lease keeps the last `online` record valid, and the replacement
    // daemon's first heartbeat replaces it — no offline status ever on the wire.
    vi.useFakeTimers();
    const agent = newIdentity('restart-presence-agent');
    const statuses: string[] = [];
    const records: Array<{ status?: string; created_at: number }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        const event = JSON.parse(String(init?.body)) as NostrEvent;
        const status = event.tags.find((tag) => tag[0] === 'status')?.[1] ?? '';
        statuses.push(status);
        records.push({ status, created_at: event.created_at });
        return new Response(JSON.stringify({ accepted: true }), { status: 200 });
      }),
    );

    // Old daemon generation: one heartbeat, then a graceful stop.
    const oldPresence = startAgentPresence('presence-room', agent, 60_000);
    await vi.advanceTimersByTimeAsync(0);
    await oldPresence();
    expect(statuses).toEqual(['online']);

    // Restart handover takes some seconds; a NEW generation starts and its
    // first publish lands promptly.
    await vi.advanceTimersByTimeAsync(10_000);
    const newPresence = startAgentPresence('presence-room', agent, 60_000);
    expect(newPresence.generationId).not.toBe(oldPresence.generationId);
    await vi.advanceTimersByTimeAsync(0);

    expect(statuses).toEqual(['online', 'online']);
    // The reader's verdict at every instant across the boundary stays ONLINE:
    // the newest record is always within the 120s lease.
    const newest = records.at(-1)!;
    expect(newest.status).toBe('online');
    expect(
      isAgentPresenceOnline(
        { agentPubkey: agent.publicKey, status: 'online', observedAt: newest.created_at * 1_000 },
        Date.now(),
      ),
    ).toBe(true);
    await newPresence();
    vi.useRealTimers();
  });

  it('a genuinely dead daemon still reads offline once the lease expires after its last heartbeat', async () => {
    // Going quiet on stop must never become presence lying: with no further
    // publications, the reader's staleness window is what detects death, and
    // that bound is AGENT_PRESENCE_STALE_MS past the last record.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const agent = newIdentity('death-presence-agent');
    let lastRecord: { status?: string; created_at: number } | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        const event = JSON.parse(String(init?.body)) as NostrEvent;
        lastRecord = {
          status: event.tags.find((tag) => tag[0] === 'status')?.[1],
          created_at: event.created_at,
        };
        return new Response(JSON.stringify({ accepted: true }), { status: 200 });
      }),
    );

    const presence = startAgentPresence('presence-room', agent, 60_000);
    await vi.advanceTimersByTimeAsync(0);
    await presence(); // daemon dies here; nothing further is published

    const publishedCount = vi.mocked(fetch).mock.calls.length;
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(vi.mocked(fetch).mock.calls.length).toBe(publishedCount);

    expect(lastRecord?.status).toBe('online');
    const observedAt = lastRecord!.created_at * 1_000;
    expect(
      isAgentPresenceOnline(
        { agentPubkey: agent.publicKey, status: 'online', observedAt },
        observedAt + AGENT_PRESENCE_STALE_MS,
      ),
    ).toBe(true);
    expect(
      isAgentPresenceOnline(
        { agentPubkey: agent.publicKey, status: 'online', observedAt },
        observedAt + AGENT_PRESENCE_STALE_MS + 1,
      ),
    ).toBe(false);
    vi.useRealTimers();
  });

  /**
   * `stop()` drains any in-flight backoff before it resolves (it no longer
   * publishes an offline marker), so under fake timers it must be advanced,
   * not merely awaited — awaiting it directly deadlocks the test and leaks
   * fake timers into the next one.
   */
  const stopUnderFakeTimers = async (presence: { (): Promise<void> }): Promise<void> => {
    const stopping = presence();
    await vi.advanceTimersByTimeAsync(2 * AGENT_PRESENCE_HEARTBEAT_MS);
    await stopping;
  };

  it('retries a relay quota rejection instead of spending a whole lease slice on it', async () => {
    // 429 is not in publishEvent's retryable set (5xx/network only), so the
    // heartbeat used to be logged and dropped — and two dropped heartbeats at
    // the 45s cadence exceed the 120s lease, which is a live daemon reading
    // as offline in every client until the quota window clears.
    vi.useFakeTimers();
    const agent = newIdentity('quota-presence-agent');
    let attempts = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        attempts += 1;
        if (attempts === 1) {
          return new Response(
            JSON.stringify({ error: 'rate-limited: quota exceeded; retry in 1s' }),
            { status: 429 },
          );
        }
        return new Response(JSON.stringify({ accepted: true }), { status: 200 });
      }),
    );

    const published: string[] = [];
    const presence = startAgentPresence('presence-room', agent, 60_000, (status) =>
      published.push(status),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(published).toEqual([]);
    // The relay's own advertised delay is honoured, plus jitter (<=1.25x).
    await vi.advanceTimersByTimeAsync(2_000);
    expect(published).toEqual(['online']);

    await stopUnderFakeTimers(presence);
    vi.useRealTimers();
  });

  it('stamps a retried heartbeat when it is published, not when it was enqueued', async () => {
    // A stamp from before the retry would land already past its 120s lease and
    // become the newest replaceable record — a delivered heartbeat that reads
    // as expired, which is the "still offline after presence recovered" shape.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const agent = newIdentity('stamp-presence-agent');
    const stamps: number[] = [];
    let attempts = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        attempts += 1;
        if (attempts === 1) {
          return new Response(JSON.stringify({ error: 'retry in 4s' }), { status: 429 });
        }
        stamps.push((JSON.parse(String(init?.body)) as NostrEvent).created_at);
        return new Response(JSON.stringify({ accepted: true }), { status: 200 });
      }),
    );

    const enqueuedAt = Math.floor(Date.now() / 1_000);
    const presence = startAgentPresence('presence-room', agent, 60_000);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(6_000);

    expect(stamps).toHaveLength(1);
    expect(stamps[0]).toBeGreaterThanOrEqual(enqueuedAt + 3);

    await stopUnderFakeTimers(presence);
    vi.useRealTimers();
  });

  it('coalesces a heartbeat that fires while another is still retrying', async () => {
    // Presence is a REPLACEABLE record: only the latest matters, so queueing
    // ticks behind a retry just spends more of the quota that rejected them.
    vi.useFakeTimers();
    const agent = newIdentity('coalesce-presence-agent');
    let attempts = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        attempts += 1;
        return new Response(JSON.stringify({ error: 'rate-limited' }), { status: 429 });
      }),
    );

    const presence = startAgentPresence('presence-room', agent, 60_000);
    // Nine heartbeats restate 'online' while the first is still backing off —
    // exactly what the interval tick does, driven explicitly so the assertion
    // does not depend on where the jittered delays happen to land.
    for (let tick = 0; tick < 9; tick += 1) void presence.setStatus('online');
    await vi.advanceTimersByTimeAsync(9_000);

    // Each restates the status already being published, so the whole window
    // costs one bounded retry run — not ten queued publishes against the very
    // quota that is rejecting them.
    expect(attempts).toBeLessThanOrEqual(AGENT_PRESENCE_RETRY_MAX_ATTEMPTS);

    await stopUnderFakeTimers(presence);
    vi.useRealTimers();
  });
});

describe('agentPresenceRetryDelayMs', () => {
  it('grows exponentially and stays inside a bounded jitter band', () => {
    expect(agentPresenceRetryDelayMs(1, undefined, () => 0.5)).toBe(1_000);
    expect(agentPresenceRetryDelayMs(2, undefined, () => 0.5)).toBe(2_000);
    expect(agentPresenceRetryDelayMs(3, undefined, () => 0.5)).toBe(4_000);
    // Jitter is +/-25% of the exponential term, never zero and never doubling.
    expect(agentPresenceRetryDelayMs(1, undefined, () => 0)).toBe(750);
    expect(agentPresenceRetryDelayMs(1, undefined, () => 0.999)).toBeLessThanOrEqual(1_250);
  });

  it("honours the relay's own advertised delay over a shorter exponential term", () => {
    const rateLimited = new Error('HTTP 429 {"error":"rate-limited; retry in 6s"}');
    expect(agentPresenceRetryDelayMs(1, rateLimited, () => 0.5)).toBe(6_000);
  });

  it('never waits longer than one heartbeat interval, whatever the relay asks', () => {
    const absurd = new Error('HTTP 429 {"error":"retry in 600s"}');
    expect(agentPresenceRetryDelayMs(4, absurd, () => 0.999)).toBe(AGENT_PRESENCE_HEARTBEAT_MS);
  });
});

describe('Room poll resilience', () => {
  it('backs off one Room independently and resets immediately after a successful poll', () => {
    // Jitter pinned at its midpoint so the schedule itself is visible; the
    // spreading it provides is covered in `presence-truth.test.ts`.
    const midpoint = () => 0.5;
    const backoff = new RoomPollBackoff(1_000, 4_000, undefined, undefined, midpoint);
    expect(backoff.failed()).toBe(1_000);
    expect(backoff.failed()).toBe(2_000);
    expect(backoff.failed()).toBe(4_000);
    expect(backoff.failed()).toBe(4_000);
    expect(backoff.recovered()).toBe(true);
    expect(backoff.failed()).toBe(1_000);
  });

  it('honors repeated relay 429 retry-after hints, then reaches a minutes-long cap', () => {
    const backoff = new RoomPollBackoff(1_000, undefined, undefined, undefined, () => 0.5);
    const rateLimited = new Error('HTTP 429 {"error":"rate-limited: quota exceeded; retry in 2s"}');

    // A relay-advertised delay is an instruction, not a schedule, so it is
    // taken exactly and never jittered downward.
    expect(backoff.failed(rateLimited)).toBe(2_000);
    expect(backoff.failed(rateLimited)).toBe(2_000);
    expect(backoff.failed(rateLimited)).toBe(4_000);
    for (let failures = 0; failures < 20; failures++) backoff.failed(rateLimited);
    expect(backoff.failed(rateLimited)).toBe(ROOM_POLL_FAILURE_BACKOFF_CAP_MS);
  });

  it('delegates repository Room discovery to the push transport instead of a poll interval', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ accepted: true }))),
    );
    const body = new Body(
      {
        agentBinary: '/nonexistent',
        mcpBinary: '/nonexistent',
        agentEnv: {},
        workspaceRoot: '/tmp/buzzy-ws-loop',
        relayBaseUrl: 'http://relay.test',
        relayHost: 'relay.test',
        relayScheme: 'http',
        relayWsUrl: 'ws://relay.test',
        autoApprovePermissions: true,
      },
      newIdentity('ws-operator'),
      newIdentity('ws-agent'),
    );
    vi.spyOn(body, 'assertRepositorySafety').mockResolvedValue(undefined);
    vi.spyOn(body, 'provision').mockResolvedValue({} as never);
    vi.spyOn(body, 'restoreSubchannels').mockResolvedValue(undefined);
    const pushLoop = vi.spyOn(body as never, 'runRoomPushLoop').mockResolvedValue(undefined);
    const poll = vi.spyOn(body, 'pollChannelRequests');

    await body.runRepositoryRoomLoop('workspace', 'room', {
      repo: 'repo',
      repositoryKey: 'repo',
      localOnly: true,
    });

    expect(pushLoop).toHaveBeenCalledOnce();
    expect(poll).not.toHaveBeenCalled();
  });

  it('keeps a Room WS liveness signal fresh via delivered events and a connected-socket tick, not just subscribe time', async () => {
    let socketConnected = true;
    let deliverEvent: ((sessionEvent: { event: NostrEvent }) => void) | undefined;
    const fakeClient = {
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn(),
      listMembers: vi.fn().mockResolvedValue([]),
      sessionEventsSubscribe: vi.fn(
        async (_channelId: string, handler: (sessionEvent: { event: NostrEvent }) => void) => {
          deliverEvent = handler;
          return () => {
            deliverEvent = undefined;
          };
        },
      ),
      onSocketClose: vi.fn(() => () => undefined),
      get socket() {
        return { connected: socketConnected };
      },
    };
    mocks.createBuzzClient.mockReturnValue(fakeClient);

    const workspaceRoot = await mkdtemp(join(tmpdir(), 'beeline-body-ws-liveness-'));
    const liveness: number[] = [];
    const body = new Body(
      {
        agentBinary: '/nonexistent',
        mcpBinary: '/nonexistent',
        agentEnv: {},
        workspaceRoot,
        relayBaseUrl: 'http://relay.test',
        relayHost: 'relay.test',
        relayScheme: 'http',
        relayWsUrl: 'ws://relay.test',
        autoApprovePermissions: true,
      } as BodyConfig,
      newIdentity('ws-liveness-operator'),
      newIdentity('ws-liveness-agent'),
      { onRoomPollSuccess: () => liveness.push(Date.now()) },
    );
    Reflect.set(body, 'roomParticipants', async () => []);
    Reflect.set(body, 'processChannelRequestEvents', async () => 0);
    body.pollChannelRequests = async () => 0;

    const waitFor = async (check: () => boolean, label: string, timeoutMs = 2_000) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (check()) return;
        await new Promise((resolveWait) => setTimeout(resolveWait, 5));
      }
      throw new Error(`timed out waiting for ${label}`);
    };

    const abort = new AbortController();
    const presence = { setStatus: vi.fn().mockResolvedValue(undefined) };
    const maintenance = vi.fn().mockResolvedValue(undefined);
    // A short real-time tick (instead of the production 60s default) stands
    // in for several watchdog stale-check intervals without slowing the test.
    const tickMs = 30;
    const loop = (
      Reflect.get(body, 'runRoomPushLoop') as (...args: unknown[]) => Promise<void>
    ).call(
      body,
      'ws-liveness-room',
      undefined,
      'named-repository',
      presence,
      { signal: abort.signal, pollMs: tickMs },
      maintenance,
    );

    try {
      // Subscribing marks the Room live once, at connect time — that alone
      // was the bug: it never got fresher again for the life of the socket.
      await waitFor(() => liveness.length === 1, 'initial subscribe liveness signal');

      // A pushed Room event is itself the freshest liveness signal — it must
      // refresh immediately on receipt, not only at (re)connect time.
      deliverEvent?.({ event: {} as NostrEvent });
      await waitFor(() => liveness.length === 2, 'delivered-event liveness signal');

      // A quiet Room with zero pushed events must still be marked live by
      // the periodic tick as long as the socket is actually connected — this
      // is what keeps a silent WS Room from going stale under the
      // supervisor's watchdog across many stale-check intervals.
      await waitFor(() => liveness.length >= 4, 'connected-socket periodic tick, twice over');

      // Once the socket is actually dead, the tick must stop vouching for
      // it — a genuinely broken WS still needs to trip the watchdog.
      socketConnected = false;
      const afterDeath = liveness.length;
      await new Promise((resolveWait) => setTimeout(resolveWait, tickMs * 4));
      expect(liveness.length).toBe(afterDeath);
    } finally {
      abort.abort();
      await loop;
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('reconnects a dropped relay socket forever: re-subscribes, re-announces presence, and delivers post-reconnect events', async () => {
    let socketConnected = true;
    // Monotonic count of REQ subscriptions issued across every loop iteration
    // (an iteration's own unsubscribe removes its handler from `latest`, so a
    // plain array length would go DOWN on reconnect and hide the re-subscribe).
    let subscribeCount = 0;
    let latest: ((event: NostrEvent) => void) | undefined;
    const closeCallbacks = new Set<() => void>();
    const fakeClient = {
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn(),
      listMembers: vi.fn().mockResolvedValue([]),
      sessionEventsSubscribe: vi.fn(
        async (_channelId: string, handler: (event: NostrEvent) => void) => {
          subscribeCount += 1;
          latest = handler;
          return () => {
            if (latest === handler) latest = undefined;
          };
        },
      ),
      onSocketClose: vi.fn((handler: () => void) => {
        closeCallbacks.add(handler);
        return () => {
          closeCallbacks.delete(handler);
        };
      }),
      get socket() {
        return { connected: socketConnected };
      },
    };
    mocks.createBuzzClient.mockReturnValue(fakeClient);

    const workspaceRoot = await mkdtemp(join(tmpdir(), 'beeline-body-ws-reconnect-'));
    const processed: NostrEvent[] = [];
    const body = new Body(
      {
        agentBinary: '/nonexistent',
        mcpBinary: '/nonexistent',
        agentEnv: {},
        workspaceRoot,
        relayBaseUrl: 'http://relay.test',
        relayHost: 'relay.test',
        relayScheme: 'http',
        relayWsUrl: 'ws://relay.test',
        autoApprovePermissions: true,
      } as BodyConfig,
      newIdentity('ws-reconnect-operator'),
      newIdentity('ws-reconnect-agent'),
      undefined,
    );
    Reflect.set(body, 'roomParticipants', async () => []);
    Reflect.set(
      body,
      'processChannelRequestEvents',
      async (_channelId: string, _b: unknown, _e: unknown, events: NostrEvent[]) => {
        processed.push(...events);
        return 0;
      },
    );
    body.pollChannelRequests = async () => 0;

    const waitFor = async (check: () => boolean, label: string, timeoutMs = 6_000) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (check()) return;
        await new Promise((resolveWait) => setTimeout(resolveWait, 5));
      }
      throw new Error(`timed out waiting for ${label}`);
    };

    const abort = new AbortController();
    const setStatus = vi.fn().mockResolvedValue(undefined);
    const presence = { setStatus };
    const loop = (
      Reflect.get(body, 'runRoomPushLoop') as (...args: unknown[]) => Promise<void>
    ).call(
      body,
      'ws-reconnect-room',
      undefined,
      'named-repository',
      presence,
      { signal: abort.signal },
      async () => undefined,
    );

    try {
      await waitFor(() => subscribeCount === 1, 'initial subscribe');
      expect(setStatus).toHaveBeenCalledWith('online');

      // The relay restarts: every Room's socket is severed at once.
      socketConnected = false;
      for (const handler of [...closeCallbacks]) handler();

      // The push loop must dial again ON ITS OWN (retry-forever, bounded
      // backoff), re-subscribe the REQ, and re-announce presence so Rooms see
      // the agent come back.
      await waitFor(() => subscribeCount >= 2, 're-subscribe after drop');
      expect(
        setStatus.mock.calls.filter((call) => call[0] === 'online').length,
      ).toBeGreaterThanOrEqual(2);

      // An event that arrives only AFTER the reconnection is delivered.
      latest!({ id: 'post-reconnect' } as NostrEvent);
      await waitFor(
        () => processed.some((event) => event.id === 'post-reconnect'),
        'post-reconnect delivery',
      );
    } finally {
      abort.abort();
      await loop;
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('recovers when the socket drops DURING the subscribe window, not only after the wait begins', async () => {
    let socketConnected = true;
    let iteration = 0;
    let subscribeCount = 0;
    let closeHandler: (() => void) | undefined;
    const fakeClient = {
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn(),
      listMembers: vi.fn().mockResolvedValue([]),
      sessionEventsSubscribe: vi.fn(
        async (_channelId: string, _handler: (event: NostrEvent) => void) => {
          subscribeCount += 1;
          return () => undefined;
        },
      ),
      onSocketClose: vi.fn((handler: () => void) => {
        closeHandler = handler;
        return () => {
          if (closeHandler === handler) closeHandler = undefined;
        };
      }),
      get socket() {
        return { connected: socketConnected };
      },
    };
    mocks.createBuzzClient.mockReturnValue(fakeClient);

    const workspaceRoot = await mkdtemp(join(tmpdir(), 'beeline-body-ws-race-'));
    const body = new Body(
      {
        agentBinary: '/nonexistent',
        mcpBinary: '/nonexistent',
        agentEnv: {},
        workspaceRoot,
        relayBaseUrl: 'http://relay.test',
        relayHost: 'relay.test',
        relayScheme: 'http',
        relayWsUrl: 'ws://relay.test',
        autoApprovePermissions: true,
      } as BodyConfig,
      newIdentity('ws-race-operator'),
      newIdentity('ws-race-agent'),
      undefined,
    );
    Reflect.set(body, 'processChannelRequestEvents', async () => 0);
    body.pollChannelRequests = async () => 0;
    // The drop lands inside iteration 2's subscribe window — between the
    // socket lease and the REQ — where `notifyClose` used to fire into an
    // empty observer set and leave this loop asleep on a dead socket forever
    // (standalone serve has no supervisor watchdog to break such a wedge).
    Reflect.set(body, 'roomParticipants', async () => {
      iteration += 1;
      if (iteration === 2) {
        socketConnected = false;
        closeHandler?.();
      }
      return [];
    });

    const waitFor = async (check: () => boolean, label: string, timeoutMs = 8_000) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (check()) return;
        await new Promise((resolveWait) => setTimeout(resolveWait, 5));
      }
      throw new Error(`timed out waiting for ${label}`);
    };

    const abort = new AbortController();
    const setStatus = vi.fn().mockResolvedValue(undefined);
    const loop = (
      Reflect.get(body, 'runRoomPushLoop') as (...args: unknown[]) => Promise<void>
    ).call(
      body,
      'ws-race-room',
      undefined,
      'named-repository',
      { setStatus },
      { signal: abort.signal },
      async () => undefined,
    );

    try {
      await waitFor(() => subscribeCount === 1, 'initial subscribe');
      // A first clean restart ends iteration 1, so the loop enters the
      // iteration whose subscribe window the drop below will land in.
      closeHandler?.();
      // Iteration 2 dies mid-window (its own roomParticipants read fires the
      // close, before the old code ever registered its close observer); the
      // loop must wake, back off briefly, and subscribe AGAIN (iteration 3)
      // instead of sleeping forever on the dead socket.
      await waitFor(() => subscribeCount >= 3, 'resubscribe after mid-subscribe-window drop');
      expect(socketConnected).toBe(false);
    } finally {
      abort.abort();
      await loop;
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('isRoomAgentOnline seeds once per Room via a query, then updates live off agentPresenceSubscribe with no further queries', async () => {
    let presenceHandler: ((event: NostrEvent) => void) | undefined;
    const unsubscribe = vi.fn();
    const disconnect = vi.fn();
    const fakeClient = {
      connect: vi.fn(async () => undefined),
      socket: null,
      agentPresenceSubscribe: vi.fn(
        async (_channelId: string, handler: (event: NostrEvent) => void) => {
          presenceHandler = handler;
          return unsubscribe;
        },
      ),
      disconnect,
    };
    mocks.createBuzzClient.mockReturnValue(fakeClient);

    const body = new Body({
      agentBinary: '/nonexistent',
      mcpBinary: '/nonexistent',
      agentEnv: {},
      workspaceRoot: '/tmp/buzzy-presence-cache-unit',
      relayBaseUrl: 'http://relay.test',
      relayHost: 'relay.test',
      relayScheme: 'http',
      relayWsUrl: 'ws://relay.test',
      autoApprovePermissions: true,
    });
    const seedQuery = vi.fn(async () => [] as NostrEvent[]);
    Reflect.set(body, 'agentRelay', { queryEvents: seedQuery });

    const agentPubkey = 'agent-pubkey';
    const isOnline = (channelId: string) =>
      (
        Reflect.get(body, 'isRoomAgentOnline') as (
          channel: string,
          pubkey: string,
        ) => Promise<boolean>
      ).call(body, channelId, agentPubkey);

    // No presence published yet: offline, seeded by exactly one query and
    // one subscribe for this Room. Presence is kind:30078 parameterized-
    // replaceable — indexed by `#d`, never `#h` (an `#h` filter matches
    // nothing, which is how a live Codex daemon read as OFFLINE).
    await expect(isOnline('room-a')).resolves.toBe(false);
    expect(seedQuery).toHaveBeenCalledOnce();
    expect(seedQuery).toHaveBeenCalledWith([
      expect.objectContaining({
        kinds: [30078],
        '#d': ['agent-presence:room-a'],
      }),
    ]);
    expect(JSON.stringify(seedQuery.mock.calls[0])).not.toContain('"#h"');
    expect(fakeClient.agentPresenceSubscribe).toHaveBeenCalledOnce();

    // A live presence event updates the cache in place; a repeat check for
    // the same Room costs zero further queries or subscribes.
    presenceHandler?.({
      tags: [
        ['agent', agentPubkey],
        ['status', 'online'],
      ],
      created_at: Math.floor(Date.now() / 1_000),
    } as unknown as NostrEvent);
    await expect(isOnline('room-a')).resolves.toBe(true);
    expect(seedQuery).toHaveBeenCalledOnce();
    expect(fakeClient.agentPresenceSubscribe).toHaveBeenCalledOnce();

    await body.dispose();
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(disconnect).toHaveBeenCalledOnce();
  });

  it.skip('lets a healthy Room continue polling while a rate-limited sibling waits', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ accepted: true }))),
    );
    const failingController = new AbortController();
    const healthyController = new AbortController();
    const bodyConfig = {
      agentBinary: '/nonexistent',
      mcpBinary: '/nonexistent',
      agentEnv: {},
      workspaceRoot: '/tmp/buzzy-independent-rooms',
      relayBaseUrl: 'http://relay.test',
      relayHost: 'relay.test',
      relayScheme: 'http' as const,
      relayWsUrl: 'ws://relay.test',
      autoApprovePermissions: true,
    };
    const failing = new Body(
      bodyConfig,
      newIdentity('failing-operator'),
      newIdentity('failing-agent'),
    );
    const healthy = new Body(
      bodyConfig,
      newIdentity('healthy-operator'),
      newIdentity('healthy-agent'),
    );
    for (const body of [failing, healthy]) {
      vi.spyOn(body, 'assertRepositorySafety').mockResolvedValue(undefined);
      vi.spyOn(body, 'provision').mockResolvedValue({} as never);
      vi.spyOn(body, 'restoreSubchannels').mockResolvedValue(undefined);
      vi.spyOn(body as never, 'pollRoomMaintenance').mockResolvedValue(undefined);
    }
    vi.spyOn(failing, 'pollChannelRequests').mockRejectedValue(
      new Error('HTTP 429 {"error":"retry in 2s"}'),
    );
    let failureWaitStarted!: () => void;
    const failureWait = new Promise<void>((resolve) => {
      failureWaitStarted = resolve;
    });
    const failingDelays: number[] = [];
    vi.spyOn(failing as never, 'waitForPoll').mockImplementation(async (delayMs: number) => {
      failingDelays.push(delayMs);
      failureWaitStarted();
      await new Promise<void>((resolve) =>
        failingController.signal.addEventListener('abort', () => resolve(), { once: true }),
      );
    });
    let healthyPolls = 0;
    vi.spyOn(healthy, 'pollChannelRequests').mockImplementation(async () => {
      healthyPolls++;
      if (healthyPolls === 3) healthyController.abort();
      return 0;
    });
    vi.spyOn(healthy as never, 'waitForPoll').mockResolvedValue(undefined);

    const failingLoop = failing.runRepositoryRoomLoop(
      'workspace',
      'failing-room',
      { repo: 'cherry', repositoryKey: 'cherry', localOnly: true },
      { pollMs: 1_000, signal: failingController.signal },
    );
    await failureWait;
    await healthy.runRepositoryRoomLoop(
      'workspace',
      'healthy-room',
      { repo: 'beebee', repositoryKey: 'beebee', localOnly: true },
      { pollMs: 1_000, signal: healthyController.signal },
    );
    failingController.abort();
    await failingLoop;

    expect(failingDelays).toEqual([2_000]);
    expect(healthyPolls).toBe(3);
  });

  it('bounds a non-returning ACP prompt to one minute and retires its session generation', async () => {
    vi.useFakeTimers();
    try {
      const scheduler = new SessionScheduler({ maxLiveSessions: 1, idleMs: 60_000 });
      const body = new Body(
        {
          agentBinary: '/nonexistent',
          mcpBinary: '/nonexistent',
          agentEnv: {},
          workspaceRoot: '/tmp/buzzy-hung-acp',
          relayBaseUrl: 'http://relay.test',
          relayHost: 'relay.test',
          relayScheme: 'http',
          relayWsUrl: 'ws://relay.test',
          autoApprovePermissions: true,
        },
        newIdentity('hung-operator'),
        newIdentity('hung-agent'),
        { scheduler },
      );
      const sessionCancel = vi.fn();
      const sessionPrompt = vi.fn(
        (_sessionId: string, _prompt: string, timeoutMs: number) =>
          new Promise<never>((_resolve, reject) =>
            setTimeout(
              () => reject(new Error(`ACP session/prompt timed out after ${timeoutMs}ms`)),
              timeoutMs,
            ),
          ),
      );
      const suspend = vi.fn().mockResolvedValue(undefined);
      const session = {
        channelId: 'hung-room',
        sessionId: 'hung-session',
        mode: 'readonly',
        client: { sessionPrompt, sessionCancel },
        lifecycle: { activate: vi.fn().mockResolvedValue('hung-session'), suspend },
      } as never;

      const prompt = Reflect.get(body, 'promptAgent').call(body, session, 'hello', {
        channelId: 'hung-room',
        requestId: 'hung-request',
        originalRequestId: 'hung-request',
        cause: 'room-message',
      });
      const rejection = expect(prompt).rejects.toThrow(
        `ACP session/prompt timed out after ${ROOM_AGENT_PROMPT_TIMEOUT_MS}ms`,
      );
      await vi.advanceTimersByTimeAsync(ROOM_AGENT_PROMPT_TIMEOUT_MS - 1);
      expect(suspend).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await rejection;

      expect(sessionPrompt).toHaveBeenCalledWith(
        'hung-session',
        'hello',
        ROOM_AGENT_PROMPT_TIMEOUT_MS,
        expect.any(Function),
        expect.any(Function),
      );
      expect(sessionCancel).toHaveBeenCalledWith('hung-session');
      expect(suspend).toHaveBeenCalledOnce();
      expect(scheduler.snapshot().busy).toBe(0);
      await scheduler.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not report a scheduler/session activation failure as a model call', async () => {
    const scheduler = new SessionScheduler({ maxLiveSessions: 1, idleMs: 60_000 });
    const body = new Body(
      {
        agentBinary: '/nonexistent',
        mcpBinary: '/nonexistent',
        agentEnv: {},
        workspaceRoot: '/tmp/buzzy-activation-spend',
        relayBaseUrl: 'http://relay.test',
        relayHost: 'relay.test',
        relayScheme: 'http',
        relayWsUrl: 'ws://relay.test',
        autoApprovePermissions: true,
      },
      newIdentity('activation-spend-operator'),
      newIdentity('activation-spend-agent'),
      { scheduler },
    );
    const sessionPrompt = vi.fn();
    const session = {
      channelId: 'activation-room',
      sessionId: 'not-started',
      mode: 'readonly',
      client: { sessionPrompt, sessionCancel: vi.fn() },
      lifecycle: {
        activate: vi.fn().mockRejectedValue(new Error('adapter could not start')),
        suspend: vi.fn().mockResolvedValue(undefined),
      },
    } as never;
    const record = vi.spyOn(Reflect.get(body, 'durableState'), 'recordModelTurn');

    await expect(
      Reflect.get(body, 'promptAgent').call(body, session, 'hello', {
        channelId: 'activation-room',
        requestId: 'human-request',
        originalRequestId: 'human-request',
        cause: 'room-message',
      }),
    ).rejects.toThrow('adapter could not start');

    expect(sessionPrompt).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
    await scheduler.dispose();
  });

  it('keeps a fully wedged backend out of the durable transcript until it stops', async () => {
    vi.useFakeTimers();
    try {
      const scheduler = new SessionScheduler({ maxLiveSessions: 1, idleMs: 60_000 });
      const body = new Body(
        {
          agentBinary: '/nonexistent',
          mcpBinary: '/nonexistent',
          agentEnv: {},
          workspaceRoot: '/tmp/buzzy-stall-notice',
          relayBaseUrl: 'http://relay.test',
          relayHost: 'relay.test',
          relayScheme: 'http',
          relayWsUrl: 'ws://relay.test',
          autoApprovePermissions: true,
        },
        newIdentity('stall-operator'),
        newIdentity('stall-agent'),
        { scheduler },
      );
      const published: NostrEvent[] = [];
      vi.stubGlobal(
        'fetch',
        vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
          published.push(JSON.parse(String(init?.body)) as NostrEvent);
          return new Response(JSON.stringify({ accepted: true }), { status: 200 });
        }),
      );

      // A backend producing literally zero ACP activity for the whole turn.
      const sessionCancel = vi.fn();
      const sessionPrompt = vi.fn(
        (_sessionId: string, _prompt: string, timeoutMs: number) =>
          new Promise<never>((_resolve, reject) =>
            setTimeout(
              () =>
                reject(
                  new Error(`ACP session/prompt timed out after ${timeoutMs}ms of inactivity`),
                ),
              timeoutMs,
            ),
          ),
      );
      const session = {
        channelId: 'stall-room',
        sessionId: 'stall-session',
        mode: 'readonly',
        client: { sessionPrompt, sessionCancel },
        lifecycle: {
          activate: vi.fn().mockResolvedValue('stall-session'),
          suspend: vi.fn().mockResolvedValue(undefined),
        },
      } as never;

      const prompt = Reflect.get(body, 'promptAgent').call(body, session, 'hello', {
        channelId: 'stall-room',
        requestId: 'stall-request',
        originalRequestId: 'stall-request',
        cause: 'room-message',
      });
      const rejection = expect(prompt).rejects.toThrow('timed out after');

      // The caller owns the working receipt that lights the thinking
      // indicator. `promptAgent` must not add a second, durable prose status
      // while the backend remains silent.
      await vi.advanceTimersByTimeAsync(ROOM_AGENT_PROMPT_TIMEOUT_MS - 1);
      expect(published).toEqual([]);

      await vi.advanceTimersByTimeAsync(1);
      await rejection;
      await scheduler.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it.skip('contains an ETIMEDOUT poll in its Room, backs off, and returns presence online on recovery', async () => {
    const statuses: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        const event = JSON.parse(String(init?.body)) as NostrEvent;
        statuses.push(event.tags.find((tag) => tag[0] === 'status')?.[1] ?? '');
        return new Response(JSON.stringify({ accepted: true }), { status: 200 });
      }),
    );
    const controller = new AbortController();
    const body = new Body(
      {
        agentBinary: '/nonexistent',
        mcpBinary: '/nonexistent',
        agentEnv: {},
        workspaceRoot: '/tmp/buzzy-poll-resilience',
        relayBaseUrl: 'http://relay.test',
        relayHost: 'relay.test',
        relayScheme: 'http',
        relayWsUrl: 'ws://relay.test',
        autoApprovePermissions: true,
      },
      newIdentity('poll-operator'),
      newIdentity('poll-agent'),
    );
    vi.spyOn(body, 'assertRepositorySafety').mockResolvedValue(undefined);
    vi.spyOn(body, 'provision').mockResolvedValue({} as never);
    vi.spyOn(body, 'restoreSubchannels').mockResolvedValue(undefined);
    const timedOut = Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('ETIMEDOUT'), { code: 'ETIMEDOUT' }),
    });
    const poll = vi
      .spyOn(body, 'pollChannelRequests')
      .mockRejectedValueOnce(timedOut)
      .mockImplementationOnce(async () => {
        controller.abort();
        return 0;
      });

    const loop = body.runRepositoryRoomLoop(
      'workspace',
      'sumo-room',
      { repo: 'cherry', repositoryKey: 'cherry', localOnly: true },
      { pollMs: 5, signal: controller.signal },
    );
    await loop;

    expect(poll).toHaveBeenCalledTimes(2);
    expect(statuses).toEqual(expect.arrayContaining(['online', 'offline', 'online']));
    expect(statuses.at(-1)).toBe('offline');
  });
});

describe('corner archive boundary', () => {
  const client = new AcpClient({ agentBinary: '/nonexistent', agentEnv: {} });
  const role = newIdentity('corner-owner');

  function info(options: { channelId?: string; parentChannelId?: string } = {}) {
    return {
      subchannelId: 'corner',
      worktreePath: '/tmp/corner',
      featureBranch: 'feature/corner',
      role,
      session: {
        channelId: options.channelId ?? 'corner',
        sessionId: 'session',
        client,
        mode: 'edit' as const,
        ...(options.parentChannelId ? { parentChannelId: options.parentChannelId } : {}),
      },
      lastPolledAt: 0,
      archived: false,
    };
  }

  it('accepts only the exact relay-linked corner identity', () => {
    expect(() =>
      assertSubchannelArchiveTarget(info({ parentChannelId: 'room' }), 'room'),
    ).not.toThrow();
  });

  it('refuses top-level Rooms and mismatched session identities', () => {
    expect(() => assertSubchannelArchiveTarget(info(), null)).toThrow('non-corner');
    expect(() =>
      assertSubchannelArchiveTarget(info({ channelId: 'room', parentChannelId: 'room' }), 'room'),
    ).toThrow('non-corner');
    expect(() =>
      assertSubchannelArchiveTarget(info({ parentChannelId: 'room' }), 'other-room'),
    ).toThrow('non-corner');
  });
});

describe('a restart-caused session pause is never published as agent trouble', () => {
  /**
   * Owner-reported 2026-08-23: across every daemon restart (two self-update
   * handovers in one day) corners surfaced a "suspended" state that read as
   * agent trouble. Two publication shapes caused it, both planned-pause noise
   * rather than news: the session's creation-time `suspended` bookkeeping
   * (replayed for every corner `restoreSubchannels` recreates at startup) and
   * the suspension `Body.dispose()` drives at shutdown. A genuine mid-run
   * suspension — idle eviction, capacity wait, watchdog force-suspend — still
   * publishes. The lifecycle ORACLE is unaffected by any of these either way
   * (`mapRawCornerStatusTag('suspended')` is undefined); this is about what
   * the corner header renders.
   */
  function newBodyWithScheduler(
    agent: ReturnType<typeof newIdentity>,
    workspaceRoot: string,
    scheduler: unknown,
  ) {
    return new Body(
      {
        agentBinary: '/nonexistent',
        mcpBinary: '/nonexistent',
        agentEnv: {},
        workspaceRoot,
        relayBaseUrl: 'https://relay.example',
        relayHost: 'relay.example',
        relayScheme: 'https',
        relayWsUrl: 'wss://relay.example',
        autoApprovePermissions: true,
      },
      undefined,
      agent,
      { scheduler } as never,
    );
  }

  function stubRelayRecordingPublishes(): NostrEvent[] {
    const published: NostrEvent[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        if (String(input).endsWith('/query')) {
          return new Response(JSON.stringify([]), { status: 200 });
        }
        published.push(JSON.parse(String(init?.body)) as NostrEvent);
        return new Response(JSON.stringify({ accepted: true }), { status: 200 });
      }),
    );
    return published;
  }

  const cornerSessionEvents = (published: NostrEvent[]) =>
    published.filter((event) =>
      event.tags?.some((tag) => tag[0] === 't' && tag[1] === 'corner-session'),
    );

  it("publishes only a session's live transition", async () => {
    const agent = newIdentity('initial-state-agent');
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'buzzy-initial-suspend-'));
    try {
      const body = newBodyWithScheduler(agent, workspaceRoot, {});
      const published = stubRelayRecordingPublishes();
      const session = {
        channelId: 'corner-fresh',
        sessionId: 'fresh-session',
        logicalSessionId: 'logical-fresh',
        client: new AcpClient({ agentBinary: '/nonexistent', agentEnv: {} }),
        mode: 'edit' as const,
        lifecycle: { suspend: async () => undefined },
      } as never;
      body.registerSubchannel({
        subchannelId: 'corner-fresh',
        worktreePath: '/tmp/does-not-matter',
        featureBranch: 'feature/fresh',
        role: newIdentity('fresh-role'),
        session,
        lastPolledAt: 0,
        archived: false,
      } as never);
      const onStateChange = Reflect.get(body, 'onCornerSessionStateChange') as (
        session: unknown,
        channelId: string,
        state: 'live' | 'suspended' | 'waiting-for-slot',
      ) => Promise<void>;

      // Exactly what createManagedSession does at session creation.
      await onStateChange.call(body, session, 'corner-fresh', 'suspended');
      expect(cornerSessionEvents(published)).toEqual([]);
      expect((session as { processState?: string }).processState).toBe('suspended');

      // The first REAL transition reaches the wire.
      await onStateChange.call(body, session, 'corner-fresh', 'live');
      expect(cornerSessionEvents(published)).toHaveLength(1);
      expect(
        cornerSessionEvents(published)[0].tags.some(
          (tag) => tag[0] === 'status' && tag[1] === 'live',
        ),
      ).toBe(true);

      // A mid-run suspension is process bookkeeping, not conversation.
      await onStateChange.call(body, session, 'corner-fresh', 'suspended');
      expect(cornerSessionEvents(published)).toHaveLength(1);
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('Body.dispose suspends sessions without publishing corner-session cards', async () => {
    const agent = newIdentity('dispose-agent');
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'buzzy-dispose-suspend-'));
    try {
      const session = {
        channelId: 'corner-shutdown',
        sessionId: 'shutdown-session',
        logicalSessionId: 'logical-shutdown',
        processState: 'live' as const,
        client: new AcpClient({ agentBinary: '/nonexistent', agentEnv: {} }),
        mode: 'edit' as const,
        lifecycle: {
          suspend: async () => undefined,
          onStateChange: async (state: 'live' | 'suspended' | 'waiting-for-slot') => {
            onStateChangeCalls.push(state);
            // Mirror the production wiring: the lifecycle reports through the
            // Body-owned hook, which owns both tracking and publication.
            await (
              Reflect.get(body, 'onCornerSessionStateChange') as (
                s: unknown,
                c: string,
                st: 'live' | 'suspended' | 'waiting-for-slot',
              ) => Promise<void>
            ).call(body, session, 'corner-shutdown', state);
          },
        },
      } as never;
      // The one thing SessionScheduler.suspend does that dispose depends on.
      const scheduler = {
        suspend: async (key: string) => {
          const info = body.getSubchannels().get(key);
          await info?.session.lifecycle.suspend();
          await info?.session.lifecycle.onStateChange?.('suspended');
        },
      };
      const body = newBodyWithScheduler(agent, workspaceRoot, scheduler);
      const published = stubRelayRecordingPublishes();
      const onStateChangeCalls: string[] = [];
      body.registerSubchannel({
        subchannelId: 'corner-shutdown',
        worktreePath: '/tmp/does-not-matter',
        featureBranch: 'feature/shutdown',
        role: newIdentity('shutdown-role'),
        session,
        lastPolledAt: 0,
        archived: false,
      } as never);

      await body.dispose();

      // The teardown ran (the lifecycle saw its suspension) but nothing was
      // published: a shutdown pause is a quiet handover, not agent trouble.
      expect(onStateChangeCalls).toEqual(['suspended']);
      expect(cornerSessionEvents(published)).toEqual([]);
      expect((session as { processState?: string }).processState).toBe('suspended');
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });
});
