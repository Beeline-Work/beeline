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
describe('corner merge-ready surfaces a real committed change', () => {
  function gitCommand(cwd: string, args: string[]): string {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(result.stderr);
    return result.stdout.trim();
  }

  /** A worktree with one real committed change on its feature branch and a
   *  clean tree, matching a normal completed corner turn. */
  function committedFeatureWorktree(): string {
    const directory = mkdtempSync(join(tmpdir(), 'buzzy-merge-ready-'));
    gitCommand(directory, ['init', '-b', 'main']);
    gitCommand(directory, ['config', 'user.name', 'Merge Ready Test']);
    gitCommand(directory, ['config', 'user.email', 'merge-ready@test.invalid']);
    writeFileSync(join(directory, 'README.md'), '# Before\n');
    gitCommand(directory, ['add', '.']);
    gitCommand(directory, ['commit', '-m', 'base']);
    gitCommand(directory, ['checkout', '-b', 'feature/ready']);
    writeFileSync(join(directory, 'README.md'), '# After\n');
    gitCommand(directory, ['add', 'README.md']);
    gitCommand(directory, ['commit', '-m', 'real change']);
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

  function stubPublishing(): NostrEvent[] {
    const published: NostrEvent[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const upload = mediaUploadResponse(input, init);
        if (upload) return upload;
        if (String(input).endsWith('/query')) {
          const filters = JSON.parse(String(init?.body)) as Array<Record<string, unknown>>;
          const matches = published.filter((event) =>
            filters.some((filter) => {
              if (Array.isArray(filter.kinds) && !(filter.kinds as number[]).includes(event.kind)) {
                return false;
              }
              if (
                Array.isArray(filter.authors) &&
                !(filter.authors as string[]).includes(event.pubkey)
              ) {
                return false;
              }
              return Object.entries(filter).every(([key, values]) => {
                if (!key.startsWith('#') || !Array.isArray(values)) return true;
                return event.tags.some(
                  (tag) => tag[0] === key.slice(1) && (values as string[]).includes(tag[1]!),
                );
              });
            }),
          );
          return new Response(JSON.stringify(matches), { status: 200 });
        }
        published.push(JSON.parse(String(init?.body)) as NostrEvent);
        return new Response(JSON.stringify({ accepted: true }), { status: 200 });
      }),
    );
    return published;
  }

  it('publishes merge-ready for a corner turn that committed a real change to a clean tree', async () => {
    const agent = newIdentity('merge-ready-agent');
    const body = newBody(agent);
    const published = stubPublishing();
    const worktreePath = committedFeatureWorktree();
    try {
      const info = {
        subchannelId: 'corner-merge-ready',
        worktreePath,
        featureBranch: 'feature/ready',
        role: agent,
        session: {
          channelId: 'corner-merge-ready',
          sessionId: 'session',
          parentChannelId: 'room-merge-ready',
        } as never,
        lastPolledAt: 0,
        archived: false,
        boundRepo: { repo: 'repo', targetBranch: 'refs/heads/main' },
      };
      body.registerSubchannel(info);

      const ready = await Reflect.get(body, 'publishMergeReady').call(body, info);

      expect(ready).toBe(true);
      const readyEvent = published.find((event) =>
        event.tags.some((tag) => tag[0] === 't' && tag[1] === 'merge-ready'),
      );
      expect(readyEvent).toBeDefined();
      expect(readyEvent!.tags).toContainEqual([
        'patch-id',
        expect.stringMatching(/^[0-9a-f]{40}$/),
      ]);
      const notReadyEvent = published.find((event) =>
        event.tags.some((tag) => tag[0] === 't' && tag[1] === 'merge-not-ready'),
      );
      expect(notReadyEvent).toBeUndefined();
    } finally {
      await rm(worktreePath, { recursive: true, force: true });
    }
  });

  it('gives a stale clean branch to one Codex turn, verifies it, and publishes review', async () => {
    const agent = newIdentity('merge-ready-auto-sync-agent');
    const body = newBody(agent);
    const published = stubPublishing();
    const worktreePath = committedFeatureWorktree();
    try {
      const featureBefore = gitCommand(worktreePath, ['rev-parse', 'HEAD']);
      gitCommand(worktreePath, ['checkout', 'main']);
      writeFileSync(join(worktreePath, 'MAIN.txt'), 'unrelated target work\n');
      gitCommand(worktreePath, ['add', 'MAIN.txt']);
      gitCommand(worktreePath, ['commit', '-m', 'move main independently']);
      const mainTip = gitCommand(worktreePath, ['rev-parse', 'HEAD']);
      gitCommand(worktreePath, ['checkout', 'feature/ready']);
      const sessionPrompt = vi.fn();
      const info = {
        subchannelId: 'corner-auto-sync',
        worktreePath,
        featureBranch: 'feature/ready',
        role: agent,
        session: {
          channelId: 'corner-auto-sync',
          sessionId: 'session',
          parentChannelId: 'room-auto-sync',
          client: { sessionPrompt },
        } as never,
        lastPolledAt: 0,
        archived: false,
        boundRepo: { repo: 'repo', targetBranch: 'refs/heads/main' },
      };
      body.registerSubchannel(info);
      const syncTurn = vi
        .spyOn(body as never, 'promptAgent' as never)
        .mockImplementation(async (_session: never, prompt: string) => {
          expect(prompt).toContain(`main moved to ${mainTip}`);
          expect(prompt).toContain('make it merge-ready, whatever it takes');
          gitCommand(worktreePath, ['rebase', 'main']);
          return {
            agentText: 'Rebased onto main and verified the change.',
            updates: [],
            toolCalls: [],
            stopReason: 'end_turn',
          } as never;
        });

      await expect(Reflect.get(body, 'publishMergeReady').call(body, info)).resolves.toBe(true);

      const featureAfter = gitCommand(worktreePath, ['rev-parse', 'HEAD']);
      expect(featureAfter).not.toBe(featureBefore);
      expect(
        spawnSync('git', ['merge-base', '--is-ancestor', mainTip, featureAfter], {
          cwd: worktreePath,
        }).status,
      ).toBe(0);
      expect(syncTurn).toHaveBeenCalledTimes(1);
      expect(sessionPrompt).not.toHaveBeenCalled();
      expect(
        published.filter((event) => event.tags.some((tag) => tag[1] === 'merge-ready')),
      ).toHaveLength(1);
      expect(
        published.some((event) => event.tags.some((tag) => tag[1] === 'merge-not-ready')),
      ).toBe(false);
    } finally {
      await rm(worktreePath, { recursive: true, force: true });
    }
  });

  it('gives a conflicting stale branch to one Codex turn before publishing review', async () => {
    const agent = newIdentity('merge-ready-conflict-agent');
    const body = newBody(agent);
    const published = stubPublishing();
    const worktreePath = committedFeatureWorktree();
    try {
      gitCommand(worktreePath, ['checkout', 'main']);
      writeFileSync(join(worktreePath, 'README.md'), '# Main changed too\n');
      gitCommand(worktreePath, ['add', 'README.md']);
      gitCommand(worktreePath, ['commit', '-m', 'conflicting main change']);
      gitCommand(worktreePath, ['checkout', 'feature/ready']);
      const sessionPrompt = vi.fn();
      const info = {
        subchannelId: 'corner-sync-conflict',
        worktreePath,
        featureBranch: 'feature/ready',
        role: agent,
        session: {
          channelId: 'corner-sync-conflict',
          sessionId: 'session',
          parentChannelId: 'room-sync-conflict',
          client: { sessionPrompt },
        } as never,
        lastPolledAt: 0,
        archived: false,
        boundRepo: { repo: 'repo', targetBranch: 'refs/heads/main' },
      };
      body.registerSubchannel(info);
      const mainTip = gitCommand(worktreePath, ['rev-parse', 'main']);
      const syncTurn = vi
        .spyOn(body as never, 'promptAgent' as never)
        .mockImplementation(async (_session: never, prompt: string) => {
          expect(prompt).toContain(`main moved to ${mainTip}`);
          gitCommand(worktreePath, ['reset', '--hard', 'main']);
          writeFileSync(
            join(worktreePath, 'README.md'),
            '# Main changed too\n\n# Before\n\nan old silent pond\n',
          );
          gitCommand(worktreePath, ['add', 'README.md']);
          gitCommand(worktreePath, ['commit', '-m', 'resolve target sync']);
          return {
            agentText: 'Resolved the replay conflict and ran checks.',
            updates: [],
            toolCalls: [],
            stopReason: 'end_turn',
          } as never;
        });

      await expect(Reflect.get(body, 'publishMergeReady').call(body, info)).resolves.toBe(true);

      expect(
        published.filter((event) => event.tags.some((tag) => tag[1] === 'merge-ready')),
      ).toHaveLength(1);
      expect(
        published.some((event) => event.tags.some((tag) => tag[1] === 'merge-sync-conflict')),
      ).toBe(false);
      expect(syncTurn).toHaveBeenCalledTimes(1);
      expect(sessionPrompt).not.toHaveBeenCalled();
      expect(gitCommand(worktreePath, ['rev-parse', 'HEAD'])).not.toBe(mainTip);
      expect(existsSync(join(worktreePath, '.git', 'rebase-merge'))).toBe(false);
      expect(info.cornerState).toEqual({ state: 'waiting', reason: 'review' });
      expect(info.mergeTarget?.tip).toBe(gitCommand(worktreePath, ['rev-parse', 'HEAD']));
    } finally {
      await rm(worktreePath, { recursive: true, force: true });
    }
  });

  it('publishes merge-ready when the only worktree dirt is the Body-owned private-state link', async () => {
    const agent = newIdentity('merge-ready-private-state-agent');
    const body = newBody(agent);
    const published = stubPublishing();
    const worktreePath = committedFeatureWorktree();
    const privateState = mkdtempSync(join(tmpdir(), 'buzzy-agent-private-'));
    try {
      const agentPrivateState = await prepareCornerAgentPrivateState({
        root: privateState,
        worktreePath,
        channelId: 'corner-merge-ready-private-state',
      });
      mkdirSync(join(agentPrivateState.worktreePath, 'memory'), { recursive: true });
      writeFileSync(
        join(agentPrivateState.worktreePath, 'memory/charles_episodes.json'),
        '{"pond":true}\n',
      );
      expect(gitCommand(worktreePath, ['status', '--porcelain=v1'])).toBe('');
      expect(gitCommand(worktreePath, ['status', '--ignored', '--short'])).toContain(
        '!! .beeline-agent-private-',
      );
      const info = {
        subchannelId: 'corner-merge-ready-private-state',
        worktreePath,
        featureBranch: 'feature/ready',
        role: agent,
        session: {
          channelId: 'corner-merge-ready-private-state',
          sessionId: 'session',
          parentChannelId: 'room-merge-ready',
          agentPrivateState,
        } as never,
        lastPolledAt: 0,
        archived: false,
        boundRepo: { repo: 'repo', targetBranch: 'refs/heads/main' },
      };
      body.registerSubchannel(info);

      const ready = await Reflect.get(body, 'publishMergeReady').call(body, info);

      expect(ready).toBe(true);
      expect(
        published.some((event) =>
          event.tags.some((tag) => tag[0] === 't' && tag[1] === 'merge-ready'),
        ),
      ).toBe(true);
    } finally {
      await rm(worktreePath, { recursive: true, force: true });
      await rm(privateState, { recursive: true, force: true });
    }
  });

  it('does not mistake a project-owned memory path for agent-private state', async () => {
    const agent = newIdentity('merge-not-ready-project-memory-agent');
    const body = newBody(agent);
    const published = stubPublishing();
    const worktreePath = committedFeatureWorktree();
    try {
      mkdirSync(join(worktreePath, 'memory'), { recursive: true });
      writeFileSync(join(worktreePath, 'memory/project-index.json'), '{"project":true}\n');
      const info = {
        subchannelId: 'corner-project-memory-dirty',
        worktreePath,
        featureBranch: 'feature/ready',
        role: agent,
        session: {
          channelId: 'corner-project-memory-dirty',
          sessionId: 'session',
        } as never,
        lastPolledAt: 0,
        archived: false,
        boundRepo: { repo: 'repo', targetBranch: 'refs/heads/main' },
      };
      body.registerSubchannel(info);

      const ready = await Reflect.get(body, 'publishMergeReady').call(body, info);

      expect(ready).toBe(false);
      expect(
        published.find((event) =>
          event.tags.some((tag) => tag[0] === 't' && tag[1] === 'merge-not-ready'),
        )?.content,
      ).toContain('memory/project-index.json');
    } finally {
      await rm(worktreePath, { recursive: true, force: true });
    }
  });

  it('publishes a non-empty reason when the worktree still has uncommitted work, for the mobile review panel to show', async () => {
    const agent = newIdentity('merge-not-ready-agent');
    const body = newBody(agent);
    const published = stubPublishing();
    const worktreePath = committedFeatureWorktree();
    try {
      // A project-owned lessons path is still real project content, not persona
      // scratch merely because of its name. Leave a tracked edit uncommitted.
      mkdirSync(join(worktreePath, 'lessons'), { recursive: true });
      writeFileSync(join(worktreePath, 'lessons/bank.json'), '{"project":"baseline"}\n');
      gitCommand(worktreePath, ['add', 'lessons/bank.json']);
      gitCommand(worktreePath, ['commit', '-m', 'add project lessons']);
      writeFileSync(join(worktreePath, 'lessons/bank.json'), '{"project":"unfinished"}\n');
      const info = {
        subchannelId: 'corner-merge-not-ready',
        worktreePath,
        featureBranch: 'feature/ready',
        role: agent,
        session: { channelId: 'corner-merge-not-ready', sessionId: 'session' } as never,
        lastPolledAt: 0,
        archived: false,
        boundRepo: { repo: 'repo', targetBranch: 'refs/heads/main' },
      };
      body.registerSubchannel(info);

      const ready = await Reflect.get(body, 'publishMergeReady').call(body, info);

      expect(ready).toBe(false);
      const notReadyEvent = published.find((event) =>
        event.tags.some((tag) => tag[0] === 't' && tag[1] === 'merge-not-ready'),
      );
      expect(notReadyEvent?.content).toBeTruthy();
      expect(notReadyEvent!.content).toContain('Nothing ready to merge yet');
      expect(notReadyEvent!.content).toContain('lessons/bank.json');
    } finally {
      await rm(worktreePath, { recursive: true, force: true });
    }
  });

  it('withdraws READY for no change, empty diff, stale target, and denied target access', async () => {
    const agent = newIdentity('merge-not-ready-reasons-agent');
    const published = stubPublishing();
    const paths = [
      committedFeatureWorktree(),
      committedFeatureWorktree(),
      committedFeatureWorktree(),
      committedFeatureWorktree(),
    ];
    try {
      const infoFor = (worktreePath: string, subchannelId: string) => ({
        subchannelId,
        worktreePath,
        featureBranch: 'feature/ready',
        role: agent,
        session: {
          channelId: subchannelId,
          sessionId: 'session',
          parentChannelId: 'room-merge-ready',
        } as never,
        lastPolledAt: 0,
        archived: false,
        boundRepo: { repo: 'repo', targetBranch: 'refs/heads/main' },
      });

      gitCommand(paths[0]!, ['reset', '--hard', 'main']);
      const noChangeBody = newBody(agent);
      const noChangeInfo = infoFor(paths[0]!, 'corner-no-commit');
      noChangeBody.registerSubchannel(noChangeInfo);
      await Reflect.get(noChangeBody, 'publishMergeReady').call(noChangeBody, noChangeInfo);
      expect(Reflect.get(noChangeInfo, 'lastMergeNotReadyReason')).toContain(
        'No committed change is available for this turn',
      );
      expect(Reflect.get(noChangeInfo, 'cornerState')).toEqual({ state: 'idle' });

      gitCommand(paths[1]!, ['reset', '--hard', 'main']);
      gitCommand(paths[1]!, ['commit', '--allow-empty', '-m', 'empty feature commit']);
      const emptyBody = newBody(agent);
      const emptyInfo = infoFor(paths[1]!, 'corner-empty-diff');
      emptyBody.registerSubchannel(emptyInfo);
      await Reflect.get(emptyBody, 'publishMergeReady').call(emptyBody, emptyInfo);
      expect(Reflect.get(emptyInfo, 'lastMergeNotReadyReason')).toContain(
        'combined diff against refs/heads/main is empty',
      );
      expect(Reflect.get(emptyInfo, 'cornerState')).toEqual({ state: 'idle' });

      const staleBody = newBody(agent);
      const staleInfo = infoFor(paths[2]!, 'corner-stale-target');
      staleBody.registerSubchannel(staleInfo);
      await Reflect.get(staleBody, 'publishMergeReady').call(staleBody, staleInfo);
      const publishedTip = Reflect.get(staleInfo, 'mergeTarget').tip as string;
      gitCommand(paths[2]!, ['branch', '-f', 'main', 'HEAD']);
      await Reflect.get(staleBody, 'publishMergeReady').call(staleBody, staleInfo);
      expect(Reflect.get(staleInfo, 'mergeTarget')).toBeUndefined();
      expect(Reflect.get(staleInfo, 'lastMergeNotReadyReason')).toContain(publishedTip);
      expect(Reflect.get(staleInfo, 'lastMergeNotReadyReason')).toContain(
        'stale and has been withdrawn',
      );
      expect(Reflect.get(staleInfo, 'cornerState')).toEqual({ state: 'idle' });

      const deniedBody = newBody(agent);
      const deniedInfo = infoFor(paths[3]!, 'corner-target-access-denied');
      deniedBody.registerSubchannel(deniedInfo);
      await Reflect.get(deniedBody, 'publishMergeReady').call(deniedBody, deniedInfo);
      vi.spyOn(deniedBody as never, 'currentReviewTargetTip' as never).mockResolvedValue({
        reason: 'permission denied while reading the landing remote',
      } as never);
      await Reflect.get(deniedBody, 'publishMergeReady').call(deniedBody, deniedInfo);
      expect(Reflect.get(deniedInfo, 'mergeTarget')).toBeUndefined();
      expect(Reflect.get(deniedInfo, 'lastMergeNotReadyReason')).toContain('permission denied');
      expect(Reflect.get(deniedInfo, 'cornerState')).toEqual({ state: 'idle' });

      const notReadyCards = published.filter((event) =>
        event.tags.some((tag) => tag[0] === 't' && tag[1] === 'merge-not-ready'),
      );
      expect(notReadyCards).toHaveLength(4);
    } finally {
      await Promise.all(paths.map((path) => rm(path, { recursive: true, force: true })));
    }
  });

  it('publishes the original reply once and never spends a model turn on a rejected merge gate', async () => {
    const agent = newIdentity('merge-feedback-agent');
    const body = newBody(agent);
    const published: NostrEvent[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const queryResponse = relayQueryResponse(published, input, init);
        if (queryResponse) return queryResponse;
        const upload = mediaUploadResponse(input, init);
        if (upload) return upload;
        published.push(JSON.parse(String(init?.body)) as NostrEvent);
        return new Response(JSON.stringify({ accepted: true }), { status: 200 });
      }),
    );
    const worktreePath = committedFeatureWorktree();
    try {
      const durableState = Reflect.get(body, 'durableState');
      vi.spyOn(durableState, 'recordModelTurn').mockResolvedValue();
      writeFileSync(join(worktreePath, 'PENDING.txt'), 'commit me\n');
      const prompts: string[] = [];
      const sessionPrompt = vi.fn(
        async (
          _sessionId: string,
          prompt: string,
          _timeoutMs: number,
          onChunk?: (delta: string, fullText: string) => void,
        ) => {
          prompts.push(prompt);
          const agentText = 'Here is the answer to the human question.';
          onChunk?.(agentText, agentText);
          return { stopReason: 'end_turn', updates: [], agentText, toolCalls: [] };
        },
      );
      const info = {
        subchannelId: 'corner-merge-feedback',
        worktreePath,
        featureBranch: 'feature/ready',
        role: agent,
        session: {
          channelId: 'corner-merge-feedback',
          parentChannelId: 'room-merge-feedback',
          sessionId: 'session',
          client: { sessionPrompt, sessionCancel: vi.fn() },
        } as never,
        lastPolledAt: 0,
        archived: false,
        boundRepo: { repo: 'repo', targetBranch: 'refs/heads/main' },
      };
      body.registerSubchannel(info);

      Reflect.get(body, 'startAgentTask').call(
        body,
        info,
        'Finish the pending work.',
        'Finish the pending work.',
        {
          requestId: 'request-feedback',
          originalRequestId: 'request-feedback',
          cause: 'corner-opening',
        },
      );
      await vi.waitFor(() => expect(prompts.length).toBeGreaterThan(0));
      await body.waitForAgentTasks();

      expect(prompts).toHaveLength(1);
      expect(
        published.some((event) =>
          event.tags.some((tag) => tag[0] === 't' && tag[1] === 'merge-not-ready'),
        ),
      ).toBe(true);
      expect(info.mergeTarget).toBeUndefined();
      expect(info.mergeGateBlocked?.reason).toContain('PENDING.txt');
      expect(
        published
          .filter((event) => event.tags.some((tag) => tag[1] === 'agent-message'))
          .map((event) => event.content),
      ).toEqual(['Here is the answer to the human question.']);
      expect(published.some((event) => event.content.includes('merge-gate rejections'))).toBe(
        false,
      );
    } finally {
      await rm(worktreePath, { recursive: true, force: true });
    }
  });

  it('suppresses byte-identical consecutive agent replies while leaving gate status separate', async () => {
    const agent = newIdentity('merge-feedback-bounded-agent');
    const body = newBody(agent);
    const published: NostrEvent[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        published.push(JSON.parse(String(init?.body)) as NostrEvent);
        return new Response(JSON.stringify({ accepted: true }), { status: 200 });
      }),
    );
    const worktreePath = committedFeatureWorktree();
    try {
      writeFileSync(join(worktreePath, 'STUCK.txt'), 'still dirty\n');
      const info = {
        subchannelId: 'corner-merge-feedback-stuck',
        worktreePath,
        featureBranch: 'feature/ready',
        role: agent,
        session: {
          channelId: 'corner-merge-feedback-stuck',
          parentChannelId: 'room-merge-feedback-stuck',
          sessionId: 'session',
        } as never,
        lastPolledAt: 0,
        archived: false,
        boundRepo: { repo: 'repo', targetBranch: 'refs/heads/main' },
      };
      body.registerSubchannel(info);
      const result = {
        agentText: 'The human answer survives the gate.',
        updates: [],
        toolCalls: [],
        stopReason: 'end_turn',
      };
      const attribution = {
        requestId: 'request-stuck',
        originalRequestId: 'request-stuck',
        cause: 'corner-follow-up',
      };
      await Reflect.get(body, 'finishCornerTurnAgainstMergeGate').call(
        body,
        info,
        result,
        attribution,
        'fallback',
      );
      await Reflect.get(body, 'finishCornerTurnAgainstMergeGate').call(
        body,
        info,
        result,
        attribution,
        'fallback',
      );

      expect(
        published.filter(
          (event) =>
            Array.isArray(event.tags) &&
            event.tags.some((tag) => tag[0] === 't' && tag[1] === 'merge-not-ready'),
        ),
      ).toHaveLength(2);
      expect(
        published.some(
          (event) =>
            Array.isArray(event.tags) &&
            event.tags.some((tag) => tag[0] === 't' && tag[1] === 'merge-ready'),
        ),
      ).toBe(false);
      expect(info.mergeTarget).toBeUndefined();
      expect(
        published
          .filter((event) => event.tags.some((tag) => tag[1] === 'agent-message'))
          .map((event) => event.content),
      ).toEqual(['The human answer survives the gate.']);
    } finally {
      await rm(worktreePath, { recursive: true, force: true });
    }
  });
});

