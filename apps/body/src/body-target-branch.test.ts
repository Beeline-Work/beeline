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
describe('the Room target branch changes by owner confirm, never by the agent', () => {
  const admin = newIdentity('target-branch-admin');
  const roomId = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
  const repositoryKey = 'repo-key-target-branch';

  function baseConfig(workspaceRoot: string): BodyConfig {
    return {
      agentBinary: '/nonexistent',
      mcpBinary: '/nonexistent',
      agentEnv: {},
      workspaceRoot,
      relayBaseUrl: 'http://relay.test',
      relayHost: 'relay.test',
      relayScheme: 'http',
      relayWsUrl: 'ws://relay.test',
      autoApprovePermissions: true,
    };
  }

  function jsonResponse(body: unknown): Response {
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }

  /** The owner-authored Room→repository config event as it sits on the relay. */
  function roomRepositoryEvent(channelId: string, targetBranch: string): NostrEvent {
    return signEvent(
      {
        pubkey: admin.publicKey,
        created_at: 1_700_000_500,
        kind: 30_078,
        tags: [
          ['d', `buzz-room-repository:${channelId}`],
          ['h', channelId],
          ['t', 'buzz-room-repository'],
        ],
        content: JSON.stringify({
          key: repositoryKey,
          name: 'buzzy',
          remote: 'https://github.com/lunchboxfortwo/buzzy',
          localOnly: false,
          targetBranch,
        }),
      },
      admin.secretKey,
    );
  }

  /**
   * Relay stub scoped to what this flow reads: the Room's repository config
   * and the owner projection that authorizes its author.
   */
  function stubRelay(
    channelId: string,
    targetBranch: string | null,
    rejectTargetBranchProposal = false,
  ): NostrEvent[] {
    const published: NostrEvent[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        if (String(input).endsWith('/events')) {
          const event = JSON.parse(String(init?.body)) as NostrEvent;
          published.push(event);
          if (
            rejectTargetBranchProposal &&
            (event.tags ?? []).some(
              (tag) => tag[0] === 't' && tag[1] === 'buzz-target-branch-proposal',
            )
          ) {
            return new Response(JSON.stringify({ error: 'proposal refused' }), {
              status: 400,
              headers: { 'content-type': 'application/json' },
            });
          }
          return jsonResponse({ accepted: true });
        }
        const filter = (JSON.parse(String(init?.body)) as Record<string, unknown>[])[0] ?? {};
        const kind = (filter.kinds as number[] | undefined)?.[0];
        if (kind === 30_078 && targetBranch) {
          return jsonResponse([roomRepositoryEvent(channelId, targetBranch)]);
        }
        if (kind === KIND_CHANNEL_ADMINS) {
          return jsonResponse([
            signEvent(
              {
                pubkey: admin.publicKey,
                created_at: 1_700_000_000,
                kind: KIND_CHANNEL_ADMINS,
                tags: [
                  ['d', channelId],
                  ['p', admin.publicKey, '', 'owner'],
                ],
                content: '',
              },
              admin.secretKey,
            ),
          ]);
        }
        return jsonResponse([]);
      }),
    );
    return published;
  }

  function proposals(published: NostrEvent[]): NostrEvent[] {
    return published.filter((event) =>
      (event.tags ?? []).some((tag) => tag[0] === 't' && tag[1] === 'buzz-target-branch-proposal'),
    );
  }

  function makeBody(agentCommand?: string): { body: Body; workspaceRoot: string } {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'buzzy-target-branch-'));
    const body = new Body({
      ...baseConfig(workspaceRoot),
      ...(agentCommand ? { agentCommand } : {}),
    });
    stubEmptyAgentHistory(body);
    return { body, workspaceRoot };
  }

  function reply(
    body: Body,
    channelId: string,
    content: string,
    boundRepo: Record<string, unknown>,
  ): Promise<RoomReplyOutcome> {
    return Reflect.get(body, 'replyInRoom').call(body, channelId, boundRepo, {
      eventId: 'target-branch-request',
      authorPubkey: admin.publicKey,
      content,
      createdAt: 1,
    }) as Promise<RoomReplyOutcome>;
  }

  afterEach(() => vi.unstubAllGlobals());

  describe('the agent has a prompt-documented way to raise the card itself', () => {
    function permission(line: string) {
      return { toolCall: { title: line, kind: 'execute', rawInput: { command: line } } };
    }

    function armTurn(body: Body, overrides: Record<string, unknown> = {}): void {
      (Reflect.get(body, 'pendingRoomTurns') as Map<string, Record<string, unknown>>).set(roomId, {
        request: {
          eventId: 'target-branch-request',
          authorPubkey: admin.publicKey,
          content: 'from now on put changes on staging please',
          createdAt: 1,
        },
        boundRepo: { repo: 'buzzy', repositoryKey, targetBranch: 'refs/heads/master' },
        editPolicy: 'repository',
        permissionHandled: false,
        transitionedToCorner: false,
        readOnlyInformationRequest: false,
        ...overrides,
      });
    }

    function handle(body: Body, line: string): Promise<string> {
      return Reflect.get(body, 'handleRoomPermissionRequest').call(
        body,
        roomId,
        permission(line),
        'repository',
      ) as Promise<string>;
    }

    it('the Room system prompt names the exact command and forbids claiming the change', () => {
      const instructions = roomEditPolicyInstructions('repository').join('\n');
      expect(instructions).toContain('/change-target-branch --branch <branch>');
      expect(instructions).toContain('the Room owner has to confirm that card');
      expect(instructions).toMatch(/never say a landing-target change is in effect/i);
    });

    it('publishes the card, rejects the command, and never opens a corner', async () => {
      const { body, workspaceRoot } = makeBody('pi-acp');
      const published = stubRelay(roomId, 'master');
      const open = vi.spyOn(body, 'openSubchannel');
      armTurn(body);

      await expect(handle(body, '/change-target-branch --branch staging')).resolves.toBe('reject');

      const card = proposals(published);
      expect(card).toHaveLength(1);
      expect(card[0]!.content).toBe('Change target branch: master → staging');
      expect(card[0]!.tags).toContainEqual(['requester', admin.publicKey]);
      // No corner, no write-permission card, and above all no binding.
      expect(open).not.toHaveBeenCalled();
      expect(
        published.filter((event) =>
          (event.tags ?? []).some(
            (tag) => tag[0] === 't' && tag[1] === 'buzz-write-permission-request',
          ),
        ),
      ).toHaveLength(0);
      expect(published.filter((event) => event.kind === 30_078)).toHaveLength(0);
      rmSync(workspaceRoot, { recursive: true, force: true });
    });

    it('turns the captured prose slash command into the native proposal card', async () => {
      const { body, workspaceRoot } = makeBody('pi-acp');
      const published = stubRelay(roomId, 'master');
      Reflect.get(body, 'sessions').set(roomId, {
        channelId: roomId,
        sessionId: 'target-branch-session',
        logicalSessionId: `${body.agent.publicKey}:${roomId}`,
        mode: 'readonly',
        client: {},
      });
      vi.spyOn(body as never, 'promptAgent' as never).mockResolvedValue({
        stopReason: 'end_turn',
        updates: [],
        toolCalls: [],
        agentText: [
          'I can propose that change with `/change-target-branch --branch staging`.',
          '',
          'The target does not change until the proposal is confirmed.',
        ].join('\n'),
      } as never);

      await expect(
        reply(body, roomId, 'please arrange for future changes to go through staging', {
          repo: 'buzzy',
          repositoryKey,
          targetBranch: 'refs/heads/master',
        }),
      ).resolves.toEqual({ openedCorner: false, producedReply: true });

      const card = proposals(published);
      expect(card).toHaveLength(1);
      expect(card[0]!.content).toBe('Change target branch: master → staging');
      expect(card[0]!.tags).toContainEqual(['requester', admin.publicKey]);
      expect(published.filter((event) => event.kind === 30_078)).toHaveLength(0);
      rmSync(workspaceRoot, { recursive: true, force: true });
    });

    it.skip('replaces stale proposal prose when the Room already uses that branch', async () => {
      const { body, workspaceRoot } = makeBody('pi-acp');
      const published = stubRelay(roomId, 'staging');
      Reflect.get(body, 'sessions').set(roomId, {
        channelId: roomId,
        sessionId: 'target-branch-session',
        logicalSessionId: `${body.agent.publicKey}:${roomId}`,
        mode: 'readonly',
        client: {},
      });
      vi.spyOn(body as never, 'promptAgent' as never).mockResolvedValue({
        stopReason: 'end_turn',
        updates: [],
        toolCalls: [],
        agentText:
          'I can propose that change with `/change-target-branch --branch staging`; the owner must confirm the card.',
      } as never);

      await expect(
        reply(body, roomId, 'please arrange for future changes to go through staging', {
          repo: 'buzzy',
          repositoryKey,
          targetBranch: 'refs/heads/staging',
        }),
      ).resolves.toEqual({ openedCorner: false, producedReply: true });

      expect(proposals(published)).toHaveLength(0);
      expect(
        published.filter(
          (event) =>
            event.content === 'This Room already lands to staging, so there is nothing to change.',
        ),
      ).toHaveLength(1);
      expect(published.some((event) => event.content.includes('owner must confirm'))).toBe(false);
      rmSync(workspaceRoot, { recursive: true, force: true });
    });

    it.skip('keeps that no-op truthful when permission and prose expose the same command', async () => {
      const { body, workspaceRoot } = makeBody('pi-acp');
      const published = stubRelay(roomId, 'staging');
      Reflect.get(body, 'sessions').set(roomId, {
        channelId: roomId,
        sessionId: 'target-branch-session',
        logicalSessionId: `${body.agent.publicKey}:${roomId}`,
        mode: 'readonly',
        client: {},
      });
      vi.spyOn(body as never, 'promptAgent' as never).mockImplementation((async () => {
        await handle(body, '/change-target-branch --branch staging');
        return {
          stopReason: 'end_turn',
          updates: [],
          toolCalls: [],
          agentText:
            'I can propose that change with `/change-target-branch --branch staging`; the owner must confirm the card.',
        };
      }) as never);

      await expect(
        reply(body, roomId, 'please arrange for future changes to go through staging', {
          repo: 'buzzy',
          repositoryKey,
          targetBranch: 'refs/heads/staging',
        }),
      ).resolves.toEqual({ openedCorner: false, producedReply: true });

      expect(proposals(published)).toHaveLength(0);
      expect(
        published.filter(
          (event) =>
            event.content === 'This Room already lands to staging, so there is nothing to change.',
        ),
      ).toHaveLength(1);
      expect(published.some((event) => event.content.includes('owner must confirm'))).toBe(false);
      rmSync(workspaceRoot, { recursive: true, force: true });
    });

    it.skip('keeps the Room request retryable when the native proposal is refused', async () => {
      const { body, workspaceRoot } = makeBody('pi-acp');
      const published = stubRelay(roomId, 'master', true);
      Reflect.get(body, 'sessions').set(roomId, {
        channelId: roomId,
        sessionId: 'target-branch-session',
        logicalSessionId: `${body.agent.publicKey}:${roomId}`,
        mode: 'readonly',
        client: {},
      });
      vi.spyOn(body as never, 'promptAgent' as never).mockResolvedValue({
        stopReason: 'end_turn',
        updates: [],
        toolCalls: [],
        agentText:
          'I can propose that change with `/change-target-branch --branch staging`; the owner must confirm the card.',
      } as never);

      await expect(
        reply(body, roomId, 'please arrange for future changes to go through staging', {
          repo: 'buzzy',
          repositoryKey,
          targetBranch: 'refs/heads/master',
        }),
      ).resolves.toEqual({ openedCorner: false, producedReply: false });

      expect(proposals(published).length).toBeGreaterThan(0);
      expect(
        published.filter(
          (event) =>
            event.content === "I couldn't publish the target-branch proposal; please try again.",
        ),
      ).toHaveLength(1);
      expect(published.some((event) => event.content.includes('owner must confirm'))).toBe(false);
      rmSync(workspaceRoot, { recursive: true, force: true });
    });

    it('does not classify a malformed or chained prose slash command', () => {
      for (const text of [
        '/change-target-branch',
        '/change-target-branch staging',
        '/change-target-branch --branch ..',
        '/change-target-branch --branch staging && echo nope',
        'Use `/change-target-branch --branch <branch>` when a branch is known.',
      ]) {
        expect(targetBranchProposalFromAgentText(text), text).toBeUndefined();
      }
    });

    it('caps the card at one per turn however often the agent attempts it', async () => {
      const { body, workspaceRoot } = makeBody();
      const published = stubRelay(roomId, 'master');
      armTurn(body);

      await handle(body, '/change-target-branch --branch staging');
      await handle(body, '/change-target-branch --branch staging');
      await handle(body, '/change-target-branch --branch other');

      expect(proposals(published)).toHaveLength(1);
      rmSync(workspaceRoot, { recursive: true, force: true });
    });

    // A Room-config proposal is not editing, and `isReadOnlyInformationRequest`
    // misreading the ask is one of the phrasing misses this marker exists for.
    it('still raises the card on an information-only turn', async () => {
      const { body, workspaceRoot } = makeBody();
      const published = stubRelay(roomId, 'master');
      armTurn(body, { readOnlyInformationRequest: true });

      await handle(body, '/change-target-branch --branch staging');

      expect(proposals(published)).toHaveLength(1);
      rmSync(workspaceRoot, { recursive: true, force: true });
    });

    it('proposes nothing in a Room with no repository to repoint', async () => {
      const { body, workspaceRoot } = makeBody();
      const published = stubRelay(roomId, 'master');
      armTurn(body, { boundRepo: undefined, editPolicy: 'direct-message' });

      await expect(handle(body, '/change-target-branch --branch staging')).resolves.toBe('reject');
      expect(proposals(published)).toHaveLength(0);
      rmSync(workspaceRoot, { recursive: true, force: true });
    });

    // A marker with a shell payload chained onto it is not the marker: it falls
    // through to the ordinary read-only path and proposes nothing.
    // `permissionHandled` is pre-set only so that fall-through lands on the
    // plain rejection instead of the (unrelated) write-permission ceremony.
    it('is not a way to run a shell command', async () => {
      const { body, workspaceRoot } = makeBody();
      const published = stubRelay(roomId, 'master');
      armTurn(body, { permissionHandled: true });

      await expect(
        handle(body, '/change-target-branch --branch staging; rm -rf /tmp/x'),
      ).resolves.toBe('reject');
      expect(proposals(published)).toHaveLength(0);
      rmSync(workspaceRoot, { recursive: true, force: true });
    });
  });

  it('uses the confirmed target for the next corner without mutating the Room snapshot', async () => {
    const { body, workspaceRoot } = makeBody();
    stubRelay(roomId, 'staging');
    const roomRepo = { repo: 'buzzy', repositoryKey, targetBranch: 'refs/heads/main' };
    const cornerBoundRepo = Reflect.get(body, 'cornerBoundRepo') as (
      channelId: string,
      repo: unknown,
    ) => Promise<{ targetBranch?: string }>;

    // The Room's boundRepo snapshot still says main; a corner opening now
    // picks up the owner-confirmed staging target.
    await expect(cornerBoundRepo.call(body, roomId, roomRepo)).resolves.toMatchObject({
      repo: 'buzzy',
      repositoryKey,
      targetBranch: 'refs/heads/staging',
    });
    // The Room snapshot is immutable here. The maintenance reconciler updates
    // each registered open corner and rebases its worktree separately.
    expect(roomRepo.targetBranch).toBe('refs/heads/main');
    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  it('openSubchannel is the one place the newer target is picked up', async () => {
    const { body, workspaceRoot } = makeBody();
    stubRelay(roomId, 'staging');
    const roomRepo = { repo: 'buzzy', repositoryKey, targetBranch: 'refs/heads/main' };
    const cornerBoundRepo = vi.spyOn(body as never, 'cornerBoundRepo' as never);
    // Stop the open right after the target resolves; everything past this
    // point (channel create, worktree, ACP) needs a real relay and repo.
    vi.spyOn(body as never, 'ensureAgentInChannel' as never).mockRejectedValue(
      new Error('stop after target resolution') as never,
    );

    await expect(body.openSubchannel(roomId, roomRepo, 'add a haiku')).rejects.toThrow(
      'stop after target resolution',
    );
    expect(cornerBoundRepo).toHaveBeenCalledWith(roomId, roomRepo);
    await expect(
      cornerBoundRepo.mock.results[0]!.value as Promise<{ targetBranch?: string }>,
    ).resolves.toMatchObject({ targetBranch: 'refs/heads/staging' });
    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  it('ignores a config event bound to a different repository', async () => {
    const { body, workspaceRoot } = makeBody();
    stubRelay(roomId, 'staging');
    const cornerBoundRepo = Reflect.get(body, 'cornerBoundRepo') as (
      channelId: string,
      repo: unknown,
    ) => Promise<{ targetBranch?: string }>;

    await expect(
      cornerBoundRepo.call(body, roomId, {
        repo: 'buzzy',
        repositoryKey: 'some-other-repository',
        targetBranch: 'refs/heads/main',
      }),
    ).resolves.toMatchObject({ targetBranch: 'refs/heads/main' });
    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  it('keeps the start-time target when the Room publishes no config at all', async () => {
    const { body, workspaceRoot } = makeBody();
    stubRelay(roomId, null);
    const cornerBoundRepo = Reflect.get(body, 'cornerBoundRepo') as (
      channelId: string,
      repo: unknown,
    ) => Promise<{ targetBranch?: string }>;

    await expect(
      cornerBoundRepo.call(body, roomId, { repo: 'buzzy', targetBranch: 'refs/heads/main' }),
    ).resolves.toMatchObject({ targetBranch: 'refs/heads/main' });
    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  it('never rolls a confirmed switch back to the startup snapshot on a later read failure', async () => {
    const { body, workspaceRoot } = makeBody();
    stubRelay(roomId, 'staging');
    const current = Reflect.get(body, 'currentRoomTargetBranch') as (
      channelId: string,
      repo: unknown,
    ) => Promise<string>;
    const roomRepo = { repo: 'buzzy', repositoryKey, targetBranch: 'refs/heads/main' };
    await expect(current.call(body, roomId, roomRepo)).resolves.toBe('staging');

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('relay unavailable');
      }),
    );
    await expect(current.call(body, roomId, roomRepo)).resolves.toBe('staging');
    rmSync(workspaceRoot, { recursive: true, force: true });
  });
});

describe('an unrecognized slash command is marked, never silently executed', () => {
  const human = newIdentity('slash-human');

  function requestEvent(content: string, createdAt = 1) {
    return signEvent(
      {
        pubkey: human.publicKey,
        created_at: createdAt,
        kind: 9,
        tags: [
          ['h', 'parent-channel'],
          ['p', newIdentity('slash-agent').publicKey],
        ],
        content,
      },
      human.secretKey,
    );
  }

  function newBody() {
    return new Body({
      agentBinary: '/nonexistent',
      mcpBinary: '/nonexistent',
      agentEnv: {},
      workspaceRoot: mkdtempSync(join(tmpdir(), 'buzzy-slash-notice-unit-')),
      relayBaseUrl: 'http://relay.test',
      relayHost: 'relay.test',
      relayScheme: 'http',
      relayWsUrl: 'ws://relay.test',
      autoApprovePermissions: true,
    });
  }

  function stubPublishing(): NostrEvent[] {
    const published: NostrEvent[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        published.push(JSON.parse(String(init?.body)) as NostrEvent);
        return new Response(JSON.stringify({ accepted: true }), { status: 200 });
      }),
    );
    return published;
  }

  function stubRoomTurn(body: Body, reply: string) {
    stubEmptyAgentHistory(body);
    const client = new AcpClient({ agentBinary: '/nonexistent', agentEnv: {} });
    const prompt = vi.spyOn(client, 'sessionPrompt').mockResolvedValue({
      stopReason: 'end_turn',
      updates: [],
      agentText: reply,
      toolCalls: [],
    });
    body.registerSession({
      channelId: 'parent-channel',
      sessionId: 'readonly-session',
      client,
      mode: 'readonly',
    });
    return { prompt };
  }

  async function runReplyInRoom(body: Body, content: string) {
    const event = requestEvent(content);
    return Reflect.get(body, 'replyInRoom').call(
      body,
      'parent-channel',
      { repo: 'repo' },
      {
        eventId: event.id,
        authorPubkey: event.pubkey,
        content,
        createdAt: event.created_at,
      },
    );
  }

  const slashNotices = (published: NostrEvent[]): NostrEvent[] =>
    published.filter((event) =>
      event.tags.some((tag) => tag[0] === 't' && tag[1] === SLASH_COMMAND_NOTICE_TAG),
    );

  it.skip('marks an unknown verb as passed through to the agent, then still runs the turn', async () => {
    const body = newBody();
    const published = stubPublishing();
    const { prompt } = stubRoomTurn(body, 'What should I loop on?');

    await runReplyInRoom(body, '/loop');

    // The notice is the FIRST thing published — the reader sees whose
    // vocabulary `/loop` belongs to before any turn output.
    expect(slashNotices(published)).toHaveLength(1);
    const notice = slashNotices(published)[0]!;
    expect(published[0]).toBe(notice);
    expect(notice.tags).toContainEqual(['t', 'body-control']);
    expect(notice.tags).toContainEqual(['t', SLASH_COMMAND_NOTICE_TAG]);
    expect(notice.tags).toContainEqual(['command', 'loop']);
    expect(notice.content).toContain('/loop is not a Beeline command');
    expect(notice.content).toContain('/open-corner');
    expect(notice.content).toContain('passed to the agent as an ordinary request');
    // The text still reaches the session verbatim — prose keeps flowing.
    expect(prompt).toHaveBeenCalledWith(
      'readonly-session',
      expect.stringContaining('/loop'),
      ROOM_AGENT_PROMPT_TIMEOUT_MS,
      expect.any(Function),
      expect.any(Function),
    );
  });

  it.skip('tells the sender when typed text names a Beeline composer command', async () => {
    const body = newBody();
    const published = stubPublishing();
    const { prompt } = stubRoomTurn(body, 'ok');

    await runReplyInRoom(body, '/approve');

    const notice = slashNotices(published)[0];
    expect(slashNotices(published)).toHaveLength(1);
    expect(notice!.tags).toContainEqual(['command', 'approve']);
    expect(notice!.content).toContain('composer commands');
    expect(prompt).toHaveBeenCalledWith(
      'readonly-session',
      expect.stringContaining('/approve'),
      ROOM_AGENT_PROMPT_TIMEOUT_MS,
      expect.any(Function),
      expect.any(Function),
    );
  });

  it.each([
    '/etc/hosts is readable by everyone — is that intended?',
    'The path is /usr/bin/env in the docs.',
    'Did you check /var/log for the crash?',
  ])('never marks prose that merely starts with a slash: %j', async (content) => {
    const body = newBody();
    const published = stubPublishing();
    stubRoomTurn(body, 'ok');

    await runReplyInRoom(body, content);

    expect(slashNotices(published)).toHaveLength(0);
  });

  it.skip('does not repeat the same notice inside its quiet window', async () => {
    const body = newBody();
    const published = stubPublishing();
    stubRoomTurn(body, 'ok');

    await runReplyInRoom(body, '/loop');
    await runReplyInRoom(body, '/loop again');

    expect(slashNotices(published)).toHaveLength(1);
  });
});

describe('agent command list publishing (composer palette source of truth)', () => {
  const communityId = '33333333-3333-4333-8333-333333333333';
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

  function jsonResponse(body: unknown): Response {
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }

  it('republishes captured harness commands as a durable self-authored record, once per distinct list', async () => {
    vi.useFakeTimers();
    const agentIdentity = newIdentity('commands-agent');
    const body = new Body(config, newIdentity('operator'), agentIdentity);
    const published: NostrEvent[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        published.push(JSON.parse(String(init?.body)) as NostrEvent);
        return jsonResponse({ accepted: true });
      }),
    );

    // A stand-in for the live AcpClient: the daemon attaches a plain event
    // listener to whatever client owns the session.
    const { EventEmitter } = await import('node:events');
    const fakeClient = new EventEmitter() as unknown as AcpClient;
    (fakeClient as unknown as { sessionCommandsFor: () => unknown }).sessionCommandsFor = () => [];
    const detach = Reflect.get(body, 'attachAgentCommandPublisher').call(
      body,
      fakeClient,
      communityId,
      'sess-1',
    ) as () => void;

    fakeClient.emit('commands', {
      sessionId: 'sess-1',
      commands: [{ name: 'loop', description: 'Loop' }],
    });
    await vi.advanceTimersByTimeAsync(4_000);
    let commandEvents = published.filter((event) => event.kind === 30078);
    expect(commandEvents).toHaveLength(1);
    expect(commandEvents[0]!.pubkey).toBe(agentIdentity.publicKey);
    const tags = commandEvents[0]!.tags as string[][];
    expect(tags).toEqual(
      expect.arrayContaining([
        ['t', 'buzz-agent-commands'],
        ['h', communityId],
      ]),
    );
    expect(JSON.parse(commandEvents[0]!.content)).toEqual({
      commands: [{ name: 'loop', description: 'Loop' }],
    });

    // An identical list again costs no second write within the process.
    fakeClient.emit('commands', {
      sessionId: 'sess-1',
      commands: [{ name: 'loop', description: 'Loop' }],
    });
    await vi.advanceTimersByTimeAsync(4_000);
    commandEvents = published.filter((event) => event.kind === 30078);
    expect(commandEvents).toHaveLength(1);

    // Detaching stops capture entirely.
    detach();
    fakeClient.emit('commands', {
      sessionId: 'sess-1',
      commands: [{ name: 'different' }],
    });
    await vi.advanceTimersByTimeAsync(4_000);
    commandEvents = published.filter((event) => event.kind === 30078);
    expect(commandEvents).toHaveLength(1);
  });

  it('seeds the publisher from a session-start push that landed before the listener attached', async () => {
    vi.useFakeTimers();
    const agentIdentity = newIdentity('commands-agent');
    const body = new Body(config, newIdentity('operator'), agentIdentity);
    const published: NostrEvent[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        published.push(JSON.parse(String(init?.body)) as NostrEvent);
        return jsonResponse({ accepted: true });
      }),
    );

    // AcpClient's live fake-adapter test proves the session-start update is
    // stored before this point. Body attaches only after other awaited startup
    // work, so simulate that already-captured state with no event replay.
    const { EventEmitter } = await import('node:events');
    const fakeClient = new EventEmitter() as unknown as AcpClient;
    const sessionCommandsFor = vi.fn(() => [
      { name: 'loop', description: 'Run again and again' },
      { name: 'review', description: 'Review the diff' },
    ]);
    (
      fakeClient as unknown as { sessionCommandsFor: typeof sessionCommandsFor }
    ).sessionCommandsFor = sessionCommandsFor;
    const detach = Reflect.get(body, 'attachAgentCommandPublisher').call(
      body,
      fakeClient,
      communityId,
      'session-1',
    ) as () => void;
    expect(sessionCommandsFor).toHaveBeenCalledWith('session-1');
    await vi.advanceTimersByTimeAsync(4_000);
    const commandEvents = published.filter((event) => event.kind === 30078);
    expect(commandEvents).toHaveLength(1);
    expect(commandEvents[0]!.pubkey).toBe(agentIdentity.publicKey);
    expect(parseAgentCommands(commandEvents[0]!)?.commands).toEqual([
      { name: 'loop', description: 'Run again and again' },
      { name: 'review', description: 'Review the diff' },
    ]);
    detach();
  });

  it('still publishes nothing when the harness advertised no commands before attach', async () => {
    // Record absence IS the "does not advertise" signal: seeding from an empty
    // capture must not fabricate a record for a genuinely silent harness.
    vi.useFakeTimers();
    const body = new Body(config, newIdentity('operator'), newIdentity('commands-agent'));
    const published: NostrEvent[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        published.push(JSON.parse(String(init?.body)) as NostrEvent);
        return jsonResponse({ accepted: true });
      }),
    );
    const { EventEmitter } = await import('node:events');
    const fakeClient = new EventEmitter() as unknown as AcpClient;
    (fakeClient as unknown as { sessionCommandsFor: () => unknown }).sessionCommandsFor = () => [];
    const detach = Reflect.get(body, 'attachAgentCommandPublisher').call(
      body,
      fakeClient,
      communityId,
      'never-advertised-session',
    ) as () => void;
    await vi.advanceTimersByTimeAsync(4_000);
    expect(published.filter((event) => event.kind === 30078)).toHaveLength(0);
    detach();
  });
});
