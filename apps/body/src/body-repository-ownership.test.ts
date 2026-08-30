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
  ABANDONED_CORNER_CLOSE_REFUSED,
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
  buildMergeApproval,
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
  CHANGE_REVIEW_ARTIFACT_TAG,
  CHANGE_REVIEW_ARTIFACT_VERSION,
  CHANGE_REVIEW_EVENT_KIND,
  parseChangeReviewArtifactDescriptor,
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
import { CONCLUDE_NUDGE_SPACING_MS, MAX_CONCLUDE_NUDGES_PER_EPISODE } from './conclude-watch.js';
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
describe('room owns the repo (Stage 1)', () => {
  const config: BodyConfig = {
    agentBinary: '/nonexistent',
    mcpBinary: '/nonexistent',
    readonlyMcpCommand: '/buzz-readonly-mcp',
    agentEnv: {},
    workspaceRoot: '/tmp/buzzy-room-repo-unit',
    relayBaseUrl: 'http://relay.test',
    relayHost: 'relay.test',
    relayScheme: 'http',
    relayWsUrl: 'ws://relay.test',
    autoApprovePermissions: true,
  };

  function stubPublish(published: NostrEvent[]): void {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        published.push(JSON.parse(String(init?.body)) as NostrEvent);
        return new Response(JSON.stringify({ accepted: true }), { status: 200 });
      }),
    );
  }

  it('refuses an open-a-corner command in a repo-less Room with an actionable message', async () => {
    const body = new Body(config, newIdentity('operator'), newIdentity('agent'));
    stubEmptyAgentHistory(body);
    const open = vi.spyOn(body, 'openSubchannel');
    const create = vi.spyOn(body as never, 'createManagedSession' as never);
    const published: NostrEvent[] = [];
    stubPublish(published);

    await expect(
      Reflect.get(body, 'replyInRoom').call(
        body,
        'repo-less-room',
        undefined, // no repository resolved for this Room
        {
          eventId: 'req-1',
          authorPubkey: body.identity.publicKey,
          content: 'open a corner and add a retry helper',
          createdAt: 1,
        },
        false, // explicitCornerWork stays false because there is no repository
        'named-repository',
        undefined,
        true, // but the message IS an open-a-corner intent
      ),
    ).resolves.toEqual({ openedCorner: false, producedReply: true });

    expect(open).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(published).toHaveLength(1);
    expect(published[0]!.content).toContain("doesn't have a repository linked");
    expect(published[0]!.tags).toContainEqual(['t', 'agent-message']);
  });

  it('reaps a stray corner worktree while preserving a live one', async () => {
    const root = mkdtempSync(join(tmpdir(), 'buzzy-prune-'));
    const gitEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1' };
    const srcCheckout = join(root, 'proj');
    const runGit = (cwd: string, args: string[]) =>
      spawnSync('git', args, { cwd, env: gitEnv, encoding: 'utf8' });
    spawnSync('git', ['init', '-q', srcCheckout], { env: gitEnv, encoding: 'utf8' });
    runGit(srcCheckout, ['config', 'user.email', 't@t.local']);
    runGit(srcCheckout, ['config', 'user.name', 'test']);
    await writeFile(join(srcCheckout, 'README.md'), '# proj\n');
    runGit(srcCheckout, ['add', '.']);
    runGit(srcCheckout, ['commit', '-qm', 'init']);

    // Corners pool is the hidden sibling of the source checkout.
    const pool = join(root, '.beeline-corners', 'proj');
    const liveDir = join(pool, 'live-corner');
    const strayDir = join(pool, 'stray-corner');
    // A real, git-registered worktree that a live corner still backs.
    runGit(srcCheckout, ['worktree', 'add', '-q', '-b', 'feature/live', liveDir]);
    // A stray directory git never tracked (crash litter) — must be reaped.
    await writeFile(join(root, '.beeline-corners', 'proj', '.keep'), '').catch(() => undefined);
    const { mkdirSync } = await import('node:fs');
    mkdirSync(strayDir, { recursive: true });
    await writeFile(join(strayDir, 'leftover.txt'), 'litter');

    const body = new Body(
      { ...config, workspaceRoot: root },
      newIdentity('operator'),
      newIdentity('agent'),
    );
    // Register the live corner so the prune must preserve it.
    Reflect.get(body, 'subchannels').set('live-corner', { worktreePath: liveDir });

    const { existsSync } = await import('node:fs');
    await Reflect.get(body, 'pruneStrayCornerWorktrees').call(body, {
      repo: 'proj',
      localPath: srcCheckout,
    });

    expect(existsSync(liveDir)).toBe(true);
    expect(existsSync(strayDir)).toBe(false);

    await rm(root, { recursive: true, force: true });
  });

  it('throttles the prune so it does not run every maintenance tick', async () => {
    const body = new Body(config, newIdentity('operator'), newIdentity('agent'));
    Reflect.set(body, 'lastWorktreePruneAt', Date.now());
    const registered = vi.spyOn(body as never, 'registeredWorktrees' as never);
    await Reflect.get(body, 'pruneStrayCornerWorktrees').call(body, {
      repo: 'proj',
      localPath: '/does/not/matter',
    });
    expect(registered).not.toHaveBeenCalled();
  });
});

/**
 * A corner the daemon cannot serve — worktree gone after a restart, approved
 * repository unresolvable, ACP session dead — used to be reachable by nothing.
 * `#t=buzz-corner-close` is only ever consumed by `pollMembers`, and
 * `pollMembers` only ever visits `this.subchannels`, so every press of the
 * human close control just added its literal text to the transcript and the
 * corner stayed open (and pinned in its parent Room) forever.
 */