describe('a local-only repository lands through the daemon, never through the agent', () => {
  function gitCommand(cwd: string, args: string[]): string {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
    return result.stdout.trim();
  }

  /**
   * A repository with NO remote at all (exactly what `beeline pair` records as
   * `localOnly`), plus a linked corner worktree holding one committed change —
   * the shape the dogfood hit, where the approval had nothing to push to.
   */
  function localOnlyRepoWithCorner(): {
    root: string;
    repoPath: string;
    cornerPath: string;
    tip: string;
  } {
    const root = mkdtempSync(join(tmpdir(), 'buzzy-local-land-'));
    const repoPath = join(root, 'repo');
    const cornerPath = join(root, 'corner');
    mkdirSync(repoPath, { recursive: true });
    gitCommand(repoPath, ['init', '-b', 'master']);
    gitCommand(repoPath, ['config', 'user.name', 'Local Land Test']);
    gitCommand(repoPath, ['config', 'user.email', 'local-land@test.invalid']);
    writeFileSync(join(repoPath, 'README.md'), '# Before\n');
    gitCommand(repoPath, ['add', '.']);
    gitCommand(repoPath, ['commit', '-m', 'base']);
    gitCommand(repoPath, ['worktree', 'add', '-b', 'feature/haiku', cornerPath, 'master']);
    gitCommand(cornerPath, ['config', 'user.name', 'Local Land Agent']);
    gitCommand(cornerPath, ['config', 'user.email', 'agent@test.invalid']);
    writeFileSync(join(cornerPath, 'README.md'), '# Before\n\nan old silent pond\n');
    gitCommand(cornerPath, ['add', 'README.md']);
    gitCommand(cornerPath, ['commit', '-m', 'add a haiku']);
    return { root, repoPath, cornerPath, tip: gitCommand(cornerPath, ['rev-parse', 'HEAD']) };
  }

  function newBody(agent: ReturnType<typeof newIdentity>, statePath: string) {
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
      undefined,
      { statePath },
    );
  }

  function localCornerInfo(
    agent: ReturnType<typeof newIdentity>,
    repoPath: string,
    cornerPath: string,
    tip: string,
  ) {
    return {
      subchannelId: 'corner-local-land',
      worktreePath: cornerPath,
      featureBranch: 'feature/haiku',
      role: agent,
      session: {
        channelId: 'corner-local-land',
        parentChannelId: 'room-local',
        sessionId: 'session',
      } as never,
      lastPolledAt: 0,
      archived: false,
      boundRepo: {
        repo: 'proj',
        repositoryKey: 'local-key',
        localOnly: true,
        localPath: repoPath,
        targetBranch: 'refs/heads/master',
      },
      mergeTarget: { repo: 'local/local-key', branch: 'refs/heads/master', tip },
    };
  }

  it('fast-forwards the checked-out target branch, moving the working tree with it', async () => {
    const agent = newIdentity('local-land-ff');
    const { root, repoPath, tip } = localOnlyRepoWithCorner();
    try {
      const body = newBody(agent, join(root, 'state.json'));
      const outcome = await Reflect.get(body, 'landInLocalCheckout').call(body, repoPath, {
        repo: 'local/local-key',
        branch: 'refs/heads/master',
        tip,
      });

      expect(outcome).toEqual({ kind: 'landed' });
      expect(gitCommand(repoPath, ['rev-parse', 'refs/heads/master'])).toBe(tip);
      // The ref advance must not leave the operator's tree reading as reverted.
      expect(readFileSync(join(repoPath, 'README.md'), 'utf8')).toContain('an old silent pond');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('advances a target branch that is not the one checked out', async () => {
    const agent = newIdentity('local-land-ref');
    const { root, repoPath, tip } = localOnlyRepoWithCorner();
    try {
      gitCommand(repoPath, ['checkout', '-q', '-b', 'scratch']);
      const body = newBody(agent, join(root, 'state.json'));
      const outcome = await Reflect.get(body, 'landInLocalCheckout').call(body, repoPath, {
        repo: 'local/local-key',
        branch: 'refs/heads/master',
        tip,
      });

      expect(outcome).toEqual({ kind: 'landed' });
      expect(gitCommand(repoPath, ['rev-parse', 'refs/heads/master'])).toBe(tip);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses a non-fast-forward land, exactly like the remote path rejects a moved target', async () => {
    const agent = newIdentity('local-land-nonff');
    const { root, repoPath, tip } = localOnlyRepoWithCorner();
    try {
      writeFileSync(join(repoPath, 'OTHER.md'), 'someone else landed first\n');
      gitCommand(repoPath, ['add', 'OTHER.md']);
      gitCommand(repoPath, ['commit', '-m', 'target moved on']);
      const moved = gitCommand(repoPath, ['rev-parse', 'refs/heads/master']);
      const body = newBody(agent, join(root, 'state.json'));

      const outcome = await Reflect.get(body, 'landInLocalCheckout').call(body, repoPath, {
        repo: 'local/local-key',
        branch: 'refs/heads/master',
        tip,
      });

      expect(outcome.kind).toBe('failed');
      expect(gitCommand(repoPath, ['rev-parse', 'refs/heads/master'])).toBe(moved);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('accepts an approval signed by the successor of the binding-author key (key succession)', async () => {
    const agent = newIdentity('succession-agent');
    const predecessorKey = newIdentity('old-owner');
    const successorKey = newIdentity('new-owner');
    const { root, repoPath, cornerPath, tip } = localOnlyRepoWithCorner();
    const target = { repo: 'local/local-key', branch: 'refs/heads/master', tip };
    const approval = buildMergeApproval(successorKey, 'corner-succession', target);
    const published: NostrEvent[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        if (String(input).endsWith('/query')) {
          const filters = JSON.parse(String(init?.body)) as Record<string, unknown>[];
          // The approvals read returns ONLY the successor-signed approval.
          // Every other read (agent registry, role projections) sees nothing,
          // so authorizeReviewer refuses on role — the succession path must
          // be what accepts this approval.
          const isApprovalRead = filters.some(
            (filter) => Array.isArray(filter['#t']) && filter['#t'].includes('buzz-merge-approval'),
          );
          return new Response(JSON.stringify(isApprovalRead ? [approval] : []), { status: 200 });
        }
        published.push(JSON.parse(String(init?.body)) as NostrEvent);
        return new Response(JSON.stringify({ accepted: true }), { status: 200 });
      }),
    );
    try {
      const body = new Body(
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
        undefined,
        {
          statePath: join(root, 'state.json'),
          resolveBindingOwnerKey: async () => successorKey.publicKey,
        },
      );
      const info = localCornerInfo(agent, repoPath, cornerPath, tip);
      info.subchannelId = 'corner-succession';
      body.registerSubchannel(info as never);

      const accepted = await Reflect.get(body, 'findHumanMergeApproval').call(body, info);

      expect(accepted).toMatchObject({
        id: approval.id,
        reviewer: successorKey.publicKey,
        tip,
      });
      expect(published.some((event) => event.tags.includes('decision'))).toBe(false);
      expect(
        published.some((event) =>
          event.tags.some((tag) => tag[0] === 'decision' && tag[1] === 'accepted'),
        ),
      ).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses a succession-shaped approval from an unrelated key with no ledger answer', async () => {
    const agent = newIdentity('succession-agent-unrelated');
    const predecessorKey = newIdentity('old-owner-unrelated');
    const unrelatedKey = newIdentity('unrelated-key');
    const { root, repoPath, cornerPath, tip } = localOnlyRepoWithCorner();
    const target = { repo: 'local/local-key', branch: 'refs/heads/master', tip };
    const approval = buildMergeApproval(unrelatedKey, 'corner-succession-unrelated', target);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        if (String(input).endsWith('/query')) {
          const filters = JSON.parse(String(init?.body)) as Record<string, unknown>[];
          const isApprovalRead = filters.some(
            (filter) => Array.isArray(filter['#t']) && filter['#t'].includes('buzz-merge-approval'),
          );
          return new Response(JSON.stringify(isApprovalRead ? [approval] : []), { status: 200 });
        }
        return new Response(JSON.stringify({ accepted: true }), { status: 200 });
      }),
    );
    try {
      const body = new Body(
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
        undefined,
        {
          statePath: join(root, 'state.json'),
          resolveBindingOwnerKey: async () => predecessorKey.publicKey,
        },
      );
      const info = localCornerInfo(agent, repoPath, cornerPath, tip);
      info.subchannelId = 'corner-succession-unrelated';
      body.registerSubchannel(info as never);

      const accepted = await Reflect.get(body, 'findHumanMergeApproval').call(body, info);

      expect(accepted).toBeUndefined();
      expect(info.humanMergeApproval).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('lands an approved local-only corner and publishes the same landed status the remote path does', async () => {
    const agent = newIdentity('local-land-poll');
    const reviewer = newIdentity('local-land-reviewer');
    const { root, repoPath, cornerPath, tip } = localOnlyRepoWithCorner();
    const published: NostrEvent[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        published.push(JSON.parse(String(init?.body)) as NostrEvent);
        return new Response(JSON.stringify({ accepted: true }), { status: 200 });
      }),
    );
    try {
      const body = newBody(agent, join(root, 'state.json'));
      const info = localCornerInfo(agent, repoPath, cornerPath, tip);
      body.registerSubchannel(info as never);
      Reflect.set(body, 'findHumanMergeApproval', async (target: typeof info) => {
        target.humanMergeApproval = { id: 'approval-1', reviewer: reviewer.publicKey, tip };
        return target.humanMergeApproval;
      });

      const landed = await Reflect.get(body, 'pollDirectRemoteApprovals').call(body);

      expect(landed).toBe(1);
      expect(gitCommand(repoPath, ['rev-parse', 'refs/heads/master'])).toBe(tip);
      const landedEvent = published.find((event) =>
        event.tags?.some((tag) => tag[0] === 't' && tag[1] === 'landed'),
      );
      expect(landedEvent).toBeDefined();
      expect(landedEvent!.tags).toContainEqual(['delivery', 'landed']);
      const parentStatus = published.find(
        (event) =>
          event.tags?.some((tag) => tag[0] === 'subchannel' && tag[1] === 'corner-local-land') &&
          event.tags?.some((tag) => tag[0] === 'delivery' && tag[1] === 'landed'),
      );
      expect(parentStatus).toBeDefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('uses one Codex sync turn and lands locally on the same button press', async () => {
    const agent = newIdentity('local-land-poll-nonff');
    const reviewer = newIdentity('local-land-reviewer-nonff');
    const { root, repoPath, cornerPath, tip } = localOnlyRepoWithCorner();
    const published: NostrEvent[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const queryResponse = relayQueryResponse(published, input, init);
        if (queryResponse) return queryResponse;
        const upload = mediaUploadResponse(input, init);
        if (upload) return upload;
        published.push(JSON.parse(String(init?.body)) as NostrEvent);
        return new Response(JSON.stringify({ accepted: true }), { status: 200 });
      }),
    );
    try {
      writeFileSync(join(repoPath, 'OTHER.md'), 'someone else landed first\n');
      gitCommand(repoPath, ['add', 'OTHER.md']);
      gitCommand(repoPath, ['commit', '-m', 'target moved on']);
      const moved = gitCommand(repoPath, ['rev-parse', 'refs/heads/master']);
      const body = newBody(agent, join(root, 'state.json'));
      const info = localCornerInfo(agent, repoPath, cornerPath, tip);
      body.registerSubchannel(info as never);
      Reflect.set(body, 'findHumanMergeApproval', async (target: typeof info) => {
        target.humanMergeApproval = { id: 'approval-1', reviewer: reviewer.publicKey, tip };
        return target.humanMergeApproval;
      });
      const syncTurn = vi
        .spyOn(body as never, 'promptAgent' as never)
        .mockImplementation(async (_session: never, prompt: string) => {
          expect(prompt).toContain(`master moved to ${moved}`);
          gitCommand(cornerPath, ['rebase', 'master']);
          return {
            agentText: 'Updated the branch onto the moved target and ran checks.',
            updates: [],
            toolCalls: [],
            stopReason: 'end_turn',
          } as never;
        });

      const landed = await Reflect.get(body, 'pollDirectRemoteApprovals').call(body);

      expect(landed).toBe(1);
      expect(syncTurn).toHaveBeenCalledTimes(1);
      const landedTip = gitCommand(repoPath, ['rev-parse', 'refs/heads/master']);
      expect(landedTip).not.toBe(moved);
      expect(gitCommand(cornerPath, ['merge-base', '--is-ancestor', moved, landedTip])).toBe('');
      const realigning = published.find((event) =>
        event.tags?.some((tag) => tag[0] === 'delivery-stage' && tag[1] === 'realigning'),
      );
      expect(realigning).toBeDefined();
      expect(realigning!.content).toMatch(/Realigning/);
      expect(realigning!.content).not.toMatch(/\bgit\b|hint:|non-fast-forward/i);
      expect(info.humanMergeApproval?.id).toBe('approval-1');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('serializes two approved corners for one repository and lands both back-to-back', async () => {
    const root = mkdtempSync(join(tmpdir(), 'buzzy-local-land-queue-'));
    const repoPath = join(root, 'repo');
    const cornerA = join(root, 'corner-a');
    const cornerB = join(root, 'corner-b');
    mkdirSync(repoPath, { recursive: true });
    gitCommand(repoPath, ['init', '-b', 'master']);
    gitCommand(repoPath, ['config', 'user.name', 'Landing Queue Test']);
    gitCommand(repoPath, ['config', 'user.email', 'queue@test.invalid']);
    writeFileSync(join(repoPath, 'README.md'), '# Queue\n');
    gitCommand(repoPath, ['add', '.']);
    gitCommand(repoPath, ['commit', '-m', 'base']);
    gitCommand(repoPath, ['worktree', 'add', '-b', 'feature/a', cornerA, 'master']);
    gitCommand(repoPath, ['worktree', 'add', '-b', 'feature/b', cornerB, 'master']);
    writeFileSync(join(cornerA, 'A.txt'), 'first corner\n');
    gitCommand(cornerA, ['add', 'A.txt']);
    gitCommand(cornerA, ['commit', '-m', 'corner a']);
    writeFileSync(join(cornerB, 'B.txt'), 'second corner\n');
    gitCommand(cornerB, ['add', 'B.txt']);
    gitCommand(cornerB, ['commit', '-m', 'corner b']);
    const tipA = gitCommand(cornerA, ['rev-parse', 'HEAD']);
    const tipB = gitCommand(cornerB, ['rev-parse', 'HEAD']);
    const published: NostrEvent[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const queryResponse = relayQueryResponse(published, input, init);
        if (queryResponse) return queryResponse;
        const upload = mediaUploadResponse(input, init);
        if (upload) return upload;
        published.push(JSON.parse(String(init?.body)) as NostrEvent);
        return new Response(JSON.stringify({ accepted: true }), { status: 200 });
      }),
    );
    try {
      const agentA = newIdentity('local-land-queue-a');
      const agentB = newIdentity('local-land-queue-b');
      const reviewer = newIdentity('local-land-queue-reviewer');
      const bodyA = newBody(agentA, join(root, 'state-a.json'));
      const bodyB = newBody(agentB, join(root, 'state-b.json'));
      const infoA = {
        ...localCornerInfo(agentA, repoPath, cornerA, tipA),
        subchannelId: 'corner-queue-a',
        featureBranch: 'feature/a',
        session: {
          channelId: 'corner-queue-a',
          parentChannelId: 'room-queue',
          sessionId: 'session-a',
        },
      };
      const infoB = {
        ...localCornerInfo(agentB, repoPath, cornerB, tipB),
        subchannelId: 'corner-queue-b',
        featureBranch: 'feature/b',
        session: {
          channelId: 'corner-queue-b',
          parentChannelId: 'room-queue',
          sessionId: 'session-b',
        },
      };
      bodyA.registerSubchannel(infoA as never);
      bodyB.registerSubchannel(infoB as never);
      Reflect.set(bodyA, 'findHumanMergeApproval', async (info: typeof infoA) => {
        info.humanMergeApproval = { id: 'approval-a', reviewer: reviewer.publicKey, tip: tipA };
        return info.humanMergeApproval;
      });
      Reflect.set(bodyB, 'findHumanMergeApproval', async (info: typeof infoB) => {
        info.humanMergeApproval = { id: 'approval-b', reviewer: reviewer.publicKey, tip: tipB };
        return info.humanMergeApproval;
      });
      const promptA = vi.spyOn(bodyA as never, 'promptAgent' as never);
      const promptB = vi
        .spyOn(bodyB as never, 'promptAgent' as never)
        .mockImplementation(async (_session: never, prompt: string) => {
          const mainTip = gitCommand(repoPath, ['rev-parse', 'refs/heads/master']);
          expect(prompt).toContain(`master moved to ${mainTip}`);
          gitCommand(cornerB, ['rebase', 'master']);
          return {
            agentText: 'Replayed corner B onto corner A and ran checks.',
            updates: [],
            toolCalls: [],
            stopReason: 'end_turn',
          } as never;
        });

      const results = await Promise.all([
        Reflect.get(bodyA, 'pollDirectRemoteApprovals').call(bodyA),
        Reflect.get(bodyB, 'pollDirectRemoteApprovals').call(bodyB),
      ]);

      expect(results.reduce((sum, count) => sum + count, 0)).toBe(2);
      expect(readFileSync(join(repoPath, 'A.txt'), 'utf8')).toBe('first corner\n');
      expect(readFileSync(join(repoPath, 'B.txt'), 'utf8')).toBe('second corner\n');
      expect(promptA).not.toHaveBeenCalled();
      expect(promptB).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('uses one automatic agent turn to resolve a landing conflict, then lands', async () => {
    const agent = newIdentity('local-land-conflict-agent');
    const reviewer = newIdentity('local-land-conflict-reviewer');
    const { root, repoPath, cornerPath, tip } = localOnlyRepoWithCorner();
    const published: NostrEvent[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const queryResponse = relayQueryResponse(published, input, init);
        if (queryResponse) return queryResponse;
        const upload = mediaUploadResponse(input, init);
        if (upload) return upload;
        published.push(JSON.parse(String(init?.body)) as NostrEvent);
        return new Response(JSON.stringify({ accepted: true }), { status: 200 });
      }),
    );
    try {
      writeFileSync(join(repoPath, 'README.md'), '# Main changed during review\n');
      gitCommand(repoPath, ['add', 'README.md']);
      gitCommand(repoPath, ['commit', '-m', 'conflict after approval']);
      const body = newBody(agent, join(root, 'state.json'));
      const info = localCornerInfo(agent, repoPath, cornerPath, tip);
      body.registerSubchannel(info as never);
      Reflect.set(body, 'findHumanMergeApproval', async (target: typeof info) => {
        target.humanMergeApproval = { id: 'approval-conflict', reviewer: reviewer.publicKey, tip };
        return target.humanMergeApproval;
      });
      const promptAgent = vi
        .spyOn(body as never, 'promptAgent' as never)
        .mockImplementation(async (_session: never, prompt: string) => {
          expect(prompt).toContain('make it merge-ready, whatever it takes');
          expect(prompt).toContain('Do not ask the human');
          gitCommand(cornerPath, ['reset', '--hard', 'master']);
          writeFileSync(
            join(cornerPath, 'README.md'),
            '# Main changed during review\n\n# Before\n\nan old silent pond\n',
          );
          gitCommand(cornerPath, ['add', 'README.md']);
          gitCommand(cornerPath, ['commit', '-m', 'resolve landing conflict']);
          return {
            agentText: 'Resolved the conflict and validated the result.',
            updates: [],
            toolCalls: [],
            stopReason: 'end_turn',
          } as never;
        });

      await expect(Reflect.get(body, 'pollDirectRemoteApprovals').call(body)).resolves.toBe(1);
      await expect(Reflect.get(body, 'pollDirectRemoteApprovals').call(body)).resolves.toBe(0);

      expect(promptAgent).toHaveBeenCalledTimes(1);
      expect(
        published.some((event) => event.tags?.some((tag) => tag[1] === 'merge-sync-conflict')),
      ).toBe(false);
      expect(
        published.some((event) => event.tags?.some((tag) => tag[1] === 'landing-blocked')),
      ).toBe(false);
      const landedTip = gitCommand(repoPath, ['rev-parse', 'refs/heads/master']);
      expect(landedTip).toBe(gitCommand(cornerPath, ['rev-parse', 'HEAD']));
      expect(readFileSync(join(repoPath, 'README.md'), 'utf8')).toContain('an old silent pond');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('parks one failed button press without looping and retries only on a new approval', async () => {
    const agent = newIdentity('local-land-bounded-agent');
    const reviewer = newIdentity('local-land-bounded-reviewer');
    const { root, repoPath, cornerPath, tip } = localOnlyRepoWithCorner();
    const published: NostrEvent[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const queryResponse = relayQueryResponse(published, input, init);
        if (queryResponse) return queryResponse;
        published.push(JSON.parse(String(init?.body)) as NostrEvent);
        return new Response(JSON.stringify({ accepted: true }), { status: 200 });
      }),
    );
    try {
      writeFileSync(join(repoPath, 'README.md'), '# Main changed during review\n');
      gitCommand(repoPath, ['add', 'README.md']);
      gitCommand(repoPath, ['commit', '-m', 'conflict after approval']);
      const body = newBody(agent, join(root, 'state.json'));
      const info = localCornerInfo(agent, repoPath, cornerPath, tip);
      body.registerSubchannel(info as never);
      let approvalId = 'approval-first';
      Reflect.set(body, 'findHumanMergeApproval', async (target: typeof info) => {
        target.humanMergeApproval = { id: approvalId, reviewer: reviewer.publicKey, tip };
        return target.humanMergeApproval;
      });
      const promptAgent = vi.spyOn(body as never, 'promptAgent' as never).mockResolvedValue({
        agentText: 'Unable to complete the resolution.',
        updates: [],
        toolCalls: [],
        stopReason: 'end_turn',
      } as never);

      await expect(Reflect.get(body, 'pollDirectRemoteApprovals').call(body)).resolves.toBe(0);
      const firstBlocks = published.filter((event) =>
        event.tags?.some((tag) => tag[0] === 't' && tag[1] === 'landing-blocked'),
      );
      expect(firstBlocks).toHaveLength(1);
      expect(firstBlocks[0]!.content).toMatch(/^Merge blocked: [^\n]+$/);
      expect(info.mergeTarget?.tip).toBe(tip);
      expect(info.cornerState).toEqual({ state: 'waiting', reason: 'review' });

      await expect(Reflect.get(body, 'pollDirectRemoteApprovals').call(body)).resolves.toBe(0);
      expect(promptAgent).toHaveBeenCalledTimes(1);
      expect(
        published.filter((event) =>
          event.tags?.some((tag) => tag[0] === 't' && tag[1] === 'landing-blocked'),
        ),
      ).toHaveLength(1);

      approvalId = 'approval-retry';
      await expect(Reflect.get(body, 'pollDirectRemoteApprovals').call(body)).resolves.toBe(0);
      expect(promptAgent).toHaveBeenCalledTimes(2);
      expect(
        published.filter((event) =>
          event.tags?.some((tag) => tag[0] === 't' && tag[1] === 'landing-blocked'),
        ),
      ).toHaveLength(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('spends exactly one Codex sync turn when main moves again during one button press', async () => {
    const agent = newIdentity('local-land-moving-target-agent');
    const reviewer = newIdentity('local-land-moving-target-reviewer');
    const { root, repoPath, cornerPath, tip } = localOnlyRepoWithCorner();
    const published: NostrEvent[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const queryResponse = relayQueryResponse(published, input, init);
        if (queryResponse) return queryResponse;
        published.push(JSON.parse(String(init?.body)) as NostrEvent);
        return new Response(JSON.stringify({ accepted: true }), { status: 200 });
      }),
    );
    try {
      const body = newBody(agent, join(root, 'state.json'));
      const info = localCornerInfo(agent, repoPath, cornerPath, tip);
      body.registerSubchannel(info as never);
      Reflect.set(body, 'findHumanMergeApproval', async (target: typeof info) => {
        target.humanMergeApproval = {
          id: 'approval-moving-target',
          reviewer: reviewer.publicKey,
          tip,
        };
        return target.humanMergeApproval;
      });
      const land = vi.spyOn(body as never, 'landInLocalCheckout' as never).mockResolvedValue({
        kind: 'failed',
        reason: 'main has moved on since this change was approved',
      } as never);
      const realign = vi
        .spyOn(body as never, 'syncMovedTargetForLanding' as never)
        .mockImplementation(async () => {
          info.mergeTarget = {
            ...info.mergeTarget!,
            tip: '2'.repeat(40),
          };
          return { kind: 'ready', targetTip: '2'.repeat(40) } as never;
        });

      await expect(Reflect.get(body, 'pollDirectRemoteApprovals').call(body)).resolves.toBe(0);

      expect(realign).toHaveBeenCalledTimes(1);
      expect(land).toHaveBeenCalledTimes(2);
      const blocked = published.filter((event) =>
        event.tags?.some((tag) => tag[0] === 't' && tag[1] === 'landing-blocked'),
      );
      expect(blocked).toHaveLength(1);
      expect(blocked[0]!.content).toMatch(/^Merge blocked: [^\n]+$/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('never forwards the signed merge approval into the agent session', async () => {
    const agent = newIdentity('local-land-forward');
    const reviewer = newIdentity('local-land-forward-reviewer');
    const { root, repoPath, cornerPath, tip } = localOnlyRepoWithCorner();
    const steered: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ accepted: true }), { status: 200 })),
    );
    try {
      const body = newBody(agent, join(root, 'state.json'));
      stubEmptyAgentHistory(body);
      const info = {
        ...localCornerInfo(agent, repoPath, cornerPath, tip),
        session: {
          channelId: 'corner-local-land',
          parentChannelId: 'room-local',
          sessionId: 'session',
          client: {
            activeRunId: () => 'run-1',
            sessionSteer: async (_sessionId: string, prompt: string) => {
              steered.push(prompt);
            },
            sessionCancel: () => undefined,
          },
        } as never,
      };
      body.registerSubchannel(info as never);

      const approval = signEvent(
        {
          pubkey: reviewer.publicKey,
          created_at: Math.floor(Date.now() / 1000),
          kind: KIND_STREAM_MESSAGE,
          tags: [
            ['h', 'corner-local-land'],
            ['t', 'buzz-merge-approval'],
            ['repo', 'local/local-key'],
            ['branch', 'refs/heads/master'],
            ['tip', tip],
          ],
          content: `APPROVE merge of local/local-key refs/heads/master -> ${tip}`,
        },
        reviewer.secretKey,
      );
      const chatter = signEvent(
        {
          pubkey: reviewer.publicKey,
          created_at: Math.floor(Date.now() / 1000) + 1,
          kind: KIND_STREAM_MESSAGE,
          tags: [['h', 'corner-local-land']],
          content: 'also please tidy the imports',
        },
        reviewer.secretKey,
      );
      Reflect.set(body, 'agentRelay', {
        queryEvents: vi.fn(async () => [approval, chatter]),
      });

      await body.pollMembers('corner-local-land');

      // The ordinary message still reaches the agent; the grant never does.
      expect(steered.some((prompt) => prompt.includes('tidy the imports'))).toBe(true);
      expect(steered.some((prompt) => prompt.includes('APPROVE merge of'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('graceful relay-failure confirmation', () => {
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

  function cornerSession(subchannelId: string) {
    const client = new AcpClient({ agentBinary: '/nonexistent', agentEnv: {} });
    return {
      channelId: subchannelId,
      sessionId: 'session',
      client,
      mode: 'edit' as const,
      parentChannelId: 'room',
      archived: false,
    };
  }

  it('retries cleanup after relay archival, instead of leaving the corner worktree permanently stuck', async () => {
    const agent = newIdentity('archive-retry-agent');
    const body = newBody(agent);
    body.registerSubchannel({
      subchannelId: 'corner-incomplete-close',
      worktreePath: '/tmp/nonexistent-incomplete-close',
      featureBranch: 'feature/incomplete-close',
      role: agent,
      session: cornerSession('corner-incomplete-close'),
      lastPolledAt: 0,
      archived: true,
      archiveCompleted: true,
    });
    let archiveCalls = 0;
    body.archiveSubchannel = async () => {
      archiveCalls++;
    };

    const count = await body.pollMembers('corner-incomplete-close');

    expect(archiveCalls).toBe(1);
    expect(count).toBe(0);
  });

  it('keeps a #t=buzz-corner-close event pending (not delivered) when archiveSubchannel fails, so it is retried rather than permanently dropped', async () => {
    const agent = newIdentity('close-fail-agent');
    const human = newIdentity('close-fail-human');
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'buzzy-corner-close-fail-'));
    try {
      const body = newBody(agent, workspaceRoot);
      body.registerSubchannel({
        subchannelId: 'corner-close-fails',
        worktreePath: '/tmp/nonexistent-close-fails',
        featureBranch: 'feature/close-fails',
        role: agent,
        session: cornerSession('corner-close-fails'),
        lastPolledAt: 0,
        archived: false,
      });
      const closeEvent = signEvent(
        {
          pubkey: human.publicKey,
          created_at: Math.floor(Date.now() / 1000),
          kind: 9,
          tags: [
            ['h', 'corner-close-fails'],
            ['t', CORNER_CLOSE_TAG],
          ],
          content: 'Close this corner.',
        },
        human.secretKey,
      );
      (Reflect.get(body, 'agentRelay') as { queryEvents: unknown }).queryEvents = vi
        .fn()
        .mockResolvedValue([closeEvent]);
      body.archiveSubchannel = async () => {
        throw new Error('relay unreachable');
      };
      const durableState = Reflect.get(body, 'durableState') as {
        failed: (channelId: string, eventId: string, error: unknown) => Promise<number>;
        delivered: (channelId: string, eventId: string) => Promise<void>;
      };
      const failedSpy = vi.spyOn(durableState, 'failed');
      const deliveredSpy = vi.spyOn(durableState, 'delivered');

      await body.pollMembers('corner-close-fails');

      expect(failedSpy).toHaveBeenCalledWith(
        'corner-close-fails',
        closeEvent.id,
        expect.any(Error),
      );
      expect(deliveredSpy).not.toHaveBeenCalledWith('corner-close-fails', closeEvent.id);
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('archives the corner when the human TYPES "Close this corner" as an ordinary chat message', async () => {
    const agent = newIdentity('close-typed-agent');
    const human = newIdentity('close-typed-human');
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'buzzy-corner-typed-close-'));
    try {
      const body = newBody(agent, workspaceRoot);
      body.registerSubchannel({
        subchannelId: 'corner-typed-close',
        worktreePath: '/tmp/nonexistent-typed-close',
        featureBranch: 'feature/typed-close',
        role: agent,
        session: cornerSession('corner-typed-close'),
        lastPolledAt: 0,
        archived: false,
      });
      // No `#t=buzz-corner-close` tag — this is the owner's actual action:
      // plain prose typed into the corner composer.
      const typedClose = signEvent(
        {
          pubkey: human.publicKey,
          created_at: Math.floor(Date.now() / 1000),
          kind: 9,
          tags: [['h', 'corner-typed-close']],
          content: 'Close this corner.',
        },
        human.secretKey,
      );
      (Reflect.get(body, 'agentRelay') as { queryEvents: unknown }).queryEvents = vi
        .fn()
        .mockResolvedValue([typedClose]);
      let archiveCalls = 0;
      body.archiveSubchannel = async () => {
        archiveCalls++;
      };

      await body.pollMembers('corner-typed-close');

      expect(archiveCalls).toBe(1);
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('does not archive on a conversational mention of closing — that stays a real agent turn', async () => {
    const agent = newIdentity('close-chat-agent');
    const human = newIdentity('close-chat-human');
    const steered: string[] = [];
    const session = cornerSession('corner-close-discussed');
    (
      session.client as unknown as {
        activeRunId: () => string | undefined;
        sessionSteer: (id: string, prompt: string) => Promise<void>;
      }
    ).activeRunId = () => 'run-1';
    (
      session.client as unknown as {
        sessionSteer: (id: string, prompt: string) => Promise<void>;
      }
    ).sessionSteer = async (_id: string, prompt: string) => {
      steered.push(prompt);
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ accepted: true }), { status: 200 })),
    );
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'buzzy-corner-close-discussed-'));
    try {
      const body = newBody(agent, workspaceRoot);
      stubEmptyAgentHistory(body);
      body.registerSubchannel({
        subchannelId: 'corner-close-discussed',
        worktreePath: '/tmp/nonexistent-close-discussed',
        featureBranch: 'feature/close-discussed',
        role: agent,
        session,
        lastPolledAt: 0,
        archived: false,
      });
      const discussed = signEvent(
        {
          pubkey: human.publicKey,
          created_at: Math.floor(Date.now() / 1000),
          kind: 9,
          tags: [['h', 'corner-close-discussed']],
          content: 'Should we close this corner after the review?',
        },
        human.secretKey,
      );
      (Reflect.get(body, 'agentRelay') as { queryEvents: unknown }).queryEvents = vi
        .fn()
        .mockResolvedValue([discussed]);
      let archiveCalls = 0;
      body.archiveSubchannel = async () => {
        archiveCalls++;
      };

      await body.pollMembers('corner-close-discussed');

      expect(archiveCalls).toBe(0);
      expect(steered.some((prompt) => prompt.includes('close this corner'))).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('publishes a DurableMergeGate refusal instead of only logging it, so the corner is not silently stuck on "sent" forever', async () => {
    const agent = newIdentity('mergegate-agent');
    const body = new Body(
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
    const published: NostrEvent[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        published.push(JSON.parse(String(init?.body)) as NostrEvent);
        return new Response(JSON.stringify({ accepted: true }), { status: 200 });
      }),
    );
    (Reflect.get(body, 'agentRelay') as { queryEvents: unknown }).queryEvents = vi
      .fn()
      .mockResolvedValue([]);

    const mergeTarget = {
      repo: 'ownerhex/project',
      branch: 'refs/heads/main',
      tip: 'a'.repeat(40),
    };
    body.registerSubchannel({
      subchannelId: 'corner-mergegate',
      worktreePath: '/tmp/nonexistent-mergegate',
      featureBranch: 'feature/mergegate',
      role: agent,
      session: {
        channelId: 'corner-mergegate',
        sessionId: 'session',
        client: new AcpClient({ agentBinary: '/nonexistent', agentEnv: {} }),
        mode: 'edit' as const,
        parentChannelId: 'room',
        archived: false,
      },
      lastPolledAt: 0,
      archived: false,
      mergeTarget,
    });
    // This regression exercises merge-gate failure narration, not relay
    // existence. The maintenance driver now proves existence first on every
    // tick, so keep that independent prerequisite successful here.
    vi.spyOn(body as never, 'reconcileCornerExistence' as never).mockResolvedValue(true as never);

    const gitRejectionDump = [
      'ff merge failed:',
      '! [rejected]        aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa -> main (fetch first)',
      "error: failed to push some refs to 'https://relay.example/git/ownerhex/project'",
      'hint: Updates were rejected because the remote contains work that you do',
      "hint: not have locally. See the 'Note about fast-forwards' in 'git push --help'.",
    ].join('\n');
    const fakeMergeGate = {
      poll: vi.fn().mockResolvedValue([
        {
          candidate: {
            subchannelId: 'corner-mergegate',
            featureBranch: 'feature/mergegate',
            agentPubkey: agent.publicKey,
          },
          approvalId: 'approval-1',
          reviewer: 'reviewer-pubkey',
          outcome: {
            merged: false,
            terminal: false,
            reason: gitRejectionDump,
          },
        },
      ]),
    };

    await Reflect.get(body, 'pollRoomMaintenance').call(body, 'room', fakeMergeGate);

    const cornerFailure = published.find(
      (event) =>
        event.tags.some((tag) => tag[0] === 'h' && tag[1] === 'corner-mergegate') &&
        event.tags.some((tag) => tag[0] === 't' && tag[1] === 'landing-blocked'),
    );
    expect(cornerFailure).toBeDefined();
    // The raw git rejection dump (the plumbing a human should never see) must
    // never reach the corner transcript — only a plain human summary does.
    expect(cornerFailure!.content).not.toMatch(/git|hint:|\[rejected\]|fetch first/i);
    expect(cornerFailure!.content).toMatch(/^Merge blocked: [^\n]+$/);
    expect(cornerFailure!.tags).toContainEqual(['repo', mergeTarget.repo]);
    expect(cornerFailure!.tags).toContainEqual(['branch', mergeTarget.branch]);
    expect(cornerFailure!.tags).toContainEqual(['tip', mergeTarget.tip]);

    expect(cornerFailure!.tags).toContainEqual(['status', 'needs-attention']);
    expect(cornerFailure!.tags.some((tag) => tag[0] === 'retry')).toBe(false);
  });
});

describe('user-facing failure text stays free of git/tool plumbing', () => {
  it('safePermissionFailure turns a raw git rejection dump into a plain summary', () => {
    const agent = newIdentity('plumbing-agent');
    const body = new Body(
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
    const gitRejectionDump = [
      'git worktree add failed:',
      '! [rejected]        aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa -> main (fetch first)',
      "error: failed to push some refs to 'https://relay.example/git/ownerhex/project'",
      'hint: Updates were rejected because the remote contains work that you do',
      "hint: not have locally. See the 'Note about fast-forwards' in 'git push --help'.",
    ].join('\n');

    const detail = Reflect.get(body, 'safePermissionFailure').call(
      body,
      new Error(gitRejectionDump),
    ) as string;

    expect(detail).not.toMatch(/git|hint:|\[rejected\]|fetch first/i);
    expect(detail).toContain('The target branch has moved on since this change was prepared');
  });

  it('safePermissionFailure still redacts credentials/URLs for non-git-plumbing errors', () => {
    const agent = newIdentity('plumbing-agent-2');
    const body = new Body(
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

    const detail = Reflect.get(body, 'safePermissionFailure').call(
      body,
      new Error('unable to reach configured endpoint user:secret@relay.example for owner/repo'),
    ) as string;

    expect(detail).not.toContain('secret');
    expect(detail).toContain('[credentials]@');
  });
});

describe('per-agent access policy', () => {
  const owner = newIdentity('owner');
  const stranger = newIdentity('stranger');

  function baseConfig(access: Partial<BodyConfig>): BodyConfig {
    return {
      agentBinary: '/nonexistent',
      mcpBinary: '/nonexistent',
      agentEnv: {},
      workspaceRoot: `/tmp/buzzy-access-policy-unit-${Math.random().toString(36).slice(2)}`,
      relayBaseUrl: 'http://relay.test',
      relayHost: 'relay.test',
      relayScheme: 'http',
      relayWsUrl: 'ws://relay.test',
      autoApprovePermissions: true,
      ...access,
    };
  }

  function addressed(author: ReturnType<typeof newIdentity>, agentPubkey: string, id: string) {
    return signEvent(
      {
        pubkey: author.publicKey,
        created_at: Number(id) || 1,
        kind: 9,
        tags: [
          ['h', 'parent-channel'],
          ['p', agentPubkey],
        ],
        content: `message ${id}`,
      },
      author.secretKey,
    );
  }

  function withCapturedPublishes(): NostrEvent[] {
    const published: NostrEvent[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        try {
          published.push(JSON.parse(String(init?.body)) as NostrEvent);
        } catch {
          /* non-JSON bodies are irrelevant to the assertions */
        }
        return new Response(JSON.stringify({ accepted: true }), { status: 200 });
      }),
    );
    return published;
  }

  function refusals(published: NostrEvent[]): NostrEvent[] {
    return published.filter((event) => event?.content?.includes('King of the Andals'));
  }

  function drive(body: Body) {
    return (
      Reflect.get(body, 'processChannelRequestEvents') as (...a: unknown[]) => Promise<number>
    ).bind(body);
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('creator: answers the owner and refuses everyone else with the auto-response', async () => {
    const body = new Body(
      baseConfig({ accessPolicy: 'creator', accessOwnerPubkey: owner.publicKey }),
    );
    Reflect.set(body, 'agentRelay', { queryEvents: vi.fn(async () => []) });
    const reply = vi
      .spyOn(body as never, 'replyInRoom' as never)
      .mockResolvedValue({ openedCorner: true, producedReply: true } as never);
    const published = withCapturedPublishes();
    const process = drive(body);
    const participants = [owner.publicKey, stranger.publicKey, body.agent.publicKey];

    // A non-permitted stranger never drives the backend; it gets one refusal.
    await process(
      'parent-channel',
      { repo: 'repo' },
      'repository',
      [addressed(stranger, body.agent.publicKey, '1')],
      participants,
    );
    expect(reply).not.toHaveBeenCalled();
    expect(refusals(published)).toHaveLength(1);
    expect(refusals(published)[0]!.content).toContain('wildling');

    // The owner is permitted and reaches the ordinary reply path, no refusal.
    await process(
      'parent-channel',
      { repo: 'repo' },
      'repository',
      [addressed(owner, body.agent.publicKey, '2')],
      participants,
    );
    expect(reply).toHaveBeenCalledTimes(1);
    expect(refusals(published)).toHaveLength(1);
  });

  it('everyone: answers any sender, no refusal', async () => {
    const body = new Body(
      baseConfig({ accessPolicy: 'everyone', accessOwnerPubkey: owner.publicKey }),
    );
    Reflect.set(body, 'agentRelay', { queryEvents: vi.fn(async () => []) });
    const reply = vi
      .spyOn(body as never, 'replyInRoom' as never)
      .mockResolvedValue({ openedCorner: true, producedReply: true } as never);
    const published = withCapturedPublishes();
    const process = drive(body);
    const participants = [owner.publicKey, stranger.publicKey, body.agent.publicKey];

    await process(
      'parent-channel',
      { repo: 'repo' },
      'repository',
      [addressed(stranger, body.agent.publicKey, '1')],
      participants,
    );
    expect(reply).toHaveBeenCalledTimes(1);
    expect(refusals(published)).toHaveLength(0);
  });

  it('defaults to everyone when no policy is configured (unchanged behaviour)', async () => {
    const body = new Body(baseConfig({}));
    Reflect.set(body, 'agentRelay', { queryEvents: vi.fn(async () => []) });
    const reply = vi
      .spyOn(body as never, 'replyInRoom' as never)
      .mockResolvedValue({ openedCorner: true, producedReply: true } as never);
    withCapturedPublishes();
    const process = drive(body);
    const participants = [stranger.publicKey, body.agent.publicKey];

    await process(
      'parent-channel',
      { repo: 'repo' },
      'repository',
      [addressed(stranger, body.agent.publicKey, '1')],
      participants,
    );
    expect(reply).toHaveBeenCalledTimes(1);
  });

  it('rate-limits the refusal to one per sender, then goes quiet', async () => {
    const body = new Body(
      baseConfig({ accessPolicy: 'creator', accessOwnerPubkey: owner.publicKey }),
    );
    Reflect.set(body, 'agentRelay', { queryEvents: vi.fn(async () => []) });
    vi.spyOn(body as never, 'replyInRoom' as never).mockResolvedValue({
      openedCorner: true,
      producedReply: true,
    } as never);
    const published = withCapturedPublishes();
    const process = drive(body);
    const participants = [owner.publicKey, stranger.publicKey, body.agent.publicKey];

    // Two distinct addressed messages from the same non-permitted sender yield
    // exactly one refusal — the second is suppressed within the window.
    await process(
      'parent-channel',
      { repo: 'repo' },
      'repository',
      [
        addressed(stranger, body.agent.publicKey, '1'),
        addressed(stranger, body.agent.publicKey, '2'),
      ],
      participants,
    );
    expect(refusals(published)).toHaveLength(1);
  });
});

describe('per-agent model/effort persistence', () => {
  const communityId = '22222222-2222-4222-8222-222222222222';
  const owner = newIdentity('model-config-owner');

  function jsonResponse(body: unknown): Response {
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }

  function filterFrom(init?: RequestInit): Record<string, unknown> {
    return (JSON.parse(String(init?.body)) as Record<string, unknown>[])[0] ?? {};
  }

  function signed(
    identity: ReturnType<typeof newIdentity>,
    kind: number,
    tags: string[][],
    content = '',
  ): NostrEvent {
    return signEvent(
      { pubkey: identity.publicKey, created_at: 1_700_000_000, kind, tags, content },
      identity.secretKey,
    );
  }

  function agentRecord(body: Body): NostrEvent {
    return signEvent(
      {
        pubkey: body.agent.publicKey,
        created_at: 1_700_000_000,
        kind: KIND_STREAM_MESSAGE,
        tags: [
          ['h', communityId],
          ['d', 'agent-id'],
          ['p', body.agent.publicKey],
          ['t', TAG_AGENT],
          [TAG_COMMUNITY, communityId],
        ],
        content: JSON.stringify({ displayName: 'Agent' }),
      },
      body.agent.secretKey,
    );
  }

  /** A minimal relay stub covering every read `applyModelConfigForSession` needs, plus publish capture. */
  function stubRelay(body: Body, published: NostrEvent[]): void {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        if (String(input).endsWith('/events')) {
          published.push(JSON.parse(String(init?.body)) as NostrEvent);
          return jsonResponse({ accepted: true });
        }
        const filter = filterFrom(init);
        const kind = (filter.kinds as number[])[0];
        if (kind === KIND_CREATE_GROUP) {
          return jsonResponse([
            signed(owner, KIND_CREATE_GROUP, [
              ['h', communityId],
              ['name', 'Builders'],
              [TAG_COMMUNITY, communityId],
            ]),
          ]);
        }
        if (kind === KIND_CHANNEL_MEMBERS) {
          return jsonResponse([
            signed(owner, KIND_CHANNEL_MEMBERS, [
              ['d', communityId],
              ['p', owner.publicKey],
              ['p', body.agent.publicKey],
            ]),
          ]);
        }
        if (kind === KIND_CHANNEL_ADMINS) {
          return jsonResponse([signed(owner, KIND_CHANNEL_ADMINS, [['d', communityId]])]);
        }
        if (kind === KIND_STREAM_MESSAGE) {
          const markers = filter['#t'] as string[] | undefined;
          if (markers?.includes('buzz-agent-model-unavailable')) {
            return jsonResponse(
              published.filter((event) =>
                event.tags.some((tag) => tag[0] === 't' && markers.includes(tag[1] ?? '')),
              ),
            );
          }
          const authors = filter.authors as string[] | undefined;
          if (!authors) return jsonResponse([agentRecord(body)]);
          return jsonResponse(authors.includes(body.agent.publicKey) ? [agentRecord(body)] : []);
        }
        if (kind === KIND_AGENT_MODEL_CONFIG || kind === KIND_AGENT_MODEL_CATALOG) {
          return jsonResponse(published.filter((event) => event.kind === kind));
        }
        return jsonResponse([]);
      }),
    );
  }

  /** Raw `session/new` shape a claude-like adapter advertises (report §3.1) — includes a `mode` axis. */
  function rawSessionNew(): unknown {
    return {
      sessionId: 'sess-1',
      configOptions: [
        {
          id: 'model',
          category: 'model',
          currentValue: 'default',
          options: [{ id: 'default' }, { id: 'sonnet' }, { id: 'opus' }],
        },
        {
          id: 'effort',
          category: 'effort',
          currentValue: 'default',
          options: [{ id: 'default' }, { id: 'low' }, { id: 'high' }],
        },
        {
          id: 'mode',
          category: 'mode',
          currentValue: 'default',
          options: [{ id: 'default' }, { id: 'bypassPermissions' }],
        },
      ],
    };
  }

  function config(): BodyConfig {
    return {
      agentBinary: '/nonexistent',
      mcpBinary: '/nonexistent',
      agentEnv: {},
      workspaceRoot: `/tmp/buzzy-model-config-unit-${Math.random().toString(36).slice(2)}`,
      relayBaseUrl: 'http://relay.test',
      relayHost: 'relay.test',
      relayScheme: 'http',
      relayWsUrl: 'ws://relay.test',
      autoApprovePermissions: true,
    };
  }

  it('applies a persisted selection to a freshly (re)activated session, never touching mode', async () => {
    const agentIdentity = newIdentity('model-config-agent');
    const body = new Body(config(), undefined, agentIdentity);
    const published: NostrEvent[] = [];
    stubRelay(body, published);

    // A human chose sonnet/high before this session (re)activation — simulates
    // a selection made while the session was suspended, surviving reopen.
    await setAgentModelConfig(
      {
        http: { baseUrl: 'http://relay.test', host: 'relay.test', identity: owner },
        identity: owner,
      },
      communityId,
      body.agent.publicKey,
      { model: 'sonnet', effort: 'high' },
    );

    const setConfigOption = vi.fn().mockResolvedValue({});
    const session = { channelId: 'room-1' } as never;
    await Reflect.get(body, 'applyModelConfigForSession').call(
      body,
      { setConfigOption },
      'sess-1',
      communityId,
      rawSessionNew(),
      session,
    );

    expect(setConfigOption).toHaveBeenCalledTimes(2);
    expect(setConfigOption).toHaveBeenCalledWith('sess-1', 'model', 'sonnet');
    expect(setConfigOption).toHaveBeenCalledWith('sess-1', 'effort', 'high');

    // The published catalog is allow-list filtered — no `mode` axis reaches the relay.
    // (KIND_AGENT_MODEL_CATALOG and KIND_AGENT_MODEL_CONFIG share the literal
    // 30078 NIP-33 kind; the `t` tag is what actually distinguishes them.)
    const catalogEvents = published.filter(
      (event) => event.kind === KIND_AGENT_MODEL_CATALOG && event.pubkey === body.agent.publicKey,
    );
    expect(catalogEvents).toHaveLength(1);
    const catalogContent = JSON.parse(catalogEvents[0]!.content) as {
      options: Array<{ category: string }>;
    };
    expect(catalogContent.options.map((option) => option.category)).toEqual(['model', 'effort']);
    expect(
      (session as { modelConfigOptions?: Array<{ category: string }> }).modelConfigOptions?.map(
        (option) => option.category,
      ),
    ).toEqual(['model', 'effort']);
  });

  it('never calls setConfigOption for mode, even with no persisted selection at all', async () => {
    const agentIdentity = newIdentity('model-config-agent-2');
    const body = new Body(config(), undefined, agentIdentity);
    const published: NostrEvent[] = [];
    stubRelay(body, published);

    const setConfigOption = vi.fn().mockResolvedValue({});
    const session = { channelId: 'room-2' } as never;
    await Reflect.get(body, 'applyModelConfigForSession').call(
      body,
      { setConfigOption },
      'sess-2',
      communityId,
      rawSessionNew(),
      session,
    );

    expect(setConfigOption).not.toHaveBeenCalled();
  });

  it('falls back to the pair-time --model/--effort default when no human has picked one yet', async () => {
    const agentIdentity = newIdentity('model-config-agent-3');
    const cfg = config();
    cfg.modelSelection = { model: 'sonnet', effort: 'low' };
    const body = new Body(cfg, undefined, agentIdentity);
    const published: NostrEvent[] = [];
    stubRelay(body, published);

    const setConfigOption = vi.fn().mockResolvedValue({});
    const session = { channelId: 'room-3' } as never;
    await Reflect.get(body, 'applyModelConfigForSession').call(
      body,
      { setConfigOption },
      'sess-3',
      communityId,
      rawSessionNew(),
      session,
    );

    expect(setConfigOption).toHaveBeenCalledTimes(2);
    expect(setConfigOption).toHaveBeenCalledWith('sess-3', 'model', 'sonnet');
    expect(setConfigOption).toHaveBeenCalledWith('sess-3', 'effort', 'low');
  });

  it('refuses an in-app selection that disappeared from the live session catalog', async () => {
    const agentIdentity = newIdentity('model-config-agent-retired');
    const body = new Body(config(), undefined, agentIdentity);
    const published: NostrEvent[] = [];
    stubRelay(body, published);
    await setAgentModelConfig(
      {
        http: { baseUrl: 'http://relay.test', host: 'relay.test', identity: owner },
        identity: owner,
      },
      communityId,
      body.agent.publicKey,
      { model: 'stealth/ox-alpha', effort: 'high' },
    );

    const setConfigOption = vi.fn().mockResolvedValue({});
    await expect(
      Reflect.get(body, 'applyModelConfigForSession').call(
        body,
        { setConfigOption },
        'sess-retired',
        communityId,
        rawSessionNew(),
        { channelId: 'room-retired' } as never,
      ),
    ).rejects.toThrow('model "stealth/ox-alpha" is unavailable');
    expect(setConfigOption).not.toHaveBeenCalled();
  });

  it('keeps ACP work blocked and publishes the typed Room state after startup revalidation fails', async () => {
    const agentIdentity = newIdentity('model-config-agent-unavailable');
    const cfg = config();
    cfg.modelSelection = { model: 'stealth/ox-alpha', effort: 'high' };
    cfg.modelUnavailable = {
      kind: 'model-unavailable',
      selection: { ...cfg.modelSelection },
      unavailable: { label: 'model', value: 'stealth/ox-alpha' },
      detail: 'model "stealth/ox-alpha" is unavailable. Use z-ai/glm-5.3-flash instead.',
      recovery:
        'Open this agent’s settings, choose a value from the live model catalog, then restart the agent.',
    };
    const body = new Body(cfg, undefined, agentIdentity);
    const published: NostrEvent[] = [];
    stubRelay(body, published);
    const ordinaryWork = vi.fn(async () => undefined);

    await expect(
      Reflect.get(body, 'runOnSession').call(
        body,
        { channelId: 'room-unavailable', mode: 'readonly' },
        ordinaryWork,
      ),
    ).rejects.toThrow('Model unavailable · stealth/ox-alpha');
    expect(ordinaryWork).not.toHaveBeenCalled();

    await Reflect.get(body, 'publishModelUnavailableState').call(body, 'room-unavailable');
    const event = published.find((candidate) =>
      candidate.tags.some((tag) => tag[0] === 't' && tag[1] === 'buzz-agent-model-unavailable'),
    );
    expect(event?.content).toContain('Model unavailable · stealth/ox-alpha');
    expect(event?.content).toContain('z-ai/glm-5.3-flash');
    expect(event?.tags).toContainEqual(['status', 'model-unavailable']);
  });

  it('recovers only the Room whose valid human override supersedes a stale runtime default', async () => {
    const agentIdentity = newIdentity('model-config-agent-recovered');
    const cfg = config();
    cfg.modelSelection = { model: 'stealth/ox-alpha', effort: 'high' };
    cfg.modelUnavailable = {
      kind: 'model-unavailable',
      selection: { ...cfg.modelSelection },
      unavailable: { label: 'model', value: 'stealth/ox-alpha' },
      detail: 'model "stealth/ox-alpha" is unavailable.',
      recovery:
        'Open this agent’s settings, choose a value from the live model catalog, then restart the agent.',
    };
    const body = new Body(cfg, undefined, agentIdentity);
    const published: NostrEvent[] = [];
    stubRelay(body, published);
    await setAgentModelConfig(
      {
        http: { baseUrl: 'http://relay.test', host: 'relay.test', identity: owner },
        identity: owner,
      },
      communityId,
      body.agent.publicKey,
      { model: 'sonnet', effort: 'low' },
    );
    const validate = vi
      .spyOn(body as never, 'validateLiveModelSelection' as never)
      .mockResolvedValue(undefined as never);

    await body.syncModelSelectionToRelay(communityId);

    expect(validate).toHaveBeenCalledWith({ model: 'sonnet', effort: 'low' });
    expect(cfg.modelUnavailable).toBeUndefined();
    expect(cfg.modelSelection).toEqual({ model: 'sonnet', effort: 'low' });
  });

  it('blocks a retired human override even when the runtime default still validates', async () => {
    const agentIdentity = newIdentity('model-config-agent-retired-override');
    const cfg = config();
    cfg.modelSelection = { model: 'sonnet', effort: 'high' };
    const body = new Body(cfg, undefined, agentIdentity);
    const published: NostrEvent[] = [];
    stubRelay(body, published);
    await setAgentModelConfig(
      {
        http: { baseUrl: 'http://relay.test', host: 'relay.test', identity: owner },
        identity: owner,
      },
      communityId,
      body.agent.publicKey,
      { model: 'stealth/ox-alpha', effort: 'low' },
    );
    const validate = vi
      .spyOn(body as never, 'validateLiveModelSelection' as never)
      .mockRejectedValue(
        new ModelSelectionUnavailableError({
          label: 'model',
          value: 'stealth/ox-alpha',
          reason: 'not-advertised',
          guidance: 'Use z-ai/glm-5.3-flash instead.',
        }),
      );

    await body.syncModelSelectionToRelay(communityId);

    expect(validate).toHaveBeenCalledWith({ model: 'stealth/ox-alpha', effort: 'low' });
    expect(cfg.modelSelection).toEqual({ model: 'sonnet', effort: 'high' });
    expect(cfg.modelUnavailable).toMatchObject({
      kind: 'model-unavailable',
      unavailable: { label: 'model', value: 'stealth/ox-alpha' },
      detail: expect.stringContaining('z-ai/glm-5.3-flash'),
    });
  });

  it('blocks a retired human override when pairing stored no runtime default', async () => {
    const agentIdentity = newIdentity('model-config-agent-retired-only-selection');
    const cfg = config();
    const body = new Body(cfg, undefined, agentIdentity);
    const published: NostrEvent[] = [];
    stubRelay(body, published);
    await setAgentModelConfig(
      {
        http: { baseUrl: 'http://relay.test', host: 'relay.test', identity: owner },
        identity: owner,
      },
      communityId,
      body.agent.publicKey,
      { model: 'stealth/ox-alpha' },
    );
    const validate = vi
      .spyOn(body as never, 'validateLiveModelSelection' as never)
      .mockRejectedValue(
        new ModelSelectionUnavailableError({
          label: 'model',
          value: 'stealth/ox-alpha',
          reason: 'not-advertised',
        }),
      );

    await body.syncModelSelectionToRelay(communityId);

    expect(validate).toHaveBeenCalledWith({ model: 'stealth/ox-alpha' });
    expect(cfg.modelSelection).toBeUndefined();
    expect(cfg.modelUnavailable).toMatchObject({
      kind: 'model-unavailable',
      unavailable: { label: 'model', value: 'stealth/ox-alpha' },
    });
  });

  it('does not repeat the same startup state after a daemon restart', async () => {
    const agentIdentity = newIdentity('model-config-agent-standing-state');
    const unavailable = {
      kind: 'model-unavailable' as const,
      selection: { model: 'stealth/ox-alpha' },
      unavailable: { label: 'model' as const, value: 'stealth/ox-alpha' },
      detail: 'model "stealth/ox-alpha" is unavailable.',
      recovery:
        'Open this agent’s settings, choose a value from the live model catalog, then restart the agent.',
    };
    const firstConfig = config();
    firstConfig.modelUnavailable = unavailable;
    const first = new Body(firstConfig, undefined, agentIdentity);
    const published: NostrEvent[] = [];
    stubRelay(first, published);
    await Reflect.get(first, 'publishModelUnavailableState').call(first, 'room-standing');

    const restartedConfig = config();
    restartedConfig.modelUnavailable = unavailable;
    const restarted = new Body(restartedConfig, undefined, agentIdentity);
    await Reflect.get(restarted, 'publishModelUnavailableState').call(restarted, 'room-standing');

    expect(
      published.filter((event) =>
        event.tags.some((tag) => tag[0] === 't' && tag[1] === 'buzz-agent-model-unavailable'),
      ),
    ).toHaveLength(1);
  });

  it('publishes one typed resolution after restart validation recovers, then allows a later failure', async () => {
    const agentIdentity = newIdentity('model-config-agent-resolution-state');
    const unavailable = {
      kind: 'validation-unavailable' as const,
      selection: { model: 'gpt-5', effort: 'high' },
      unavailable: { label: 'selection' as const, value: 'gpt-5' },
      detail: 'The live harness catalog could not verify "gpt-5".',
      recovery:
        'Restore access to the selected harness and its live catalog, then restart the agent.',
    };
    const published: NostrEvent[] = [];

    const blockedConfig = config();
    blockedConfig.modelUnavailable = unavailable;
    const blocked = new Body(blockedConfig, undefined, agentIdentity);
    stubRelay(blocked, published);
    await Reflect.get(blocked, 'publishModelUnavailableState').call(blocked, 'room-resolution');

    const healthyConfig = config();
    healthyConfig.modelSelection = { ...unavailable.selection };
    const healthy = new Body(healthyConfig, undefined, agentIdentity);
    vi.spyOn(Reflect.get(healthy, 'agentRelay'), 'queryEvents').mockRejectedValueOnce(
      new Error('relay temporarily unavailable'),
    );
    await Reflect.get(healthy, 'publishModelUnavailableState').call(healthy, 'room-resolution');
    expect(
      published.filter((event) =>
        event.tags.some((tag) => tag[0] === 'status' && tag[1] === 'model-available'),
      ),
    ).toHaveLength(0);

    await Reflect.get(healthy, 'publishModelUnavailableState').call(healthy, 'room-resolution');
    const available = published.filter((event) =>
      event.tags.some((tag) => tag[0] === 'status' && tag[1] === 'model-available'),
    );
    expect(available).toHaveLength(1);
    expect(available[0]?.content).toBe('');
    expect(available[0]?.tags).toContainEqual(['t', 'buzz-agent-model-unavailable']);
    expect(available[0]?.tags).toContainEqual(['model', 'gpt-5']);
    expect(available[0]?.tags).toContainEqual(['effort', 'high']);

    const restartedHealthy = new Body(healthyConfig, undefined, agentIdentity);
    await Reflect.get(restartedHealthy, 'publishModelUnavailableState').call(
      restartedHealthy,
      'room-resolution',
    );
    expect(
      published.filter((event) =>
        event.tags.some((tag) => tag[0] === 'status' && tag[1] === 'model-available'),
      ),
    ).toHaveLength(1);

    const blockedAgainConfig = config();
    blockedAgainConfig.modelUnavailable = unavailable;
    const blockedAgain = new Body(blockedAgainConfig, undefined, agentIdentity);
    await Reflect.get(blockedAgain, 'publishModelUnavailableState').call(
      blockedAgain,
      'room-resolution',
    );
    expect(
      published.filter((event) =>
        event.tags.some((tag) => tag[0] === 'status' && tag[1] === 'validation-unavailable'),
      ),
    ).toHaveLength(2);
  });

  it('lets a human in-app selection (#223) override the pair-time default, never the reverse', async () => {
    const agentIdentity = newIdentity('model-config-agent-4');
    const cfg = config();
    cfg.modelSelection = { model: 'opus', effort: 'high' };
    const body = new Body(cfg, undefined, agentIdentity);
    const published: NostrEvent[] = [];
    stubRelay(body, published);

    await setAgentModelConfig(
      {
        http: { baseUrl: 'http://relay.test', host: 'relay.test', identity: owner },
        identity: owner,
      },
      communityId,
      body.agent.publicKey,
      { model: 'sonnet', effort: 'low' },
    );

    const setConfigOption = vi.fn().mockResolvedValue({});
    const session = { channelId: 'room-4' } as never;
    await Reflect.get(body, 'applyModelConfigForSession').call(
      body,
      { setConfigOption },
      'sess-4',
      communityId,
      rawSessionNew(),
      session,
    );

    expect(setConfigOption).toHaveBeenCalledTimes(2);
    expect(setConfigOption).toHaveBeenCalledWith('sess-4', 'model', 'sonnet');
    expect(setConfigOption).toHaveBeenCalledWith('sess-4', 'effort', 'low');
  });

  it('publishes the effective selection on the catalog so a CLI-configured agent is visible in the app', async () => {
    // THE reported break: `beeline pair --model/--effort` wrote only to the
    // local runtime record. The catalog's harness-reported currentValue is
    // the PRE-application default ('default'), so even after activation the
    // app showed what the agent was about to override, and before activation
    // it showed nothing at all.
    const agentIdentity = newIdentity('model-config-agent-5');
    const cfg = config();
    cfg.modelSelection = { model: 'sonnet', effort: 'low' };
    const body = new Body(cfg, undefined, agentIdentity);
    const published: NostrEvent[] = [];
    stubRelay(body, published);

    await Reflect.get(body, 'applyModelConfigForSession').call(
      body,
      { setConfigOption: vi.fn().mockResolvedValue({}) },
      'sess-5',
      communityId,
      rawSessionNew(),
      { channelId: 'room-5' } as never,
    );

    const catalogEvent = published.find((event) =>
      event.tags.some((tag) => tag[0] === 't' && tag[1] === TAG_AGENT_MODEL_CATALOG),
    );
    expect(catalogEvent).toBeDefined();
    const content = JSON.parse(catalogEvent!.content) as {
      options: Array<{ category: string; currentValue?: string }>;
      selection?: { model?: string; effort?: string };
    };
    // The harness advertised currentValue 'default' for both axes; the
    // published snapshot must name what the agent will actually run with.
    expect(content.options.find((option) => option.category === 'model')?.currentValue).toBe(
      'sonnet',
    );
    expect(content.options.find((option) => option.category === 'effort')?.currentValue).toBe(
      'low',
    );
    expect(content.selection).toEqual({ model: 'sonnet', effort: 'low' });
  });

  it('publishes the pair-time default to the relay at Room start, before any session activates', async () => {
    const agentIdentity = newIdentity('model-config-agent-6');
    const cfg = config();
    cfg.modelSelection = { model: 'gpt-5.1-codex', effort: 'xhigh' };
    const body = new Body(cfg, undefined, agentIdentity);
    const published: NostrEvent[] = [];
    stubRelay(body, published);

    // The live catalog probe cannot start '/nonexistent'; the sync must still
    // publish the selection itself rather than nothing.
    await expect(body.syncModelSelectionToRelay(communityId)).resolves.toBeUndefined();

    const catalogEvents = published.filter(
      (event) => event.kind === KIND_AGENT_MODEL_CATALOG && event.pubkey === body.agent.publicKey,
    );
    expect(catalogEvents).toHaveLength(1);
    const content = JSON.parse(catalogEvents[0]!.content) as {
      selection?: { model?: string; effort?: string };
    };
    expect(content.selection).toEqual({ model: 'gpt-5.1-codex', effort: 'xhigh' });

    // Idempotent per process: a second Room (or a watchdog recycle) in the
    // same Workspace must not republish the identical record.
    await body.syncModelSelectionToRelay(communityId);
    expect(published.filter((event) => event.kind === KIND_AGENT_MODEL_CATALOG)).toHaveLength(1);
  });

  it('publishes a catalog per served Workspace even when no pair-time default is configured', async () => {
    const agentIdentity = newIdentity('model-config-agent-7');
    const body = new Body(config(), undefined, agentIdentity);
    const published: NostrEvent[] = [];
    stubRelay(body, published);

    const anotherWorkspace = '77777777-7777-4777-8777-777777777777';
    await body.syncModelSelectionToRelay(communityId);
    await body.syncModelSelectionToRelay(anotherWorkspace);
    const catalogs = published.filter((event) => event.kind === KIND_AGENT_MODEL_CATALOG);
    expect(catalogs).toHaveLength(2);
    expect(catalogs.map((event) => event.tags.find((tag) => tag[0] === 'd')?.[1])).toEqual([
      `${communityId}:${body.agent.publicKey}`,
      `${anotherWorkspace}:${body.agent.publicKey}`,
    ]);
  });

  it('a human pick wins over the pair-time default in the startup sync too', async () => {
    const agentIdentity = newIdentity('model-config-agent-8');
    const cfg = config();
    cfg.modelSelection = { model: 'opus', effort: 'high' };
    const body = new Body(cfg, undefined, agentIdentity);
    const published: NostrEvent[] = [];
    stubRelay(body, published);

    await setAgentModelConfig(
      {
        http: { baseUrl: 'http://relay.test', host: 'relay.test', identity: owner },
        identity: owner,
      },
      communityId,
      body.agent.publicKey,
      { model: 'sonnet', effort: 'low' },
    );

    await body.syncModelSelectionToRelay(communityId);

    const catalogEvent = published.find(
      (event) => event.kind === KIND_AGENT_MODEL_CATALOG && event.pubkey === body.agent.publicKey,
    );
    expect(catalogEvent).toBeDefined();
    expect(catalogEvent!.tags).toContainEqual(['t', TAG_AGENT_MODEL_CATALOG]);
    const content = JSON.parse(catalogEvent!.content) as {
      options: Array<{ category: string; currentValue?: string }>;
      selection?: { model?: string; effort?: string };
    };
    expect(content.selection).toEqual({ model: 'sonnet', effort: 'low' });
  });
});
