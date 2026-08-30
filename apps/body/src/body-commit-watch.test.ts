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
describe('harness-independent corner commit watch', () => {
  function gitCommand(cwd: string, args: string[]): string {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(result.stderr);
    return result.stdout.trim();
  }

  /** A worktree with one real committed change on its feature branch and a
   *  clean tree — what a pi corner looks like after a turn whose completion
   *  event never reached the daemon. */
  function committedFeatureWorktree(): string {
    const directory = mkdtempSync(join(tmpdir(), 'buzzy-commit-watch-'));
    gitCommand(directory, ['init', '-b', 'main']);
    gitCommand(directory, ['config', 'user.name', 'Commit Watch Test']);
    gitCommand(directory, ['config', 'user.email', 'commit-watch@test.invalid']);
    writeFileSync(join(directory, 'README.md'), '# Before\n');
    gitCommand(directory, ['add', '.']);
    gitCommand(directory, ['commit', '-m', 'base']);
    gitCommand(directory, ['checkout', '-b', 'feature/watched']);
    writeFileSync(join(directory, 'README.md'), '# After\n');
    gitCommand(directory, ['add', 'README.md']);
    gitCommand(directory, ['commit', '-m', 'committed without a completed turn']);
    return directory;
  }

  function newBody(agent: ReturnType<typeof newIdentity>) {
    return new Body(
      {
        agentBinary: '/nonexistent',
        mcpBinary: '/nonexistent',
        agentEnv: {},
        workspaceRoot: '/workspace',
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

  const uploadedReviewArtifacts = new Map<string, Uint8Array>();

  function stubPublishing(
    options: { refuseArtifact?: () => boolean; rejectReviewQueries?: boolean } = {},
  ): NostrEvent[] {
    const published: NostrEvent[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        if (String(input).endsWith('/upload')) {
          const hash = new Headers(init?.headers).get('X-SHA-256')!;
          const bytes = new Uint8Array(init?.body as Uint8Array);
          uploadedReviewArtifacts.set(hash, bytes);
          return mediaUploadResponse(input, init)!;
        }
        if (String(input).endsWith('/query')) {
          const filters = JSON.parse(String(init?.body)) as Array<Record<string, unknown>>;
          if (
            options.rejectReviewQueries &&
            filters.some(
              (filter) =>
                Array.isArray(filter.kinds) &&
                (filter.kinds as number[]).includes(CHANGE_REVIEW_EVENT_KIND),
            )
          ) {
            return new Response(JSON.stringify({ error: 'projection unavailable' }), {
              status: 502,
            });
          }
          const matches = published.filter((event) =>
            filters.some((filter) => matchesFilterRelayFaithfully(event, filter)),
          );
          return new Response(JSON.stringify(matches), { status: 200 });
        }
        const event = JSON.parse(String(init?.body)) as NostrEvent;
        if (
          options.refuseArtifact?.() === true &&
          event.kind === CHANGE_REVIEW_EVENT_KIND &&
          event.tags.some((tag) => tag[0] === 't' && tag[1] === CHANGE_REVIEW_ARTIFACT_TAG)
        ) {
          return new Response(JSON.stringify({ error: 'review artifact denied' }), { status: 400 });
        }
        published.push(event);
        return new Response(JSON.stringify({ accepted: true }), { status: 200 });
      }),
    );
    return published;
  }

  function matchesFilterRelayFaithfully(
    event: NostrEvent,
    filter: Record<string, unknown>,
  ): boolean {
    return Object.entries(filter).every(([key, values]) => {
      if (key === 'kinds' && Array.isArray(values))
        return (values as number[]).includes(event.kind);
      if (key === 'authors' && Array.isArray(values))
        return (values as string[]).includes(event.pubkey);
      if (!key.startsWith('#') || !Array.isArray(values)) return true;
      if (event.kind === CHANGE_REVIEW_EVENT_KIND && key !== '#d') return false;
      return event.tags.some(
        (tag) => tag[0] === key.slice(1) && (values as string[]).includes(tag[1]!),
      );
    });
  }

  afterEach(() => {
    uploadedReviewArtifacts.clear();
    vi.unstubAllGlobals();
  });

  function watchInfo(
    body: Body,
    agent: ReturnType<typeof newIdentity>,
    worktreePath: string,
    overrides: Record<string, unknown> = {},
  ): SubchannelInfoFixture {
    const info = {
      subchannelId: 'corner-commit-watch',
      worktreePath,
      featureBranch: 'feature/watched',
      role: agent,
      session: {
        channelId: 'corner-commit-watch',
        sessionId: 'session',
        parentChannelId: 'room-commit-watch',
        client: { activeRunId: () => undefined },
      } as never,
      lastPolledAt: 0,
      archived: false,
      boundRepo: { repo: 'repo', targetBranch: 'refs/heads/main' },
      ...overrides,
    } as SubchannelInfoFixture;
    body.registerSubchannel(info);
    return info;
  }

  // The test fixtures register plain session objects; keep the local type
  // loose where only Body's own bookkeeping reads them.
  type SubchannelInfoFixture = Parameters<Body['registerSubchannel']>[0];

  it('publishes a review card for committed work even when no ACP turn ever resolved', async () => {
    const agent = newIdentity('commit-watch-agent');
    const body = newBody(agent);
    const published = stubPublishing();
    const worktreePath = committedFeatureWorktree();
    try {
      // No running task, an idle session, commits on the branch, clean tree:
      // exactly the state a pi corner is left in when its turn dies before
      // the daemon sees a final response.
      const info = watchInfo(body, agent, worktreePath);

      await Reflect.get(body, 'pollCornerCommitWatch').call(body);

      expect(
        published.some((event) =>
          event.tags.some((tag) => tag[0] === 't' && tag[1] === 'merge-ready'),
        ),
      ).toBe(true);
      expect(info.observedReviewTip).toBe(gitCommand(worktreePath, ['rev-parse', 'HEAD']));
    } finally {
      await rm(worktreePath, { recursive: true, force: true });
    }
  });

  it('never publishes merge-ready when the single artifact fact is refused', async () => {
    const agent = newIdentity('commit-watch-review-artifact-refused-agent');
    const body = newBody(agent);
    const published = stubPublishing({ refuseArtifact: () => true });
    const worktreePath = committedFeatureWorktree();
    try {
      const info = watchInfo(body, agent, worktreePath);
      await expect(Reflect.get(body, 'publishMergeReady').call(body, info)).rejects.toThrow(
        'relay rejected this message',
      );
      expect(
        published.some((event) =>
          event.tags.some((tag) => tag[0] === 't' && tag[1] === 'merge-ready'),
        ),
      ).toBe(false);
      expect(info.reviewArtifactPublishedTip).toBeUndefined();
    } finally {
      await rm(worktreePath, { recursive: true, force: true });
    }
  });

  /** A wide review which previously required one event per file plus manifest shards. */
  function largeCommittedFeatureWorktree(): string {
    const directory = mkdtempSync(join(tmpdir(), 'buzzy-commit-watch-large-'));
    gitCommand(directory, ['init', '-b', 'main']);
    gitCommand(directory, ['config', 'user.name', 'Commit Watch Test']);
    gitCommand(directory, ['config', 'user.email', 'commit-watch@test.invalid']);
    writeFileSync(join(directory, 'README.md'), '# Before\n');
    gitCommand(directory, ['add', '.']);
    gitCommand(directory, ['commit', '-m', 'base']);
    gitCommand(directory, ['checkout', '-b', 'feature/watched']);
    for (let index = 0; index < 140; index++) {
      writeFileSync(
        join(directory, `changed-${String(index).padStart(3, '0')}.ts`),
        `export const changed${index} = ${index};\n`,
      );
    }
    writeFileSync(join(directory, 'vendor.min.js'), 'x'.repeat(3_000_000));
    gitCommand(directory, ['add', '.']);
    gitCommand(directory, ['commit', '-m', 'wide committed change']);
    return directory;
  }

  const reviewPayloadCount = (published: NostrEvent[]): number =>
    published.filter((event) =>
      event.tags.some((tag) => tag[0] === 't' && tag[1] === CHANGE_REVIEW_ARTIFACT_TAG),
    ).length;

  it(
    'publishes a many-file review as one artifact event without relay read-back',
    { timeout: 60_000 },
    async () => {
      const agent = newIdentity('commit-watch-single-artifact-agent');
      const body = newBody(agent);
      // A 502 from the review projection used to make a complete publish fail.
      // The atomic path never queries it: upload once, publish once, ready.
      const published = stubPublishing({ rejectReviewQueries: true });
      const worktreePath = largeCommittedFeatureWorktree();
      try {
        const info = watchInfo(body, agent, worktreePath);
        await expect(Reflect.get(body, 'publishMergeReady').call(body, info)).resolves.toBe(true);

        const tip = gitCommand(worktreePath, ['rev-parse', 'HEAD']);
        expect(reviewPayloadCount(published)).toBe(1);
        const event = published.find((candidate) =>
          candidate.tags.some((tag) => tag[0] === 't' && tag[1] === CHANGE_REVIEW_ARTIFACT_TAG),
        )!;
        expect(event.tags).toContainEqual(['d', `corner-commit-watch:${tip}:artifact`]);
        const descriptor = parseChangeReviewArtifactDescriptor(event.content)!;
        expect(descriptor).toMatchObject({
          version: CHANGE_REVIEW_ARTIFACT_VERSION,
          tip,
          fileCount: 141,
        });
        const artifact = JSON.parse(
          new TextDecoder().decode(uploadedReviewArtifacts.get(descriptor.sha256)),
        ) as { files: Array<{ path: string; diff?: string }> };
        expect(artifact.files).toHaveLength(141);
        expect(artifact.files[0]).toEqual(
          expect.objectContaining({
            path: 'changed-000.ts',
            diff: expect.stringContaining('changed0'),
          }),
        );
        expect(artifact.files).toContainEqual(
          expect.objectContaining({ path: 'vendor.min.js', renderUnavailableReason: 'too-large' }),
        );
        expect(info.reviewArtifactPublishedTip).toBe(tip);
      } finally {
        await rm(worktreePath, { recursive: true, force: true });
      }
    },
  );

  it('bounds repeated review-payload failures and publishes an honest terminal state', async () => {
    const agent = newIdentity('commit-watch-bounded-failure-agent');
    const body = newBody(agent);
    const published = stubPublishing();
    const worktreePath = committedFeatureWorktree();
    try {
      const info = watchInfo(body, agent, worktreePath);
      const publishMergeReady = vi
        .spyOn(
          body as unknown as {
            publishMergeReady(info: SubchannelInfoFixture): Promise<boolean>;
          },
          'publishMergeReady',
        )
        .mockRejectedValue(new Error('git diff failed for vendor.min.js: ENOBUFS'));

      await Reflect.get(body, 'pollCornerCommitWatch').call(body);
      await Reflect.get(body, 'pollCornerCommitWatch').call(body);
      await Reflect.get(body, 'pollCornerCommitWatch').call(body);
      await Reflect.get(body, 'pollCornerCommitWatch').call(body);

      expect(publishMergeReady).toHaveBeenCalledTimes(3);
      expect(info.commitWatchFailure).toEqual({
        tip: gitCommand(worktreePath, ['rev-parse', 'HEAD']),
        attempts: 3,
      });
      expect(info.observedReviewTip).toBe(gitCommand(worktreePath, ['rev-parse', 'HEAD']));
      expect(
        published.some((event) =>
          event.tags.some((tag) => tag[0] === 't' && tag[1] === 'merge-not-ready'),
        ),
      ).toBe(true);
      expect(
        published.some((event) =>
          event.tags.some((tag) => tag[0] === 't' && tag[1] === 'change-review-artifact'),
        ),
      ).toBe(false);
    } finally {
      await rm(worktreePath, { recursive: true, force: true });
    }
  });

  it('does not publish while the worktree still has uncommitted work', async () => {
    const agent = newIdentity('commit-watch-dirty-agent');
    const body = newBody(agent);
    const published = stubPublishing();
    const worktreePath = committedFeatureWorktree();
    try {
      writeFileSync(join(worktreePath, 'wip.txt'), 'mid-task\n');
      watchInfo(body, agent, worktreePath);

      await Reflect.get(body, 'pollCornerCommitWatch').call(body);

      expect(published).toHaveLength(0);
    } finally {
      await rm(worktreePath, { recursive: true, force: true });
    }
  });

  it('evaluates each tip once and never duplicates the review card', async () => {
    const agent = newIdentity('commit-watch-idempotent-agent');
    const body = newBody(agent);
    const published = stubPublishing();
    const worktreePath = committedFeatureWorktree();
    try {
      watchInfo(body, agent, worktreePath);

      await Reflect.get(body, 'pollCornerCommitWatch').call(body);
      await Reflect.get(body, 'pollCornerCommitWatch').call(body);

      expect(
        published.filter((event) =>
          event.tags.some((tag) => tag[0] === 't' && tag[1] === 'merge-ready'),
        ),
      ).toHaveLength(1);
    } finally {
      await rm(worktreePath, { recursive: true, force: true });
    }
  });

  it('never revalidates or withdraws an already-advertised tip when main moves', async () => {
    const agent = newIdentity('commit-watch-revalidation-agent');
    const body = newBody(agent);
    const worktreePath = committedFeatureWorktree();
    try {
      const tip = gitCommand(worktreePath, ['rev-parse', 'HEAD']);
      const info = watchInfo(body, agent, worktreePath, {
        observedReviewTip: tip,
        reviewArtifactPublishedTip: tip,
        mergeTarget: { repo: 'repo', branch: 'refs/heads/main', tip },
      });
      const publishMergeReady = vi
        .spyOn(
          body as unknown as {
            publishMergeReady(info: SubchannelInfoFixture): Promise<boolean>;
          },
          'publishMergeReady',
        )
        .mockResolvedValue(true);

      await Reflect.get(body, 'pollCornerCommitWatch').call(body);

      expect(publishMergeReady).not.toHaveBeenCalled();
      expect(info.mergeTarget?.tip).toBe(tip);
    } finally {
      await rm(worktreePath, { recursive: true, force: true });
    }
  });

  it('stays silent while a turn is still running in the corner', async () => {
    const agent = newIdentity('commit-watch-busy-agent');
    const body = newBody(agent);
    const published = stubPublishing();
    const worktreePath = committedFeatureWorktree();
    try {
      watchInfo(body, agent, worktreePath, {
        session: {
          channelId: 'corner-commit-watch',
          sessionId: 'session',
          parentChannelId: 'room-commit-watch',
          client: { activeRunId: () => 'run-1' },
        },
      });

      await Reflect.get(body, 'pollCornerCommitWatch').call(body);

      expect(published).toHaveLength(0);
    } finally {
      await rm(worktreePath, { recursive: true, force: true });
    }
  });

  it('never re-advertises a tip that already landed', async () => {
    const agent = newIdentity('commit-watch-landed-agent');
    const body = newBody(agent);
    const published = stubPublishing();
    const worktreePath = committedFeatureWorktree();
    try {
      const tip = gitCommand(worktreePath, ['rev-parse', 'HEAD']);
      watchInfo(body, agent, worktreePath, {
        landedTip: tip,
        mergeTarget: { repo: 'repo', branch: 'refs/heads/main', tip },
      });

      await Reflect.get(body, 'pollCornerCommitWatch').call(body);

      expect(published).toHaveLength(0);
    } finally {
      await rm(worktreePath, { recursive: true, force: true });
    }
  });

  it('runs from the Room maintenance chain ahead of the member poll', () => {
    // Source assertion: the maintenance step ordering is load-bearing (the
    // watch must run after the land polls so landed corners are skipped via
    // `landedTip`, and before the member poll so a queued steer cannot start
    // a new turn ahead of the card).
    const source = readFileSync(new URL('./body.ts', import.meta.url), 'utf8');
    const maintenance = source.slice(source.indexOf('private async pollRoomMaintenance'));
    const watchStep = maintenance.indexOf("guarded('corner commit watch'");
    const memberPoll = maintenance.indexOf("guarded('corner member poll'");
    const landPoll = maintenance.indexOf("guarded('merge approval pass'");
    expect(watchStep).toBeGreaterThan(-1);
    expect(memberPoll).toBeGreaterThan(watchStep);
    expect(landPoll).toBeGreaterThan(-1);
    expect(landPoll).toBeLessThan(watchStep);
  });
});