describe('closing a corner with no live session', () => {
  const CREATE_KIND = 9007;

  function newBody(agent: ReturnType<typeof newIdentity>, workspaceRoot: string) {
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
    );
  }

  /** The immutable kind:9007 create event that proves a channel is a corner. */
  function cornerCreateEvent(
    agent: ReturnType<typeof newIdentity>,
    subchannelId: string,
    parentChannelId: string,
  ): NostrEvent {
    return signEvent(
      {
        pubkey: agent.publicKey,
        created_at: Math.floor(Date.now() / 1000),
        kind: CREATE_KIND,
        tags: [
          ['h', subchannelId],
          ['parent', parentChannelId],
        ],
        content: '',
      },
      agent.secretKey,
    );
  }

  function closeEvent(human: ReturnType<typeof newIdentity>, subchannelId: string): NostrEvent {
    return signEvent(
      {
        pubkey: human.publicKey,
        created_at: Math.floor(Date.now() / 1000),
        kind: 9,
        tags: [
          ['h', subchannelId],
          ['t', CORNER_CLOSE_TAG],
        ],
        content: 'Close this corner.',
      },
      human.secretKey,
    );
  }

  /** Serve corner create events to `/query`, record every publish. */
  function stubRelayHttp(creates: NostrEvent[]): NostrEvent[] {
    const published: NostrEvent[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        if (String(input).endsWith('/query')) {
          return new Response(JSON.stringify(creates), { status: 200 });
        }
        published.push(JSON.parse(String(init?.body)) as NostrEvent);
        return new Response(JSON.stringify({ accepted: true }), { status: 200 });
      }),
    );
    return published;
  }

  it('settles an archived restored review artifact instead of retrying it from maintenance', async () => {
    const agent = newIdentity('restored-archived-artifact-agent');
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'buzzy-restored-archived-artifact-'));
    const source = join(workspaceRoot, 'source');
    const cornerPath = join(workspaceRoot, '.worktrees', 'corner-archived-artifact');
    const gitRun = (cwd: string, args: string[]) => {
      const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
      if (result.status !== 0) throw new Error(String(result.stderr));
      return result.stdout.trim();
    };
    try {
      mkdirSync(source, { recursive: true });
      gitRun(source, ['init', '-q', '-b', 'main']);
      gitRun(source, ['config', 'user.name', 'Restart Test']);
      gitRun(source, ['config', 'user.email', 'restart@test.invalid']);
      writeFileSync(join(source, 'README.md'), 'before\n');
      gitRun(source, ['add', 'README.md']);
      gitRun(source, ['commit', '-q', '-m', 'seed']);
      gitRun(source, ['worktree', 'add', '-q', '-b', 'feature/archived-artifact', cornerPath, 'main']);
      writeFileSync(join(cornerPath, 'README.md'), 'after\n');
      gitRun(cornerPath, ['add', 'README.md']);
      gitRun(cornerPath, ['commit', '-q', '-m', 'feature change']);
      const tip = gitRun(cornerPath, ['rev-parse', 'HEAD']);

      const create = cornerCreateEvent(agent, 'corner-archived-artifact', 'room-archived-artifact');
      const ready = signEvent(
        {
          pubkey: agent.publicKey,
          created_at: 2,
          kind: 9,
          tags: [
            ['h', 'corner-archived-artifact'],
            ['t', 'merge-ready'],
            ['parent', 'room-archived-artifact'],
            ['feature', 'feature/archived-artifact'],
            ['repo', 'proj'],
            ['branch', 'refs/heads/main'],
            ['tip', tip],
          ],
          content: 'Work is ready for human merge approval.',
        },
        agent.secretKey,
      );
      stubRelayHttp([create]);
      mocks.createBuzzClient.mockReturnValue({
        listSubchannels: async () => ['corner-archived-artifact'],
        // The relay's archive projection can lag its publish refusal.
        getChannelMetadata: async () => ({ archived: false }),
        disconnect: () => undefined,
      } as never);

      const body = newBody(agent, workspaceRoot);
      vi.spyOn(body as never, 'channelCommunityId' as never).mockResolvedValue(undefined as never);
      Reflect.set(body, 'agentRelay', {
        queryEvents: vi.fn(async (filters: Array<Record<string, unknown>>) => {
          const filter = filters[0] ?? {};
          if ((filter.kinds as number[] | undefined)?.includes(9007)) return [create];
          if ((filter['#h'] as string[] | undefined)?.includes('room-archived-artifact')) return [];
          return [ready];
        }),
      });
      vi.spyOn(body as never, 'createManagedSession' as never).mockResolvedValue({
        channelId: 'corner-archived-artifact',
        sessionId: 'restored-session',
        client: { activeRunId: () => undefined },
        mode: 'edit',
        parentChannelId: 'room-archived-artifact',
        worktreePath: cornerPath,
        featureBranch: 'feature/archived-artifact',
      } as never);
      const publishMergeReady = vi
        .spyOn(body as never, 'publishMergeReady' as never)
        .mockRejectedValue(
          new Error(
            'publishEvent kind=30078 failed: HTTP 400 {"error":"This Room is archived and no longer accepts messages"}',
          ),
        );
      const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);

      await Reflect.get(body, 'restoreSubchannels').call(body, 'room-archived-artifact', {
        repo: 'proj',
        targetBranch: 'refs/heads/main',
      });
      const info = body.getSubchannels().get('corner-archived-artifact')!;
      expect(info.observedReviewTip).toBe(tip);
      expect(info.commitWatchFailure).toBeUndefined();

      await Reflect.get(body, 'pollCornerCommitWatch').call(body);
      expect(publishMergeReady).toHaveBeenCalledTimes(1);
      expect(
        errors.mock.calls.filter(([message]) =>
          String(message).includes('review artifact publish refused because its Room is archived'),
        ),
      ).toHaveLength(1);
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('resumes one commissioned corner once per daemon process and attributes it to the original request', async () => {
    const agent = newIdentity('restart-continuation-agent');
    const captain = newIdentity('restart-continuation-captain');
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'buzzy-restart-continuation-'));
    const source = join(workspaceRoot, 'source');
    const cornerPath = join(workspaceRoot, '.worktrees', 'corner-resume');
    const gitRun = (cwd: string, args: string[]) => {
      const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
      if (result.status !== 0) throw new Error(String(result.stderr));
    };
    try {
      mkdirSync(source, { recursive: true });
      gitRun(source, ['init', '-q', '-b', 'main']);
      gitRun(source, ['config', 'user.name', 'Restart Test']);
      gitRun(source, ['config', 'user.email', 'restart@test.invalid']);
      writeFileSync(join(source, 'README.md'), 'commissioned\n');
      gitRun(source, ['add', 'README.md']);
      gitRun(source, ['commit', '-q', '-m', 'seed']);
      gitRun(source, ['worktree', 'add', '-q', '-b', 'feature/resume', cornerPath, 'main']);

      const request = signEvent(
        {
          pubkey: captain.publicKey,
          created_at: 1,
          kind: 9,
          tags: [['h', 'room-resume']],
          content: 'Finish the commissioned change.',
        },
        captain.secretKey,
      );
      const control = signEvent(
        {
          pubkey: agent.publicKey,
          created_at: 2,
          kind: 9,
          tags: [
            ['h', 'corner-resume'],
            ['feature', 'feature/resume'],
            ['parent', 'room-resume'],
            ['request', request.id],
          ],
          content: 'corner opened',
        },
        agent.secretKey,
      );
      const create = cornerCreateEvent(agent, 'corner-resume', 'room-resume');
      stubRelayHttp([create]);
      mocks.createBuzzClient.mockReturnValue({
        listSubchannels: async () => ['corner-resume'],
        getChannelMetadata: async () => ({ archived: false }),
        disconnect: () => undefined,
      } as never);

      const prepareBody = () => {
        const body = newBody(agent, workspaceRoot);
        vi.spyOn(body as never, 'channelCommunityId' as never).mockResolvedValue(
          undefined as never,
        );
        Reflect.set(body, 'agentRelay', {
          queryEvents: vi.fn(async (filters: Array<Record<string, unknown>>) => {
            const filter = filters[0] ?? {};
            if ((filter.kinds as number[] | undefined)?.includes(9007)) return [create];
            if ((filter['#h'] as string[] | undefined)?.includes('room-resume')) return [request];
            return [control];
          }),
        });
        vi.spyOn(body as never, 'createManagedSession' as never).mockResolvedValue({
          channelId: 'corner-resume',
          sessionId: 'restored-session',
          client: {},
          mode: 'edit',
          parentChannelId: 'room-resume',
          worktreePath: cornerPath,
          featureBranch: 'feature/resume',
        } as never);
        const start = vi
          .spyOn(body as never, 'startAgentTask' as never)
          .mockImplementation(() => undefined as never);
        return { body, start };
      };

      const first = prepareBody();
      await Reflect.get(first.body, 'restoreSubchannels').call(first.body, 'room-resume', {
        repo: 'proj',
        targetBranch: 'refs/heads/main',
      });
      expect(first.start).toHaveBeenCalledOnce();
      expect(first.start.mock.calls[0]![3]).toEqual({
        requestId: request.id,
        originalRequestId: request.id,
        cause: 'restart-continuation',
      });
      expect(first.start.mock.calls[0]![2]).toContain('Continue from the existing worktree');

      // A Room watchdog may construct another Body without restarting the
      // daemon. The process-wide cap still forbids a second continuation.
      const recycled = prepareBody();
      await Reflect.get(recycled.body, 'restoreSubchannels').call(recycled.body, 'room-resume', {
        repo: 'proj',
        targetBranch: 'refs/heads/main',
      });
      expect(recycled.start).not.toHaveBeenCalled();
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  /**
   * A restart is not a fact about the task. The live failure (2026-08-23):
   * every daemon restart re-drove corners parked on needs-attention cards
   * (moved target, failed delivery), and each re-drive republished fresh
   * working/needs-attention cards — re-golding the Room deck while nobody
   * was working. A parked corner must stay parked; only a corner that was
   * actively working when the daemon died earns an auto-resume.
   */
  it('does not re-drive a corner parked on needs-attention after a restart', async () => {
    const agent = newIdentity('restart-parked-agent');
    const captain = newIdentity('restart-parked-captain');
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'buzzy-restart-parked-'));
    const source = join(workspaceRoot, 'source');
    const cornerPath = join(workspaceRoot, '.worktrees', 'corner-parked');
    const gitRun = (cwd: string, args: string[]) => {
      const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
      if (result.status !== 0) throw new Error(String(result.stderr));
    };
    try {
      mkdirSync(source, { recursive: true });
      gitRun(source, ['init', '-q', '-b', 'main']);
      gitRun(source, ['config', 'user.name', 'Restart Test']);
      gitRun(source, ['config', 'user.email', 'restart@test.invalid']);
      writeFileSync(join(source, 'README.md'), 'parked\n');
      gitRun(source, ['add', 'README.md']);
      gitRun(source, ['commit', '-q', '-m', 'seed']);
      gitRun(source, ['worktree', 'add', '-q', '-b', 'feature/parked', cornerPath, 'main']);

      const request = signEvent(
        {
          pubkey: captain.publicKey,
          created_at: 1,
          kind: 9,
          tags: [['h', 'room-parked']],
          content: 'Finish the commissioned change.',
        },
        captain.secretKey,
      );
      const control = signEvent(
        {
          pubkey: agent.publicKey,
          created_at: 2,
          kind: 9,
          tags: [
            ['h', 'corner-parked'],
            ['feature', 'feature/parked'],
            ['parent', 'room-parked'],
            ['request', request.id],
          ],
          content: 'corner opened',
        },
        agent.secretKey,
      );
      // The corner's standing verdict is needs-attention: a status card newer
      // than any work signal. THE oracle resolves this to needs-attention.
      const parkedCard = signEvent(
        {
          pubkey: agent.publicKey,
          created_at: Math.floor(Date.now() / 1000),
          kind: 9,
          tags: [
            ['h', 'corner-parked'],
            ['t', 'body-control'],
            ['display-status', 'needs-attention'],
          ],
          content: "Couldn't land on main — waiting on you.",
        },
        agent.secretKey,
      );
      stubRelayHttp([]);
      mocks.createBuzzClient.mockReturnValue({
        listSubchannels: async () => ['corner-parked'],
        getChannelMetadata: async () => ({ archived: false }),
        disconnect: () => undefined,
      } as never);

      const body = newBody(agent, workspaceRoot);
      vi.spyOn(body as never, 'channelCommunityId' as never).mockResolvedValue(undefined as never);
      Reflect.set(body, 'agentRelay', {
        queryEvents: vi.fn(async (filters: Array<Record<string, unknown>>) => {
          const filter = filters[0] ?? {};
          if ((filter.kinds as number[] | undefined)?.includes(9007)) {
            return [cornerCreateEvent(agent, 'corner-parked', 'room-parked')];
          }
          if ((filter['#h'] as string[] | undefined)?.includes('room-parked')) return [request];
          return [control, parkedCard];
        }),
      });
      vi.spyOn(body as never, 'createManagedSession' as never).mockResolvedValue({
        channelId: 'corner-parked',
        sessionId: 'restored-session',
        client: {},
        mode: 'edit',
        parentChannelId: 'room-parked',
        worktreePath: cornerPath,
        featureBranch: 'feature/parked',
      } as never);
      const start = vi
        .spyOn(body as never, 'startAgentTask' as never)
        .mockImplementation(() => undefined as never);

      await Reflect.get(body, 'restoreSubchannels').call(body, 'room-parked', {
        repo: 'proj',
        targetBranch: 'refs/heads/main',
      });

      // Still served — readable and closable — but NOT re-driven...
      expect(body.getSubchannels().has('corner-parked')).toBe(true);
      expect(start).not.toHaveBeenCalled();
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  /** A needs-attention parent card is only ever a state TRANSITION, compared
   * against the daemon's in-memory state record baseline. */
  it('suppresses a restated needs-attention card but publishes a real transition', async () => {
    const agent = newIdentity('attention-transition-agent');
    const workspaceRoot = '/workspace';
    const body = newBody(agent, workspaceRoot);
    const now = Math.floor(Date.now() / 1000);
    const standingCard = signEvent(
      {
        pubkey: agent.publicKey,
        created_at: now - 60,
        kind: 9,
        tags: [
          ['h', 'corner-restated'],
          ['t', 'body-control'],
          ['display-status', 'needs-attention'],
        ],
        content: 'Nothing committed is ready for review.',
      },
      agent.secretKey,
    );
    let standing: NostrEvent[] = [standingCard];
    Reflect.set(body, 'agentRelay', {
      queryEvents: vi.fn(async () => standing),
    });
    const published = stubRelayHttp([]);

    const info = {
      subchannelId: 'corner-restated',
      featureBranch: 'feature/restated',
      session: { sessionId: 's1', parentChannelId: 'room-restated' },
      cornerState: { state: 'waiting', reason: 'failure' },
    } as never;
    await Reflect.get(body, 'postParentCornerStatus').call(
      body,
      info,
      'needs-attention',
      'Nothing committed is ready for review.',
    );
    expect(published).toHaveLength(0);

    // A real transition — the corner was live before — publishes.
    standing = [];
    (info as unknown as { cornerState: { state: string } }).cornerState = { state: 'working' };
    await Reflect.get(body, 'postParentCornerStatus').call(
      body,
      info,
      'needs-attention',
      'Work stopped. Open corner for details.',
    );
    expect(published).toHaveLength(1);
    expect(published[0]!.tags).toContainEqual(['display-status', 'needs-attention']);
    expect(published[0]!.tags).toContainEqual(['subchannel', 'corner-restated']);

    // Relay history is no longer consulted: a non-waiting in-memory state
    // publishes even when the read client is unavailable.
    Reflect.set(body, 'agentRelay', {
      queryEvents: vi.fn(async () => {
        throw new Error('relay down');
      }),
    });
    await Reflect.get(body, 'postParentCornerStatus').call(
      body,
      info,
      'needs-attention',
      'Delivery failed.',
    );
    expect(published).toHaveLength(2);
  });

  it('records a corner whose worktree is gone as abandoned, instead of leaving it in no map at all', async () => {
    const agent = newIdentity('restore-gap-agent');
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'buzzy-restore-gap-'));
    try {
      const body = newBody(agent, workspaceRoot);
      const control = signEvent(
        {
          pubkey: agent.publicKey,
          created_at: Math.floor(Date.now() / 1000),
          kind: 9,
          tags: [
            ['h', 'corner-lost'],
            ['feature', 'feature/lost-work'],
            ['parent', 'room-lost'],
          ],
          content: 'corner opened',
        },
        agent.secretKey,
      );
      mocks.createBuzzClient.mockReturnValue({
        listSubchannels: async () => ['corner-lost'],
        getChannelMetadata: async () => ({ archived: false }),
        disconnect: () => undefined,
      } as never);
      Reflect.set(body, 'agentRelay', { queryEvents: vi.fn(async () => [control]) });
      stubRelayHttp([]);

      await Reflect.get(body, 'restoreSubchannels').call(body, 'room-lost', {
        repo: 'proj',
        localPath: join(workspaceRoot, 'checkout'),
        targetBranch: 'refs/heads/main',
      });

      // Not restorable, so deliberately not a live corner...
      expect(body.getSubchannels().has('corner-lost')).toBe(false);
      // ...but still reachable by the sessionless close path.
      const abandoned = body.getAbandonedCorners().get('corner-lost');
      expect(abandoned).toMatchObject({
        subchannelId: 'corner-lost',
        parentChannelId: 'room-lost',
        featureBranch: 'feature/lost-work',
      });
      expect(abandoned?.reason).toContain('worktree was missing');
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  /**
   * A restart-time card describes a condition that does not change on its own,
   * so republishing it on every restart is not news — it is one line per
   * restart. The captain's Room took ~17 restarts in a day, which is exactly
   * how deep every self-republishing daemon message stacked.
   */
  it('says an unrestorable approved repository once, not once per restart', async () => {
    const agent = newIdentity('restore-repo-agent');
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'buzzy-restore-repo-'));
    try {
      const body = newBody(agent, workspaceRoot);
      // No `repo` tag, so the approved target cannot be resolved at all.
      const control = signEvent(
        {
          pubkey: agent.publicKey,
          created_at: Math.floor(Date.now() / 1000),
          kind: 9,
          tags: [
            ['h', 'corner-norepo'],
            ['feature', 'feature/no-repo'],
            ['parent', 'room-norepo'],
          ],
          content: 'corner opened',
        },
        agent.secretKey,
      );
      mocks.createBuzzClient.mockReturnValue({
        listSubchannels: async () => ['corner-norepo'],
        getChannelMetadata: async () => ({ archived: false }),
        disconnect: () => undefined,
      } as never);
      let cornerEvents: NostrEvent[] = [control];
      Reflect.set(body, 'agentRelay', { queryEvents: vi.fn(async () => cornerEvents) });
      const published = stubRelayHttp([]);
      const restore = Reflect.get(body, 'restoreSubchannels') as (
        ...args: unknown[]
      ) => Promise<void>;

      // First restart: the corner is told, once.
      await restore.call(body, 'room-norepo', undefined);
      const cards = () =>
        published.filter((event) => event.content.startsWith(CORNER_APPROVED_REPO_UNRESTORABLE));
      expect(cards()).toHaveLength(1);
      expect(body.getAbandonedCorners().get('corner-norepo')?.reason).toContain(
        'approved repository',
      );

      // Second restart, same unchanged condition: the corner's own newest
      // status card already says this, so nothing new is published.
      cornerEvents = [control, ...cards()];
      await restore.call(body, 'room-norepo', undefined);
      expect(cards()).toHaveLength(1);
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('closes an abandoned corner on a human close request: archived on the relay, and the parent Room told so its pin goes terminal', async () => {
    const agent = newIdentity('dead-close-agent');
    const human = newIdentity('dead-close-human');
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'buzzy-dead-close-'));
    try {
      const body = newBody(agent, workspaceRoot);
      stubEmptyAgentHistory(body);
      Reflect.get(body, 'abandonedCorners').set('corner-dead', {
        subchannelId: 'corner-dead',
        parentChannelId: 'room-dead',
        reason: 'its worktree was missing after a restart',
        featureBranch: 'feature/dead-work',
      });
      const close = closeEvent(human, 'corner-dead');
      Reflect.set(body, 'agentRelay', { queryEvents: vi.fn(async () => [close]) });
      const published = stubRelayHttp([cornerCreateEvent(agent, 'corner-dead', 'room-dead')]);

      await Reflect.get(body, 'pollAbandonedCornerCloses').call(body, 'room-dead');

      // The parent Room's corner-status card goes terminal, which is what
      // clears the stale "ready for review" pin on the Room list.
      const parentCard = published.find((event) =>
        event.tags.some((tag) => tag[0] === 'h' && tag[1] === 'room-dead'),
      );
      expect(parentCard).toBeDefined();
      expect(parentCard!.tags).toContainEqual(['subchannel', 'corner-dead']);
      expect(parentCard!.tags).toContainEqual(['status', 'archived']);

      // The corner itself is archived on the relay (kind:9002 archived=true).
      const archiveCommand = published.find(
        (event) =>
          event.kind === 9002 &&
          event.tags.some((tag) => tag[0] === 'archived' && tag[1] === 'true'),
      );
      expect(archiveCommand).toBeDefined();
      expect(archiveCommand!.tags).toContainEqual(['h', 'corner-dead']);

      // Closed for good: nothing left to re-close on a later tick.
      expect(body.getAbandonedCorners().has('corner-dead')).toBe(false);
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('fresh-checks mission authority before closing an abandoned corner', async () => {
    const agent = newIdentity('dead-mission-close-agent');
    const human = newIdentity('dead-mission-close-human');
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'buzzy-dead-mission-close-'));
    try {
      const body = newBody(agent, workspaceRoot);
      const admit = vi
        .spyOn(body as never, 'beginMissionCornerClose' as never)
        .mockRejectedValue(new Error('mission grant revoked') as never);
      Reflect.get(body, 'abandonedCorners').set('corner-dead-mission', {
        subchannelId: 'corner-dead-mission',
        parentChannelId: 'room-dead-mission',
        reason: 'its worktree was missing after a restart',
        mission: {
          missionId: 'mission-one',
          grantEventId: 'a'.repeat(64),
          controllerAgentPubkey: agent.publicKey,
          principalPubkey: human.publicKey,
          targetAgentPubkey: agent.publicKey,
          workspaceId: 'workspace-one',
          roomId: 'room-dead-mission',
          repository: { key: 'github:123', targetBranch: 'refs/heads/main' },
        },
      });
      const close = closeEvent(human, 'corner-dead-mission');
      Reflect.set(body, 'agentRelay', { queryEvents: vi.fn(async () => [close]) });
      const published = stubRelayHttp([
        cornerCreateEvent(agent, 'corner-dead-mission', 'room-dead-mission'),
      ]);

      await Reflect.get(body, 'pollAbandonedCornerCloses').call(body, 'room-dead-mission');

      expect(admit).toHaveBeenCalledOnce();
      expect(body.getAbandonedCorners().has('corner-dead-mission')).toBe(true);
      expect(published.some((event) => event.kind === 9002)).toBe(false);
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('reaps the corner worktree when one is still on disk, and says what a close did and did not discard', async () => {
    const agent = newIdentity('reap-close-agent');
    const human = newIdentity('reap-close-human');
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'buzzy-reap-close-'));
    try {
      const body = newBody(agent, workspaceRoot);
      stubEmptyAgentHistory(body);
      const worktreePath = join(workspaceRoot, 'corner-reap-worktree');
      mkdirSync(worktreePath, { recursive: true });
      spawnSync('git', ['init', '-q', worktreePath]);
      writeFileSync(join(worktreePath, 'scratch.txt'), 'uncommitted edit\n');

      Reflect.get(body, 'abandonedCorners').set('corner-reap', {
        subchannelId: 'corner-reap',
        parentChannelId: 'room-reap',
        reason: 'its agent session could not be restarted',
        featureBranch: 'feature/reap-work',
        worktreePath,
      });
      const close = closeEvent(human, 'corner-reap');
      Reflect.set(body, 'agentRelay', { queryEvents: vi.fn(async () => [close]) });
      const published = stubRelayHttp([cornerCreateEvent(agent, 'corner-reap', 'room-reap')]);

      await Reflect.get(body, 'pollAbandonedCornerCloses').call(body, 'room-reap');

      expect(existsSync(worktreePath)).toBe(false);
      const parentCard = published.find((event) =>
        event.tags.some((tag) => tag[0] === 'h' && tag[1] === 'room-reap'),
      );
      // A close is never a silent discard.
      expect(parentCard!.content).toContain('Uncommitted edits');
      expect(parentCard!.content).toContain('could not be restarted');
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('leaves a quiet abandoned corner open: only an actual close request closes it', async () => {
    const agent = newIdentity('quiet-corner-agent');
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'buzzy-quiet-corner-'));
    try {
      const body = newBody(agent, workspaceRoot);
      Reflect.get(body, 'abandonedCorners').set('corner-quiet', {
        subchannelId: 'corner-quiet',
        parentChannelId: 'room-quiet',
        reason: 'its worktree was missing after a restart',
      });
      const chatter = signEvent(
        {
          pubkey: agent.publicKey,
          created_at: Math.floor(Date.now() / 1000),
          kind: 9,
          tags: [['h', 'corner-quiet']],
          content: 'just talking',
        },
        agent.secretKey,
      );
      Reflect.set(body, 'agentRelay', { queryEvents: vi.fn(async () => [chatter]) });
      const published = stubRelayHttp([cornerCreateEvent(agent, 'corner-quiet', 'room-quiet')]);

      await Reflect.get(body, 'pollAbandonedCornerCloses').call(body, 'room-quiet');

      expect(published).toHaveLength(0);
      expect(body.getAbandonedCorners().has('corner-quiet')).toBe(true);
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('never lets the agent close its own corner: only a human close request counts', async () => {
    const agent = newIdentity('self-close-agent');
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'buzzy-self-close-'));
    try {
      const body = newBody(agent, workspaceRoot);
      Reflect.get(body, 'abandonedCorners').set('corner-self', {
        subchannelId: 'corner-self',
        parentChannelId: 'room-self',
        reason: 'its worktree was missing after a restart',
      });
      // Same tag, signed by the agent identity rather than a human.
      const agentClose = closeEvent(agent, 'corner-self');
      Reflect.set(body, 'agentRelay', { queryEvents: vi.fn(async () => [agentClose]) });
      const published = stubRelayHttp([cornerCreateEvent(agent, 'corner-self', 'room-self')]);

      await Reflect.get(body, 'pollAbandonedCornerCloses').call(body, 'room-self');

      expect(published).toHaveLength(0);
      expect(body.getAbandonedCorners().has('corner-self')).toBe(true);
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('retries a close whose relay publish failed, rather than marking it delivered and never trying again', async () => {
    const agent = newIdentity('close-retry-agent');
    const human = newIdentity('close-retry-human');
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'buzzy-close-retry-'));
    try {
      const body = newBody(agent, workspaceRoot);
      Reflect.get(body, 'abandonedCorners').set('corner-retry', {
        subchannelId: 'corner-retry',
        parentChannelId: 'room-retry',
        reason: 'its worktree was missing after a restart',
      });
      const close = closeEvent(human, 'corner-retry');
      Reflect.set(body, 'agentRelay', { queryEvents: vi.fn(async () => [close]) });
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: string | URL | Request) => {
          if (String(input).endsWith('/query')) {
            return new Response(
              JSON.stringify([cornerCreateEvent(agent, 'corner-retry', 'room-retry')]),
              { status: 200 },
            );
          }
          return new Response('relay unavailable', { status: 503 });
        }),
      );
      const durableState = Reflect.get(body, 'durableState') as {
        failed: (channelId: string, eventId: string, error: unknown) => Promise<number>;
        delivered: (channelId: string, eventId: string) => Promise<void>;
      };
      const failedSpy = vi.spyOn(durableState, 'failed');
      const deliveredSpy = vi.spyOn(durableState, 'delivered');

      await Reflect.get(body, 'pollAbandonedCornerCloses').call(body, 'room-retry');

      expect(failedSpy).toHaveBeenCalledWith('corner-retry', close.id, expect.anything());
      expect(deliveredSpy).not.toHaveBeenCalled();
      // Still on the books, so the next maintenance tick tries again.
      expect(body.getAbandonedCorners().has('corner-retry')).toBe(true);
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('refuses to archive a channel the relay does not link to this Room, even when it is on the abandoned list', () => {
    expect(() => assertRelayCornerArchiveTarget('corner', 'room', 'room')).not.toThrow();
    // A top-level Room or Workspace has no parent link at all.
    expect(() => assertRelayCornerArchiveTarget('room', null, 'room')).toThrow('non-corner');
    // A self-referencing link is not a parent.
    expect(() => assertRelayCornerArchiveTarget('corner', 'corner', 'corner')).toThrow(
      'non-corner',
    );
    // A corner belonging to some other Room is not this Body's to archive.
    expect(() => assertRelayCornerArchiveTarget('corner', 'other-room', 'room')).toThrow(
      'non-corner',
    );
  });

  it('still refuses a corner it has never heard of, so the abandoned path did not weaken archiveSubchannel', async () => {
    const agent = newIdentity('unknown-corner-agent');
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'buzzy-unknown-corner-'));
    try {
      const body = newBody(agent, workspaceRoot);
      await expect(body.archiveSubchannel('corner-never-seen')).rejects.toThrow('not found');
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('completes a healthy corner close even when the dead ACP session throws on teardown', async () => {
    const agent = newIdentity('wedged-session-agent');
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'buzzy-wedged-session-'));
    try {
      const sourcePath = join(workspaceRoot, 'source');
      const worktreePath = join(workspaceRoot, 'corner-wedged');
      mkdirSync(sourcePath, { recursive: true });
      spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: sourcePath });
      spawnSync('git', ['config', 'user.name', 'Close Test'], { cwd: sourcePath });
      spawnSync('git', ['config', 'user.email', 'close@test.invalid'], { cwd: sourcePath });
      writeFileSync(join(sourcePath, 'README.md'), 'kept on the branch\n');
      spawnSync('git', ['add', 'README.md'], { cwd: sourcePath });
      spawnSync('git', ['commit', '-q', '-m', 'seed'], { cwd: sourcePath });
      spawnSync('git', ['worktree', 'add', '-q', '-b', 'feature/wedged', worktreePath, 'main'], {
        cwd: sourcePath,
      });
      writeFileSync(join(worktreePath, 'corner.txt'), 'corner commit survives cleanup\n');
      spawnSync('git', ['add', 'corner.txt'], { cwd: worktreePath });
      spawnSync('git', ['commit', '-q', '-m', 'corner work'], { cwd: worktreePath });

      const body = newBody(agent, workspaceRoot);
      stubEmptyAgentHistory(body);
      body.registerSubchannel({
        subchannelId: 'corner-wedged',
        worktreePath,
        featureBranch: 'feature/wedged',
        boundRepo: {
          repo: 'test',
          localPath: sourcePath,
          targetBranch: 'refs/heads/main',
        },
        role: agent,
        session: {
          channelId: 'corner-wedged',
          parentChannelId: 'room-wedged',
          sessionId: 'session',
          mode: 'edit',
          archived: false,
          client: {
            sessionCancel: () => {
              throw new Error('backend is gone');
            },
            stop: async () => {
              throw new Error('backend is gone');
            },
          },
        } as never,
        lastPolledAt: 0,
        archived: false,
      } as never);
      const published = stubRelayHttp([cornerCreateEvent(agent, 'corner-wedged', 'room-wedged')]);

      await body.archiveSubchannel('corner-wedged');

      expect(
        published.some(
          (event) =>
            event.kind === 9002 &&
            event.tags.some((tag) => tag[0] === 'archived' && tag[1] === 'true'),
        ),
      ).toBe(true);
      expect(body.getSubchannels().has('corner-wedged')).toBe(false);
      expect(existsSync(worktreePath)).toBe(false);
      expect(
        spawnSync('git', ['rev-parse', '--verify', 'refs/heads/feature/wedged'], {
          cwd: sourcePath,
        }).status,
      ).toBe(0);
      expect(
        spawnSync('git', ['worktree', 'list', '--porcelain'], {
          cwd: sourcePath,
          encoding: 'utf8',
        }).stdout,
      ).not.toContain(worktreePath);
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });
});

describe('a corner records the objective it was opened for', () => {
  afterEach(() => vi.unstubAllGlobals());

  it("writes the human's own task onto the corner's immutable create event", async () => {
    // The corner's *name* is a 42-char slug, and its transcript's opening
    // messages fall out of the cold-backfill window on a busy corner — so the
    // objective the pinned panel reads has to live somewhere permanent and
    // cheap to read. The create event is both.
    const published: NostrEvent[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        published.push(JSON.parse(String(init?.body)) as NostrEvent);
        return new Response(JSON.stringify({ accepted: true }), { status: 200 });
      }),
    );

    const agent = newIdentity('agent');
    const human = newIdentity('human');
    await createAgentSubchannel(
      agent,
      'parent-room',
      'add-color-to-code-blocks',
      human.publicKey,
      undefined,
      'add color to code blocks',
    );

    const create = published.find((event) => event.kind === 9007);
    expect(create).toBeDefined();
    expect(create!.tags.find((tag) => tag[0] === 'task')?.[1]).toBe('add color to code blocks');
    expect(create!.tags.find((tag) => tag[0] === 'parent')?.[1]).toBe('parent-room');
    expect(
      published.some(
        (event) =>
          event.kind === 9000 &&
          event.tags.some((tag) => tag[0] === 'h' && tag[1] === create!.tags[0]![1]) &&
          event.tags.some((tag) => tag[0] === 'p' && tag[1] === human.publicKey),
      ),
    ).toBe(true);
  });

  it('writes no task tag at all when the request named no describable work', async () => {
    // `taskDescriptionFromCornerRequest` returns '' for a bare "open a corner".
    // An empty-but-present tag would read as an objective of "" on the client;
    // absence is the honest answer and falls back to the corner's name.
    const published: NostrEvent[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        published.push(JSON.parse(String(init?.body)) as NostrEvent);
        return new Response(JSON.stringify({ accepted: true }), { status: 200 });
      }),
    );

    await createAgentSubchannel(
      newIdentity('agent'),
      'parent-room',
      'corner-parent-',
      newIdentity('human').publicKey,
      undefined,
    );

    const create = published.find((event) => event.kind === 9007);
    expect(create!.tags.some((tag) => tag[0] === 'task')).toBe(false);
  });

  it('refuses to create a normal agent-only corner', async () => {
    const agent = newIdentity('agent');
    await expect(
      createAgentSubchannel(agent, 'parent-room', 'corrupt-corner', agent.publicKey),
    ).rejects.toThrow('a corner requires an opening human distinct from its agent');
  });
});

/**
 * A message sent while a turn is already running must be DELIVERED, not
 * swallowed. Two independent defects produced the live "my steer vanished and
 * the daemon answered with unrelated status prose instead" report:
 *
 *  1. `pollMembers` rethrew a failed `sessionSteer` whenever no
 *     `runningAgentTasks` entry existed — the case for every corner FOLLOW-UP
 *     turn — leaving the human's message durably `failed` and blindly
 *     re-attempted later, with nothing said to them at any point. None of the
 *     shipped ACP adapters advertise a live-steering channel, so that failure
 *     is the ordinary path, not an edge case.
 *  2. Once the turn is correctly queued, its acknowledgement remains the only
 *     immediate durable response until the queued turn itself runs.
 */
describe('a message that arrives mid-turn is queued, acknowledged, and delivered', () => {
  function newBody(agent: ReturnType<typeof newIdentity>, workspaceRoot = '/workspace') {
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
    );
  }

  function stubPublishing(onPublish?: (event: NostrEvent) => void): NostrEvent[] {
    const published: NostrEvent[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        const event = JSON.parse(String(init?.body)) as NostrEvent;
        published.push(event);
        onPublish?.(event);
        return new Response(JSON.stringify({ accepted: true }), { status: 200 });
      }),
    );
    return published;
  }

  const queuedAcks = (published: NostrEvent[]): NostrEvent[] =>
    published.filter(
      (event) =>
        Array.isArray(event.tags) &&
        event.tags.some((tag) => tag[0] === 't' && tag[1] === STEER_QUEUED_TAG),
    );

  function memberMessage(
    human: ReturnType<typeof newIdentity>,
    channelId: string,
    content: string,
    createdAt: number,
  ): NostrEvent {
    return signEvent(
      {
        pubkey: human.publicKey,
        created_at: createdAt,
        kind: 9,
        tags: [['h', channelId]],
        content,
      },
      human.secretKey,
    );
  }

  it('keeps unaddressed multi-human corner chatter as context for the next mention', async () => {
    stubPublishing();
    const agent = newIdentity('addressed-corner-agent');
    const firstHuman = newIdentity('addressed-corner-first-human');
    const secondHuman = newIdentity('addressed-corner-second-human');
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'buzzy-corner-addressing-'));
    try {
      const body = newBody(agent, workspaceRoot);
      const sessionSteer = vi.fn().mockResolvedValue(undefined);
      const session = {
        channelId: 'corner-addressing',
        parentChannelId: 'room-addressing',
        sessionId: 'session-addressing',
        client: {
          sessionSteer,
          sessionCancel: vi.fn(),
          activeRunId: () => 'run-1',
        },
      } as never;
      body.registerSubchannel({
        subchannelId: 'corner-addressing',
        worktreePath: '/tmp/nonexistent-corner-addressing',
        featureBranch: 'feature/addressing',
        role: agent,
        session,
        lastPolledAt: 0,
        archived: false,
        participantPubkeys: [agent.publicKey, firstHuman.publicKey, secondHuman.publicKey],
      });
      const now = Math.floor(Date.now() / 1_000);
      const chatter = memberMessage(firstHuman, 'corner-addressing', 'Lunch is at noon.', now);
      const mention = signEvent(
        {
          pubkey: secondHuman.publicKey,
          created_at: now + 1,
          kind: 9,
          tags: [
            ['h', 'corner-addressing'],
            ['p', agent.publicKey],
          ],
          content: '@agent should we change the retry policy?',
        },
        secondHuman.secretKey,
      );
      const queryEvents = vi.fn().mockResolvedValueOnce([chatter]).mockResolvedValueOnce([mention]);
      (Reflect.get(body, 'agentRelay') as { queryEvents: unknown }).queryEvents = queryEvents;
      vi.spyOn(body as never, 'agentHistory' as never).mockResolvedValue([
        {
          eventId: chatter.id,
          channelId: 'corner-addressing',
          type: 'human-message',
          author: { pubkey: firstHuman.publicKey, kind: 'human', label: 'First human' },
          body: chatter.content,
          attachments: [],
          createdAt: chatter.created_at,
          provenance: 'relay-verified',
        },
        {
          eventId: mention.id,
          channelId: 'corner-addressing',
          type: 'human-message',
          author: { pubkey: secondHuman.publicKey, kind: 'human', label: 'Second human' },
          body: mention.content,
          attachments: [],
          createdAt: mention.created_at,
          provenance: 'relay-verified',
        },
      ] as never);
      const durableState = Reflect.get(body, 'durableState') as {
        delivered: (channelId: string, eventId: string) => Promise<void>;
      };
      const delivered = vi.spyOn(durableState, 'delivered');

      expect(await body.pollMembers('corner-addressing')).toBe(0);
      expect(sessionSteer).not.toHaveBeenCalled();
      expect(delivered).toHaveBeenCalledWith('corner-addressing', chatter.id);

      expect(await body.pollMembers('corner-addressing')).toBe(1);
      expect(sessionSteer).toHaveBeenCalledOnce();
      const addressedPrompt = sessionSteer.mock.calls[0]![1] as string;
      expect(addressedPrompt).toContain('Lunch is at noon.');
      expect(addressedPrompt).toContain('@agent should we change the retry policy?');
      expect(addressedPrompt).toContain('context only');
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('queues mid-turn corner steers as ordered next prompts instead of dropping them', async () => {
    const published = stubPublishing();
    const agent = newIdentity('queue-agent');
    const human = newIdentity('queue-human');
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'buzzy-steer-queue-'));
    try {
      const body = newBody(agent, workspaceRoot);
      stubEmptyAgentHistory(body);

      const prompts: string[] = [];
      const sessionPrompt = vi.fn(async (_sessionId: string, prompt: string) => {
        prompts.push(prompt);
        return { stopReason: 'end_turn', updates: [], agentText: 'ok', toolCalls: [] };
      });
      // The shape every shipped harness actually has: a run is in flight, and
      // there is no live-steering channel to inject into.
      const sessionSteer = vi
        .fn()
        .mockRejectedValue(new Error('ACP session corner-queue has no active run to steer'));
      const session = {
        channelId: 'corner-queue',
        parentChannelId: 'room-queue',
        sessionId: 'session-queue',
        client: { sessionPrompt, sessionSteer, sessionCancel: vi.fn(), activeRunId: () => 'run-1' },
      } as never;

      body.registerSubchannel({
        subchannelId: 'corner-queue',
        worktreePath: '/tmp/nonexistent-corner-queue',
        featureBranch: 'feature/queue',
        role: agent,
        session,
        lastPolledAt: 0,
        archived: false,
      });

      const now = Math.floor(Date.now() / 1000);
      const first = memberMessage(human, 'corner-queue', 'First: fix the mobile layout.', now);
      const second = memberMessage(human, 'corner-queue', 'Second: and the empty state.', now + 1);
      (Reflect.get(body, 'agentRelay') as { queryEvents: unknown }).queryEvents = vi
        .fn()
        .mockResolvedValue([first, second]);

      const count = await body.pollMembers('corner-queue');

      // Both steers were delivered — none lost — and in the order they were sent.
      expect(count).toBe(2);
      expect(sessionSteer).toHaveBeenCalledTimes(2);
      expect(prompts).toHaveLength(2);
      expect(prompts[0]).toContain('First: fix the mobile layout.');
      expect(prompts[1]).toContain('Second: and the empty state.');

      // One quiet acknowledgement for the burst, not one per message and not a
      // fabricated agent reply.
      const acks = queuedAcks(published);
      expect(acks).toHaveLength(1);
      expect(acks[0]!.tags).toContainEqual(['h', 'corner-queue']);
      expect(acks[0]!.tags).toContainEqual(['t', 'body-control']);
      expect(acks[0]!.tags).toContainEqual(['status', 'queued']);
      expect(acks[0]!.tags.some((tag) => tag[0] === 't' && tag[1] === 'agent-message')).toBe(false);
      expect(acks[0]!.content).toContain('queued');
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('never re-delivers a queued steer to an overlapping maintenance tick', async () => {
    stubPublishing();
    const agent = newIdentity('overlap-agent');
    const human = newIdentity('overlap-human');
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'buzzy-steer-overlap-'));
    try {
      const body = newBody(agent, workspaceRoot);
      stubEmptyAgentHistory(body);

      let releasePrompt!: () => void;
      let markStarted!: () => void;
      const promptStarted = new Promise<void>((r) => {
        markStarted = r;
      });
      const sessionPrompt = vi.fn(async () => {
        markStarted();
        await new Promise<void>((r) => {
          releasePrompt = r;
        });
        return { stopReason: 'end_turn', updates: [], agentText: 'ok', toolCalls: [] };
      });

      const session = {
        channelId: 'corner-overlap',
        parentChannelId: 'room-overlap',
        sessionId: 'session-overlap',
        client: {
          sessionPrompt,
          sessionSteer: vi.fn().mockRejectedValue(new Error('no active run to steer')),
          sessionCancel: vi.fn(),
          activeRunId: () => 'run-1',
        },
      } as never;
      body.registerSubchannel({
        subchannelId: 'corner-overlap',
        worktreePath: '/tmp/nonexistent-corner-overlap',
        featureBranch: 'feature/overlap',
        role: agent,
        session,
        lastPolledAt: 0,
        archived: false,
      });

      const evt = memberMessage(
        human,
        'corner-overlap',
        'Steer once.',
        Math.floor(Date.now() / 1000),
      );
      (Reflect.get(body, 'agentRelay') as { queryEvents: unknown }).queryEvents = vi
        .fn()
        .mockResolvedValue([evt]);

      const firstTick = body.pollMembers('corner-overlap');
      await promptStarted;
      // The maintenance timer fires without awaiting the prior tick; the same
      // still-pending event must not be delivered a second time.
      const secondTick = await body.pollMembers('corner-overlap');
      releasePrompt();
      await firstTick;

      expect(secondTick).toBe(0);
      expect(sessionPrompt).toHaveBeenCalledTimes(1);
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('publishes no queued acknowledgement when the corner has no turn running', async () => {
    const order: string[] = [];
    const published = stubPublishing((event) => {
      if (event.tags.some((tag) => tag[0] === 't' && tag[1] === 'agent-turn')) {
        order.push(`receipt:${event.tags.find((tag) => tag[0] === 'status')?.[1]}`);
      }
    });
    const agent = newIdentity('idle-corner-agent');
    const human = newIdentity('idle-corner-human');
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'buzzy-steer-idle-'));
    try {
      const body = newBody(agent, workspaceRoot);
      stubEmptyAgentHistory(body);

      const sessionPrompt = vi.fn(async () => ({
        stopReason: 'end_turn',
        updates: [],
        agentText: 'done',
        toolCalls: [],
      }));
      const sessionSteer = vi.fn();
      const activate = vi.fn(async () => {
        order.push('spawn');
        return 'session-idle';
      });
      const session = {
        channelId: 'corner-idle',
        parentChannelId: 'room-idle',
        sessionId: 'session-idle',
        client: {
          sessionPrompt,
          sessionSteer,
          sessionCancel: vi.fn(),
          activeRunId: () => undefined,
        },
        lifecycle: { activate, suspend: vi.fn().mockResolvedValue(undefined) },
      } as never;
      body.registerSubchannel({
        subchannelId: 'corner-idle',
        worktreePath: '/tmp/nonexistent-corner-idle',
        featureBranch: 'feature/idle',
        role: agent,
        session,
        lastPolledAt: 0,
        archived: false,
      });
      (Reflect.get(body, 'agentRelay') as { queryEvents: unknown }).queryEvents = vi
        .fn()
        .mockResolvedValue([
          memberMessage(human, 'corner-idle', 'Do this now.', Math.floor(Date.now() / 1000)),
        ]);

      expect(await body.pollMembers('corner-idle')).toBe(1);
      expect(sessionSteer).not.toHaveBeenCalled();
      expect(sessionPrompt).toHaveBeenCalledOnce();
      expect(queuedAcks(published)).toHaveLength(0);
      expect(order.slice(0, 2)).toEqual(['receipt:working', 'spawn']);
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('replaces the instant corner receipt when the harness session fails to start', async () => {
    const order: string[] = [];
    const published = stubPublishing((event) => {
      if (event.tags.some((tag) => tag[0] === 't' && tag[1] === 'agent-turn')) {
        order.push(`receipt:${event.tags.find((tag) => tag[0] === 'status')?.[1]}`);
      }
    });
    const agent = newIdentity('failed-start-corner-agent');
    const human = newIdentity('failed-start-corner-human');
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'buzzy-steer-failed-start-'));
    try {
      const body = newBody(agent, workspaceRoot);
      stubEmptyAgentHistory(body);
      const sessionPrompt = vi.fn();
      const session = {
        channelId: 'corner-failed-start',
        parentChannelId: 'room-failed-start',
        sessionId: 'not-started',
        logicalSessionId: 'logical-failed-start',
        client: {
          sessionPrompt,
          sessionSteer: vi.fn(),
          sessionCancel: vi.fn(),
          activeRunId: () => undefined,
        },
        lifecycle: {
          activate: vi.fn(async () => {
            order.push('spawn');
            throw new Error('adapter could not start');
          }),
          suspend: vi.fn().mockResolvedValue(undefined),
        },
      } as never;
      body.registerSubchannel({
        subchannelId: 'corner-failed-start',
        worktreePath: '/tmp/nonexistent-corner-failed-start',
        featureBranch: 'feature/failed-start',
        role: agent,
        session,
        lastPolledAt: 0,
        archived: false,
      });
      (Reflect.get(body, 'agentRelay') as { queryEvents: unknown }).queryEvents = vi
        .fn()
        .mockResolvedValue([
          memberMessage(
            human,
            'corner-failed-start',
            'Finish the merge.',
            Math.floor(Date.now() / 1000),
          ),
        ]);

      expect(await body.pollMembers('corner-failed-start')).toBe(1);
      expect(sessionPrompt).not.toHaveBeenCalled();
      expect(order).toEqual(['receipt:working', 'spawn', 'receipt:failed']);
      const statuses = published
        .filter((event) => event.tags.some((tag) => tag[0] === 't' && tag[1] === 'agent-turn'))
        .map((event) => event.tags.find((tag) => tag[0] === 'status')?.[1]);
      expect(statuses).toEqual(['working', 'failed']);
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('keeps a queued turn from publishing interim transcript prose', async () => {
    vi.useFakeTimers();
    try {
      const published = stubPublishing();
      const scheduler = new SessionScheduler({ maxLiveSessions: 1, idleMs: 60_000 });
      const body = new Body(
        {
          agentBinary: '/nonexistent',
          mcpBinary: '/nonexistent',
          agentEnv: {},
          workspaceRoot: '/tmp/buzzy-queued-stall',
          relayBaseUrl: 'http://relay.test',
          relayHost: 'relay.test',
          relayScheme: 'http',
          relayWsUrl: 'ws://relay.test',
          autoApprovePermissions: true,
        },
        newIdentity('queued-stall-operator'),
        newIdentity('queued-stall-agent'),
        undefined,
        { scheduler },
      );

      // A healthy turn that occupies the only session slot long enough for a
      // second prompt to wait in the FIFO.
      const runMs = 60_000;
      const sessionPrompt = vi.fn(
        (_sessionId: string, _prompt: string, _timeoutMs: number) =>
          new Promise((resolveRun) => {
            setTimeout(() => {
              resolveRun({ stopReason: 'end_turn', updates: [], agentText: 'ok', toolCalls: [] });
            }, runMs);
          }),
      );
      const session = {
        channelId: 'fifo-room',
        sessionId: 'fifo-session',
        mode: 'readonly',
        client: { sessionPrompt, sessionCancel: vi.fn() },
        lifecycle: {
          activate: vi.fn().mockResolvedValue('fifo-session'),
          suspend: vi.fn().mockResolvedValue(undefined),
        },
      } as never;

      const running = Reflect.get(body, 'promptAgent').call(body, session, 'first', {
        channelId: 'fifo-room',
        requestId: 'req-1',
        originalRequestId: 'req-1',
        cause: 'room-message',
      });
      // Issued while `running` still holds the session: this one only waits.
      const queued = Reflect.get(body, 'promptAgent').call(body, session, 'second', {
        channelId: 'fifo-room',
        requestId: 'req-2',
        originalRequestId: 'req-2',
        cause: 'room-message',
      });

      await vi.advanceTimersByTimeAsync(runMs * 2 + 10);
      await running;
      await queued;

      expect(sessionPrompt).toHaveBeenCalledTimes(2);
      expect(published).toEqual([]);
      await scheduler.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('acknowledges a Room message pushed mid-turn without waiting for the turn it is queued behind', async () => {
    const published = stubPublishing();
    const agent = newIdentity('room-ack-agent');
    const human = newIdentity('room-ack-human');
    const body = newBody(agent);

    const sessions = Reflect.get(body, 'sessions') as Map<string, unknown>;
    sessions.set('ack-room', {
      channelId: 'ack-room',
      sessionId: 'ack-session',
      client: { activeRunId: () => 'run-1' },
    });

    const participants = [agent.publicKey, human.publicKey];
    const steer = memberMessage(
      human,
      'ack-room',
      'the bigger problem with mobile is the empty state',
      Math.floor(Date.now() / 1000),
    );
    Reflect.get(body, 'noteRoomInboundMessage').call(body, 'ack-room', steer, participants);
    Reflect.get(body, 'noteRoomInboundMessage').call(body, 'ack-room', steer, participants);
    await vi.waitFor(() => expect(queuedAcks(published)).toHaveLength(1));

    expect(queuedAcks(published)[0]!.tags).toContainEqual(['h', 'ack-room']);
  });

  it('preserves human prose with reserved tags while ignoring the agent’s own message', async () => {
    const published = stubPublishing();
    const agent = newIdentity('room-noack-agent');
    const human = newIdentity('room-noack-human');
    const body = newBody(agent);

    const sessions = Reflect.get(body, 'sessions') as Map<string, unknown>;
    sessions.set('noack-room', {
      channelId: 'noack-room',
      sessionId: 'noack-session',
      client: { activeRunId: () => 'run-1' },
    });
    const participants = [agent.publicKey, human.publicKey];
    const control = signEvent(
      {
        pubkey: human.publicKey,
        created_at: Math.floor(Date.now() / 1000),
        kind: 9,
        tags: [
          ['h', 'noack-room'],
          ['t', 'body-control'],
        ],
        content: 'APPROVE merge',
      },
      human.secretKey,
    );
    const ownMessage = memberMessage(agent, 'noack-room', 'my own reply', 1);

    Reflect.get(body, 'noteRoomInboundMessage').call(body, 'noack-room', control, participants);
    Reflect.get(body, 'noteRoomInboundMessage').call(body, 'noack-room', ownMessage, participants);

    await vi.waitFor(() => expect(queuedAcks(published)).toHaveLength(1));
  });
});

/**
 * A corner's lifecycle belongs to the ONE agent whose key signed its immutable
 * kind:9007 create event — that is what the relay authorizes a kind:9002
 * archive against. `listSubchannels` lists every child of a Room regardless of
 * creator, so in a multi-agent Room every daemon discovers every other
 * daemon's corners; adopting one produced an "abandoned" entry whose every
 * close attempt came back `HTTP 400 actor not authorized`, retried forever.
 */
describe('a corner belongs to the agent that opened it', () => {
  const CREATE_KIND = 9007;

  function newBody(agent: ReturnType<typeof newIdentity>, workspaceRoot: string) {
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
    );
  }

  function cornerCreateEvent(
    creator: ReturnType<typeof newIdentity>,
    subchannelId: string,
    parentChannelId: string,
  ): NostrEvent {
    return signEvent(
      {
        pubkey: creator.publicKey,
        created_at: Math.floor(Date.now() / 1000),
        kind: CREATE_KIND,
        tags: [
          ['h', subchannelId],
          ['parent', parentChannelId],
        ],
        content: '',
      },
      creator.secretKey,
    );
  }

  function closeEvent(human: ReturnType<typeof newIdentity>, subchannelId: string): NostrEvent {
    return signEvent(
      {
        pubkey: human.publicKey,
        created_at: Math.floor(Date.now() / 1000),
        kind: 9,
        tags: [
          ['h', subchannelId],
          ['t', CORNER_CLOSE_TAG],
        ],
        content: 'Close this corner.',
      },
      human.secretKey,
    );
  }

  /** Serve `creates` to /query; record publishes, optionally refusing some. */
  function stubRelayHttp(
    creates: NostrEvent[],
    refuse?: (event: NostrEvent) => { status: number; body: string } | undefined,
  ): NostrEvent[] {
    const published: NostrEvent[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        if (String(input).endsWith('/query')) {
          return new Response(JSON.stringify(creates), { status: 200 });
        }
        const event = JSON.parse(String(init?.body)) as NostrEvent;
        const refusal = refuse?.(event);
        if (refusal) return new Response(refusal.body, { status: refusal.status });
        published.push(event);
        return new Response(JSON.stringify({ accepted: true }), { status: 200 });
      }),
    );
    return published;
  }

  it('never adopts a corner another agent opened, so it is never tracked as abandoned', async () => {
    const agent = newIdentity('foreign-restore-agent');
    const otherAgent = newIdentity('foreign-restore-other');
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'buzzy-foreign-restore-'));
    try {
      const body = newBody(agent, workspaceRoot);
      mocks.createBuzzClient.mockReturnValue({
        listSubchannels: async () => ['corner-foreign'],
        getChannelMetadata: async () => ({ archived: false }),
        disconnect: () => undefined,
      } as never);
      Reflect.set(body, 'agentRelay', { queryEvents: vi.fn(async () => []) });
      stubRelayHttp([cornerCreateEvent(otherAgent, 'corner-foreign', 'room-shared')]);

      await Reflect.get(body, 'restoreSubchannels').call(body, 'room-shared', {
        repo: 'proj',
        localPath: join(workspaceRoot, 'checkout'),
        targetBranch: 'refs/heads/main',
      });

      expect(body.getSubchannels().has('corner-foreign')).toBe(false);
      // The critical half: it is NOT parked in the sessionless close path,
      // whose every archive attempt the relay would refuse.
      expect(body.getAbandonedCorners().has('corner-foreign')).toBe(false);
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('refuses to archive a corner it did not open, and stops tracking it entirely', async () => {
    const agent = newIdentity('foreign-close-agent');
    const otherAgent = newIdentity('foreign-close-other');
    const human = newIdentity('foreign-close-human');
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'buzzy-foreign-close-'));
    try {
      const body = newBody(agent, workspaceRoot);
      Reflect.get(body, 'abandonedCorners').set('corner-theirs', {
        subchannelId: 'corner-theirs',
        parentChannelId: 'room-shared-close',
        reason: 'no restorable corner state was found for it',
      });
      Reflect.set(body, 'agentRelay', {
        queryEvents: vi.fn(async () => [closeEvent(human, 'corner-theirs')]),
      });
      const published = stubRelayHttp([
        cornerCreateEvent(otherAgent, 'corner-theirs', 'room-shared-close'),
      ]);
      vi.spyOn(console, 'log').mockImplementation(() => undefined);

      await Reflect.get(body, 'pollAbandonedCornerCloses').call(body, 'room-shared-close');

      // No kind:9002 is even attempted — the relay would refuse it 400.
      expect(published.filter((event) => event.kind === 9002)).toHaveLength(0);
      // And it leaves this daemon's books: it was never ours to close.
      expect(body.getAbandonedCorners().has('corner-theirs')).toBe(false);
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('parks a close the relay refuses outright instead of hot-retrying an event that can never be accepted', async () => {
    const agent = newIdentity('parked-close-agent');
    const human = newIdentity('parked-close-human');
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'buzzy-parked-close-'));
    try {
      const body = newBody(agent, workspaceRoot);
      stubEmptyAgentHistory(body);
      Reflect.get(body, 'abandonedCorners').set('corner-refused', {
        subchannelId: 'corner-refused',
        parentChannelId: 'room-refused',
        reason: 'its worktree was missing after a restart',
      });
      Reflect.set(body, 'agentRelay', {
        queryEvents: vi.fn(async () => [closeEvent(human, 'corner-refused')]),
      });
      const published = stubRelayHttp(
        [cornerCreateEvent(agent, 'corner-refused', 'room-refused')],
        (event) =>
          event.kind === 9002
            ? { status: 400, body: '{"error":"invalid: actor not authorized for namespace"}' }
            : undefined,
      );
      const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);

      await Reflect.get(body, 'pollAbandonedCornerCloses').call(body, 'room-refused');
      const afterFirst = published.length;

      // The human pressed a button and nothing happened: the corner says so,
      // in plain language with none of the relay's own transport plumbing.
      const refusal = published.find((event) =>
        event.tags.some((tag) => tag[0] === 'status' && tag[1] === 'failed'),
      );
      expect(refusal).toBeDefined();
      expect(refusal!.content).toBe(ABANDONED_CORNER_CLOSE_REFUSED);
      expect(refusal!.content).not.toMatch(/HTTP|9002|not authorized/);

      // Parked: the next maintenance tick republishes nothing and logs nothing.
      const errorsAfterFirst = errors.mock.calls.length;
      await Reflect.get(body, 'pollAbandonedCornerCloses').call(body, 'room-refused');
      expect(published).toHaveLength(afterFirst);
      expect(errors.mock.calls.length).toBe(errorsAfterFirst);
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('classifies a relay refusal as non-retryable only when a retry genuinely cannot help', () => {
    expect(
      isNonRetryableRelayError(
        new Error(
          'publishEvent kind=9002 failed: HTTP 400 {"error":"invalid: actor not authorized"}',
        ),
      ),
    ).toBe(true);
    expect(
      isNonRetryableRelayError(new Error('publishEvent kind=9002 failed: HTTP 403 nope')),
    ).toBe(true);
    // "Later" answers, and everything transient, stay retryable.
    expect(isNonRetryableRelayError(new Error('HTTP 429 rate limited, retry in 12s'))).toBe(false);
    expect(isNonRetryableRelayError(new Error('HTTP 408 request timeout'))).toBe(false);
    expect(isNonRetryableRelayError(new Error('HTTP 502 Bad Gateway'))).toBe(false);
    expect(isNonRetryableRelayError(new Error('fetch failed'))).toBe(false);
  });

  it('spaces out a transient close failure instead of retrying it at the maintenance cadence', () => {
    expect(abandonedCornerCloseRetryDelayMs(1)).toBe(ABANDONED_CORNER_CLOSE_RETRY_BASE_MS);
    expect(abandonedCornerCloseRetryDelayMs(2)).toBe(ABANDONED_CORNER_CLOSE_RETRY_BASE_MS * 2);
    expect(abandonedCornerCloseRetryDelayMs(20)).toBe(ABANDONED_CORNER_CLOSE_RETRY_CAP_MS);
    // A relay that advertises its own delay always wins over our floor.
    expect(abandonedCornerCloseRetryDelayMs(1, new Error('rate limited, retry in 900s'))).toBe(
      900_000,
    );
  });
});

describe('a corner that fell out of local tracking is still closable', () => {
  const CREATE_KIND = 9007;
  const METADATA_KIND = 39000;

  function newBody(agent: ReturnType<typeof newIdentity>, workspaceRoot: string) {
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
    );
  }

  function cornerCreateEvent(
    creator: ReturnType<typeof newIdentity>,
    subchannelId: string,
    parentChannelId: string,
  ): NostrEvent {
    return signEvent(
      {
        pubkey: creator.publicKey,
        created_at: Math.floor(Date.now() / 1000),
        kind: CREATE_KIND,
        tags: [
          ['h', subchannelId],
          ['parent', parentChannelId],
        ],
        content: '',
      },
      creator.secretKey,
    );
  }

  function closeEvent(human: ReturnType<typeof newIdentity>, subchannelId: string): NostrEvent {
    return signEvent(
      {
        pubkey: human.publicKey,
        created_at: Math.floor(Date.now() / 1000),
        kind: 9,
        tags: [
          ['h', subchannelId],
          ['t', CORNER_CLOSE_TAG],
        ],
        content: 'Close this corner.',
      },
      human.secretKey,
    );
  }

  function archivedMetadataEvent(
    signer: ReturnType<typeof newIdentity>,
    subchannelId: string,
  ): NostrEvent {
    return signEvent(
      {
        pubkey: signer.publicKey,
        created_at: Math.floor(Date.now() / 1000),
        kind: METADATA_KIND,
        tags: [
          ['d', subchannelId],
          ['archived', 'true'],
        ],
        content: '',
      },
      signer.secretKey,
    );
  }

  /**
   * The sweep's whole point is that it asks the relay a precisely FILTERED
   * question, so a stub that serves every event to every filter would prove
   * nothing. This one actually applies kinds/authors/single-letter-tag/since.
   */
  function matching(events: NostrEvent[], filter: Record<string, unknown>): NostrEvent[] {
    return events.filter((event) => {
      if (Array.isArray(filter.kinds) && !filter.kinds.includes(event.kind)) return false;
      if (Array.isArray(filter.authors) && !filter.authors.includes(event.pubkey)) return false;
      if (typeof filter.since === 'number' && event.created_at < filter.since) return false;
      for (const [key, values] of Object.entries(filter)) {
        if (!key.startsWith('#') || !Array.isArray(values)) continue;
        const tagName = key.slice(1);
        const hit = (values as string[]).some((value) =>
          event.tags.some((tag) => tag[0] === tagName && tag[1] === value),
        );
        if (!hit) return false;
      }
      return true;
    });
  }

  function relayReader(events: NostrEvent[]) {
    return vi.fn(async (filters: Record<string, unknown>[]) =>
      filters.flatMap((filter) => matching(events, filter)),
    );
  }

  /** Serve `events` to /query through the same filter, record every publish. */
  function stubRelayHttp(events: NostrEvent[]): NostrEvent[] {
    const published: NostrEvent[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        if (String(input).endsWith('/query')) {
          const filters = JSON.parse(String(init?.body)) as Record<string, unknown>[];
          const hits = filters.flatMap((filter) => matching(events, filter));
          return new Response(JSON.stringify(hits), { status: 200 });
        }
        published.push(JSON.parse(String(init?.body)) as NostrEvent);
        return new Response(JSON.stringify({ accepted: true }), { status: 200 });
      }),
    );
    return published;
  }

  it('archives a corner it authored that is open on the relay, has a pending close, and is in no local map', async () => {
    const agent = newIdentity('untracked-close-agent');
    const human = newIdentity('untracked-close-human');
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'buzzy-untracked-close-'));
    try {
      const body = newBody(agent, workspaceRoot);
      stubEmptyAgentHistory(body);
      const create = cornerCreateEvent(agent, 'corner-untracked', 'room-untracked');
      const intro = signEvent(
        {
          pubkey: agent.publicKey,
          created_at: Math.floor(Date.now() / 1000),
          kind: 9,
          tags: [
            ['h', 'corner-untracked'],
            ['feature', 'feature/untracked-work'],
            ['parent', 'room-untracked'],
          ],
          content: 'corner opened',
        },
        agent.secretKey,
      );
      const close = closeEvent(human, 'corner-untracked');
      const relayEvents = [create, intro, close];
      Reflect.set(body, 'agentRelay', { queryEvents: relayReader(relayEvents) });
      const published = stubRelayHttp(relayEvents);

      // The exact live shape: not restored, not abandoned — in NO map at all.
      expect(body.getSubchannels().has('corner-untracked')).toBe(false);
      expect(body.getAbandonedCorners().has('corner-untracked')).toBe(false);

      await Reflect.get(body, 'pollUntrackedCornerCloses').call(body, 'room-untracked');

      // Re-derived from the relay, with the branch its committed work is on.
      const adopted = body.getAbandonedCorners().get('corner-untracked');
      expect(adopted).toMatchObject({
        subchannelId: 'corner-untracked',
        parentChannelId: 'room-untracked',
        featureBranch: 'feature/untracked-work',
      });

      await Reflect.get(body, 'pollAbandonedCornerCloses').call(body, 'room-untracked');

      // The corner is archived on the relay...
      const archiveCommand = published.find(
        (event) =>
          event.kind === 9002 &&
          event.tags.some((tag) => tag[0] === 'archived' && tag[1] === 'true'),
      );
      expect(archiveCommand?.tags).toContainEqual(['h', 'corner-untracked']);
      // ...and the parent Room told, which is what clears its stale pin.
      const parentCard = published.find((event) =>
        event.tags.some((tag) => tag[0] === 'h' && tag[1] === 'room-untracked'),
      );
      expect(parentCard?.tags).toContainEqual(['subchannel', 'corner-untracked']);
      expect(parentCard?.tags).toContainEqual(['status', 'archived']);
      expect(body.getAbandonedCorners().has('corner-untracked')).toBe(false);
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('leaves an untracked corner another agent opened entirely alone, close request or not', async () => {
    const agent = newIdentity('untracked-foreign-agent');
    const otherAgent = newIdentity('untracked-foreign-other');
    const human = newIdentity('untracked-foreign-human');
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'buzzy-untracked-foreign-'));
    try {
      const body = newBody(agent, workspaceRoot);
      const relayEvents = [
        cornerCreateEvent(otherAgent, 'corner-not-ours', 'room-untracked-foreign'),
        closeEvent(human, 'corner-not-ours'),
      ];
      Reflect.set(body, 'agentRelay', { queryEvents: relayReader(relayEvents) });
      const published = stubRelayHttp(relayEvents);

      await Reflect.get(body, 'pollUntrackedCornerCloses').call(body, 'room-untracked-foreign');

      // #244's rule, enforced by the `authors` filter rather than a later
      // check: a foreign corner is never even a candidate, so nothing is
      // adopted and no doomed kind:9002 is ever signed.
      expect(body.getAbandonedCorners().has('corner-not-ours')).toBe(false);
      expect(published).toEqual([]);
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('never reprocesses a corner that is already archived, and never adopts one nobody asked to close', async () => {
    const agent = newIdentity('untracked-settled-agent');
    const human = newIdentity('untracked-settled-human');
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'buzzy-untracked-settled-'));
    try {
      const body = newBody(agent, workspaceRoot);
      const relayEvents = [
        // Already closed: a close was pressed, and the corner is archived.
        cornerCreateEvent(agent, 'corner-settled', 'room-untracked-settled'),
        closeEvent(human, 'corner-settled'),
        archivedMetadataEvent(agent, 'corner-settled'),
        // Open, ours, untracked — but nobody asked to close it.
        cornerCreateEvent(agent, 'corner-quiet', 'room-untracked-settled'),
      ];
      const queryEvents = relayReader(relayEvents);
      Reflect.set(body, 'agentRelay', { queryEvents });
      const published = stubRelayHttp(relayEvents);

      await Reflect.get(body, 'pollUntrackedCornerCloses').call(body, 'room-untracked-settled');
      expect(body.getAbandonedCorners().size).toBe(0);
      expect(published).toEqual([]);

      // A second sweep re-reads the immutable create events, but must not go
      // back to the relay about either corner: the archived one is settled for
      // good, and the quiet one has no close request.
      Reflect.get(body, 'untrackedCornerScanAt').clear();
      queryEvents.mockClear();
      await Reflect.get(body, 'pollUntrackedCornerCloses').call(body, 'room-untracked-settled');

      const asked = queryEvents.mock.calls.flatMap(
        ([filters]) => filters as Record<string, unknown>[],
      );
      // The create-event enumeration plus ONE batched close read for the
      // candidates that are still open — no per-corner follow-up.
      expect(asked.map((filter) => (filter.kinds as number[]).join())).toEqual([
        String(CREATE_KIND),
        '9',
      ]);
      // The settled corner is gone from the candidate set for good: the sweep
      // never asks about it again, let alone re-reads its metadata.
      expect(asked[1]!['#h']).toEqual(['corner-quiet']);
      expect(body.getAbandonedCorners().size).toBe(0);
      expect(published).toEqual([]);
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("still sees a close older than the corner's own durable delivery cursor", async () => {
    const agent = newIdentity('untracked-cursor-agent');
    const human = newIdentity('untracked-cursor-human');
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'buzzy-untracked-cursor-'));
    try {
      const body = newBody(agent, workspaceRoot);
      stubEmptyAgentHistory(body);
      const close = closeEvent(human, 'corner-cursor');
      // The cursor is a high-water mark: a close that failed while the corner
      // was still live, followed by any delivered later message, leaves it
      // ahead of the close's own timestamp.
      const later = signEvent(
        {
          pubkey: human.publicKey,
          created_at: close.created_at + 600,
          kind: 9,
          tags: [['h', 'corner-cursor']],
          content: 'any later message',
        },
        human.secretKey,
      );
      const relayEvents = [
        cornerCreateEvent(agent, 'corner-cursor', 'room-untracked-cursor'),
        close,
        later,
      ];
      Reflect.set(body, 'agentRelay', { queryEvents: relayReader(relayEvents) });
      const published = stubRelayHttp(relayEvents);
      const durable = Reflect.get(body, 'durableState') as {
        enqueue: (channelId: string, events: NostrEvent[]) => Promise<unknown>;
        delivered: (channelId: string, eventId: string) => Promise<void>;
        cursor: (channelId: string) => Promise<{ createdAt: number }>;
      };
      await durable.enqueue('corner-cursor', [close, later]);
      await durable.delivered('corner-cursor', later.id);
      expect((await durable.cursor('corner-cursor')).createdAt).toBeGreaterThan(close.created_at);

      await Reflect.get(body, 'pollUntrackedCornerCloses').call(body, 'room-untracked-cursor');
      expect(body.getAbandonedCorners().get('corner-cursor')?.closeRequestedAt).toBe(
        close.created_at,
      );

      await Reflect.get(body, 'pollAbandonedCornerCloses').call(body, 'room-untracked-cursor');

      // Without the floor the watch's `since` starts past the close, the
      // corner is tracked forever, and nothing is ever archived.
      const archiveCommand = published.find(
        (event) =>
          event.kind === 9002 &&
          event.tags.some((tag) => tag[0] === 'archived' && tag[1] === 'true'),
      );
      expect(archiveCommand?.tags).toContainEqual(['h', 'corner-cursor']);
      expect(body.getAbandonedCorners().has('corner-cursor')).toBe(false);
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('scans at most once per interval, so the backstop never becomes a hot loop', async () => {
    const agent = newIdentity('untracked-throttle-agent');
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'buzzy-untracked-throttle-'));
    try {
      const body = newBody(agent, workspaceRoot);
      const queryEvents = relayReader([]);
      Reflect.set(body, 'agentRelay', { queryEvents });
      stubRelayHttp([]);

      await Reflect.get(body, 'pollUntrackedCornerCloses').call(body, 'room-untracked-throttle');
      await Reflect.get(body, 'pollUntrackedCornerCloses').call(body, 'room-untracked-throttle');
      expect(queryEvents).toHaveBeenCalledTimes(1);

      Reflect.get(body, 'untrackedCornerScanAt').set(
        'room-untracked-throttle',
        Date.now() - UNTRACKED_CORNER_SCAN_INTERVAL_MS - 1,
      );
      await Reflect.get(body, 'pollUntrackedCornerCloses').call(body, 'room-untracked-throttle');
      expect(queryEvents).toHaveBeenCalledTimes(2);
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });
});
