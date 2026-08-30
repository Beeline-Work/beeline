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
describe('never-idle conclude watch', () => {
  const CORNER_ID = 'corner-conclude';
  const ROOM_ID = 'room-conclude';

  function newBody(agent: ReturnType<typeof newIdentity>) {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'buzzy-conclude-watch-'));
    const body = new Body(
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
    return { body, workspaceRoot };
  }

  /** Records every publish; `/query` answers with the given events. */
  function stubRelay(queryResults: NostrEvent[]): NostrEvent[] {
    const published: NostrEvent[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        if (String(_input).endsWith('/query')) {
          return new Response(JSON.stringify(queryResults), { status: 200 });
        }
        published.push(JSON.parse(String(init?.body)) as NostrEvent);
        return new Response(JSON.stringify({ accepted: true }), { status: 200 });
      }),
    );
    return published;
  }

  type ConcludeFixture = Parameters<Body['registerSubchannel']>[0];

  function registerCorner(
    body: Body,
    agent: ReturnType<typeof newIdentity>,
    overrides: Record<string, unknown> = {},
  ): ConcludeFixture {
    const info = {
      subchannelId: CORNER_ID,
      worktreePath: '/tmp/does-not-matter',
      featureBranch: 'feature/conclude',
      role: agent,
      session: {
        channelId: CORNER_ID,
        sessionId: 'session',
        logicalSessionId: `${agent.publicKey}:${CORNER_ID}`,
        parentChannelId: ROOM_ID,
        processState: 'live',
        client: { activeRunId: () => undefined },
      },
      lastPolledAt: 0,
      archived: false,
      ...overrides,
    } as unknown as ConcludeFixture;
    body.registerSubchannel(info);
    return info;
  }

  function quietJustNow(): Record<string, unknown> {
    return {
      conclude: {
        quietSince: Date.now() - CONCLUDE_NUDGE_SPACING_MS - 1,
        nudges: 0,
      },
    };
  }

  function spyConcludeTurn(
    body: Body,
    ready = false,
    { realPersistence = false }: { realPersistence?: boolean } = {},
  ) {
    if (!realPersistence) {
      // Keep fire-and-forget episode writes from racing the tmpdir cleanup.
      const durableState = Reflect.get(body, 'durableState') as {
        saveConcludeEpisode: (...args: unknown[]) => Promise<void>;
      };
      vi.spyOn(durableState, 'saveConcludeEpisode').mockResolvedValue(undefined);
    }
    const promptAgent = vi.spyOn(body as never, 'promptAgent' as never).mockResolvedValue({
      agentText: 'pure narration, nothing concluded',
      updates: [],
      toolCalls: [],
      stopReason: 'end_turn',
    } as never);
    const finishGate = vi
      .spyOn(body as never, 'finishCornerTurnAgainstMergeGate' as never)
      .mockResolvedValue(ready as never);
    return { promptAgent, finishGate };
  }

  function needsAttentionCards(published: NostrEvent[]): NostrEvent[] {
    return published.filter(
      (event) =>
        event.kind === 9 &&
        event.tags?.some((tag) => tag[0] === 'display-status' && tag[1] === 'needs-attention'),
    );
  }

  afterEach(() => vi.unstubAllGlobals());

  it('a quiet turn end gets exactly one bounded conclude steer', async () => {
    const agent = newIdentity('conclude-agent');
    const { body, workspaceRoot } = newBody(agent);
    try {
      stubRelay([]);
      const info = registerCorner(body, agent, quietJustNow());
      const { promptAgent } = spyConcludeTurn(body);

      await Reflect.get(body, 'pollConcludeWatch').call(body);

      expect(promptAgent).toHaveBeenCalledTimes(1);
      expect(String(promptAgent.mock.calls[0]![1])).toContain('Do exactly one of the following');
      // The nudge rides the same attribution discipline as any model turn.
      expect(promptAgent.mock.calls[0]![2]).toMatchObject({ cause: 'corner-conclude' });
      expect(info.conclude?.nudges).toBe(1);
      // The nudge turn itself ended quietly again (the spy never presents),
      // so a fresh quiet window opened — with the spent budget standing.
      expect(info.conclude?.quietSince).toBeDefined();

      // Inside the spacing window a second tick does not double-prompt.
      await Reflect.get(body, 'pollConcludeWatch').call(body);
      expect(promptAgent).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('an agent that presents work resolves the episode with no further nudges', async () => {
    const agent = newIdentity('conclude-review-agent');
    const { body, workspaceRoot } = newBody(agent);
    try {
      stubRelay([]);
      const tip = 'a'.repeat(40);
      const info = registerCorner(body, agent, {
        ...quietJustNow(),
        mergeTarget: { repo: 'repo', branch: 'refs/heads/main', tip },
      });
      const { promptAgent } = spyConcludeTurn(body);

      await Reflect.get(body, 'pollConcludeWatch').call(body);

      expect(promptAgent).not.toHaveBeenCalled();
      expect(info.conclude?.nudges).toBe(0);
      expect(info.conclude?.quietSince).toBeUndefined();
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('committed-but-unreviewed work stays the commit watch business, not a nudge', async () => {
    const agent = newIdentity('conclude-commits-agent');
    const { body, workspaceRoot } = newBody(agent);
    const directory = mkdtempSync(join(tmpdir(), 'buzzy-conclude-commits-'));
    const gitCommand = (args: string[]) => {
      const result = spawnSync('git', args, { cwd: directory, encoding: 'utf8' });
      if (result.status !== 0) throw new Error(result.stderr);
      return result.stdout.trim();
    };
    try {
      gitCommand(['init', '-b', 'main']);
      gitCommand(['config', 'user.name', 'Conclude Watch Test']);
      gitCommand(['config', 'user.email', 'conclude@test.invalid']);
      writeFileSync(join(directory, 'README.md'), '# Base\n');
      gitCommand(['add', '.']);
      gitCommand(['commit', '-m', 'base']);
      gitCommand(['checkout', '-b', 'feature/conclude']);
      writeFileSync(join(directory, 'README.md'), '# Work\n');
      gitCommand(['add', 'README.md']);
      gitCommand(['commit', '-m', 'committed work awaiting review']);
      stubRelay([]);
      registerCorner(body, agent, {
        ...quietJustNow(),
        worktreePath: directory,
        boundRepo: { repo: 'repo', targetBranch: 'refs/heads/main' },
      });
      const { promptAgent } = spyConcludeTurn(body);

      await Reflect.get(body, 'pollConcludeWatch').call(body);

      // The commit watch runs earlier in the same chain and owns this outcome.
      expect(promptAgent).not.toHaveBeenCalled();
    } finally {
      rmSync(directory, { recursive: true, force: true });
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it(`silence through the bound of ${MAX_CONCLUDE_NUDGES_PER_EPISODE} nudges parks exactly one stalled needs-attention card`, async () => {
    const agent = newIdentity('conclude-stalled-agent');
    const { body, workspaceRoot } = newBody(agent);
    try {
      const published = stubRelay([]);
      const info = registerCorner(body, agent, {
        conclude: {
          quietSince: Date.now() - CONCLUDE_NUDGE_SPACING_MS - 1,
          nudges: MAX_CONCLUDE_NUDGES_PER_EPISODE,
        },
      });
      spyConcludeTurn(body);

      await Reflect.get(body, 'pollConcludeWatch').call(body);

      const cards = needsAttentionCards(published);
      expect(cards).toHaveLength(1);
      expect(cards[0]!.content).toContain('stalled without concluding');
      expect(info.conclude?.stalledNotified).toBe(true);
      expect(info.conclude?.quietSince).toBeUndefined();

      // Parked: further ticks never republish and never re-nudge.
      await Reflect.get(body, 'pollConcludeWatch').call(body);
      expect(needsAttentionCards(published)).toHaveLength(1);
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('a restart mid-episode resumes the spent budget without duplicate nudges', async () => {
    const agent = newIdentity('conclude-restart-agent');
    const { body, workspaceRoot } = newBody(agent);
    try {
      stubRelay([]);
      const info = registerCorner(body, agent, quietJustNow());
      const { promptAgent } = spyConcludeTurn(body, false, { realPersistence: true });

      // Episode spends its first nudge before the restart...
      await Reflect.get(body, 'pollConcludeWatch').call(body);
      expect(info.conclude?.nudges).toBe(1);
      // ...and the durable state flushes to disk (what `dispose` waits out).
      const durableState = Reflect.get(body, 'durableState') as {
        saveConcludeEpisode: (...args: unknown[]) => Promise<void>;
      };
      await durableState.saveConcludeEpisode(CORNER_ID, info.conclude);

      // A fresh daemon process reads the SAME durable state file.
      const restarted = new Body(
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
      const restoredDurable = Reflect.get(restarted, 'durableState') as {
        concludeEpisode: (id: string) => Promise<Record<string, unknown> | undefined>;
      };
      const restored = await restoredDurable.concludeEpisode(CORNER_ID);
      expect(restored?.nudges).toBe(1);

      // restoreSubchannels hydrates exactly this record onto the corner.
      stubRelay([]);
      const { promptAgent: restartedPrompt } = spyConcludeTurn(restarted);
      const rehydrated = registerCorner(restarted, agent);
      rehydrated.conclude = restored as never;

      // Still inside the spacing window: no immediate re-nudge on resume.
      await Reflect.get(restarted, 'pollConcludeWatch').call(restarted);
      expect(restartedPrompt).not.toHaveBeenCalled();
      // Past the spacing window the episode CONTINUES rather than resetting:
      // this is the second and last nudge of the same episode, not the first
      // of a fresh one.
      rehydrated.conclude!.lastNudgeAt = Date.now() - CONCLUDE_NUDGE_SPACING_MS - 1;
      await Reflect.get(restarted, 'pollConcludeWatch').call(restarted);
      expect(restartedPrompt).toHaveBeenCalledTimes(1);
      expect(rehydrated.conclude?.nudges).toBe(MAX_CONCLUDE_NUDGES_PER_EPISODE);
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('a corner holding a standing unanswered ask is never nudged', async () => {
    const agent = newIdentity('conclude-ask-agent');
    const { body, workspaceRoot } = newBody(agent);
    try {
      stubRelay([
        {
          id: 'ask-event',
          pubkey: agent.publicKey,
          created_at: Math.floor(Date.now() / 1000),
          content: 'Should I split this into two commits?',
          tags: [['t', 'agent-message']],
        } as unknown as NostrEvent,
      ]);
      const info = registerCorner(body, agent, quietJustNow());
      const { promptAgent } = spyConcludeTurn(body);

      await Reflect.get(body, 'pollConcludeWatch').call(body);

      // State 2 holds — an ask IS a terminal outcome. Episode resolved.
      expect(promptAgent).not.toHaveBeenCalled();
      expect(info.conclude?.quietSince).toBeUndefined();
      expect(info.conclude?.nudges).toBe(0);
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('a published merge-gate blocker is terminal until a human starts a turn', async () => {
    const agent = newIdentity('conclude-merge-gate-blocked-agent');
    const { body, workspaceRoot } = newBody(agent);
    try {
      stubRelay([]);
      const info = registerCorner(body, agent, {
        ...quietJustNow(),
        mergeGateBlocked: { reason: 'main conflicts with README.md' },
        cornerState: { state: 'waiting', reason: 'question' },
      });
      const { promptAgent } = spyConcludeTurn(body);

      await Reflect.get(body, 'pollConcludeWatch').call(body);
      await Reflect.get(body, 'pollConcludeWatch').call(body);

      expect(promptAgent).not.toHaveBeenCalled();
      expect(info.conclude?.quietSince).toBeUndefined();
      expect(info.conclude?.nudges).toBe(0);
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('merged and archived corners are never nudged', async () => {
    const agent = newIdentity('conclude-terminal-agent');
    const { body, workspaceRoot } = newBody(agent);
    try {
      stubRelay([]);
      for (const overrides of [
        { archived: true },
        { landedTip: 'b'.repeat(40) },
        {
          // Landed but archive held for the live session (#375/#384).
          landedTip: 'c'.repeat(40),
          archiveWhenSessionRetires: true,
        },
      ]) {
        registerCorner(body, agent, {
          subchannelId: `corner-${JSON.stringify(overrides).length}-${Math.random()}`,
          ...quietJustNow(),
          ...overrides,
        });
      }
      const { promptAgent } = spyConcludeTurn(body);

      await Reflect.get(body, 'pollConcludeWatch').call(body);

      expect(promptAgent).not.toHaveBeenCalled();
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('a suspended session (planned pause / restart park) is not woken just to be nudged', async () => {
    const agent = newIdentity('conclude-suspended-agent');
    const { body, workspaceRoot } = newBody(agent);
    try {
      stubRelay([]);
      registerCorner(body, agent, {
        session: {
          channelId: CORNER_ID,
          sessionId: 'session',
          logicalSessionId: `${agent.publicKey}:${CORNER_ID}`,
          parentChannelId: ROOM_ID,
          processState: 'suspended',
          client: { activeRunId: () => undefined },
        },
        ...quietJustNow(),
      });
      const { promptAgent } = spyConcludeTurn(body);

      await Reflect.get(body, 'pollConcludeWatch').call(body);

      expect(promptAgent).not.toHaveBeenCalled();
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('runs from the Room maintenance chain after the member poll', () => {
    // Source assertion: ordering is load-bearing. A queued human message must
    // start its own real turn before the conclude watch decides anything, and
    // the commit watch must have had its pass so presented work is already in
    // `mergeTarget`.
    const source = readFileSync(new URL('./body.ts', import.meta.url), 'utf8');
    const maintenance = source.slice(source.indexOf('private async pollRoomMaintenance'));
    const memberPoll = maintenance.indexOf("guarded('corner member poll'");
    const commitWatch = maintenance.indexOf("guarded('corner commit watch'");
    const concludeWatch = maintenance.indexOf("guarded('corner conclude watch'");
    expect(concludeWatch).toBeGreaterThan(-1);
    expect(memberPoll).toBeGreaterThan(commitWatch);
    expect(concludeWatch).toBeGreaterThan(memberPoll);
  });
});

describe('harness retry narration never becomes the durable Room reply', () => {
  const human = newIdentity('narration-human');
  /** Verbatim capture: Room `charles`, 18:42 — the flaked pi/ox-alpha turn. */
  const NARRATION = 'Retrying (attempt 1/3, waiting 2s)...Retrying...Retry finished, resuming.';
  const ANSWER = 'The flake cleared — here is the real answer to your question.';

  function requestEvent(eventId: string, agentPubkey: string, content: string) {
    return signEvent(
      {
        pubkey: human.publicKey,
        created_at: Math.floor(Date.now() / 1000),
        kind: 9,
        tags: [
          ['h', 'parent-channel'],
          ['p', agentPubkey],
        ],
        content,
      },
      human.secretKey,
    );
  }

  function turnResult(agentText: string) {
    return {
      stopReason: 'end_turn',
      updates: [
        {
          sessionId: 'readonly-session',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: agentText },
          },
        },
      ],
      agentText,
      toolCalls: [],
    };
  }

  async function makeBody(workspaceRoot: string, promptMock: ReturnType<typeof vi.fn>) {
    const body = new Body({
      agentBinary: '/nonexistent',
      mcpBinary: '/nonexistent',
      agentEnv: {},
      workspaceRoot,
      relayBaseUrl: 'http://relay.test',
      relayHost: 'relay.test',
      relayScheme: 'http',
      relayWsUrl: 'ws://relay.test',
      autoApprovePermissions: true,
    });
    stubEmptyAgentHistory(body);
    Reflect.set(body, 'agentRelay', { queryEvents: vi.fn(async () => []) });
    const client = new AcpClient({ agentBinary: '/nonexistent', agentEnv: {} });
    vi.spyOn(client, 'sessionPrompt').mockImplementation(promptMock);
    body.registerSession({
      channelId: 'parent-channel',
      sessionId: 'readonly-session',
      client,
      mode: 'readonly',
    });
    const published: NostrEvent[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        published.push(JSON.parse(String(init?.body)) as NostrEvent);
        return new Response(JSON.stringify({ accepted: true }), { status: 200 });
      }),
    );
    const processChannelRequestEvents = (
      Reflect.get(body, 'processChannelRequestEvents') as (...args: unknown[]) => Promise<number>
    ).bind(body);
    return { body, published, processChannelRequestEvents };
  }

  function agentMessages(published: NostrEvent[]): NostrEvent[] {
    return published.filter((event) =>
      event.tags.some((tag) => tag[0] === 't' && tag[1] === 'agent-message'),
    );
  }

  function statuses(published: NostrEvent[]): string[] {
    return published
      .filter((event) => event.tags.some((tag) => tag[0] === 't' && tag[1] === 'agent-turn'))
      .map((event) => event.tags.find((tag) => tag[0] === 'status')?.[1] ?? '');
  }

  it('keeps a deadline-forced update interruption visible and retryable', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'buzzy-forced-update-reply-'));
    try {
      let rejectTurn!: (error: Error) => void;
      const promptMock = vi.fn().mockImplementation(
        () =>
          new Promise((_, reject) => {
            rejectTurn = reject;
          }),
      );
      const { body, published, processChannelRequestEvents } = await makeBody(
        workspaceRoot,
        promptMock,
      );
      const durableState = Reflect.get(body, 'durableState') as {
        pending: (channelId: string) => Promise<NostrEvent[]>;
      };
      const event = requestEvent(
        'forced-update-request',
        body.agent.publicKey,
        'Please finish this long-running analysis.',
      );
      const participants = [human.publicKey, body.agent.publicKey];

      const interrupted = processChannelRequestEvents(
        'parent-channel',
        { repo: 'repo' },
        'repository',
        [event],
        participants,
      );
      await vi.waitFor(() => expect(promptMock).toHaveBeenCalledOnce());
      await body.prepareForForcedUpdateRestart('parent-channel');
      rejectTurn(new Error('ACP session cancelled for update deadline'));
      await interrupted;

      expect(agentMessages(published).map((message) => message.content)).toEqual([
        'Beeline is restarting for an update — resend in a moment. This request was not marked delivered.',
      ]);
      expect(statuses(published)).toEqual(['working']);
      await expect(durableState.pending('parent-channel')).resolves.toContainEqual(
        expect.objectContaining({ id: event.id }),
      );

      // A successor starts without the old process's forced-restart flag and
      // consumes the still-pending request through the ordinary reply path.
      Reflect.set(body, 'forcedUpdateRestart', false);
      promptMock.mockResolvedValue(turnResult(ANSWER));
      await processChannelRequestEvents(
        'parent-channel',
        { repo: 'repo' },
        'repository',
        [event],
        participants,
      );
      expect(agentMessages(published).at(-1)?.content).toBe(ANSWER);
      expect(statuses(published).at(-1)).toBe('complete');
      await expect(durableState.pending('parent-channel')).resolves.not.toContainEqual(
        expect.objectContaining({ id: event.id }),
      );
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('preserves the honest terminal fallback for failures unrelated to an update', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'buzzy-terminal-turn-fallback-'));
    try {
      const promptMock = vi.fn().mockRejectedValue(new Error('ordinary adapter failure'));
      const { body, published, processChannelRequestEvents } = await makeBody(
        workspaceRoot,
        promptMock,
      );
      const durableState = Reflect.get(body, 'durableState') as {
        pending: (channelId: string) => Promise<NostrEvent[]>;
      };
      const event = requestEvent(
        'ordinary-failure-request',
        body.agent.publicKey,
        'Can you answer this?',
      );

      await processChannelRequestEvents(
        'parent-channel',
        { repo: 'repo' },
        'repository',
        [event],
        [human.publicKey, body.agent.publicKey],
      );

      expect(agentMessages(published).map((message) => message.content)).toEqual([
        "That turn stopped before I could deliver a reply. I won't retry it without another message from you.",
      ]);
      expect(statuses(published)).toEqual(['working', 'failed']);
      await expect(durableState.pending('parent-channel')).resolves.not.toContainEqual(
        expect.objectContaining({ id: event.id }),
      );
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('names a bubblewrap activation refusal instead of eating it behind the generic fallback', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'buzzy-squire-sandbox-refusal-'));
    try {
      const promptMock = vi
        .fn()
        .mockRejectedValue(
          new Error('Trusty Squire requires an active bubblewrap credential-mask boundary'),
        );
      const { body, published, processChannelRequestEvents } = await makeBody(
        workspaceRoot,
        promptMock,
      );
      const durableState = Reflect.get(body, 'durableState') as {
        pending: (channelId: string) => Promise<NostrEvent[]>;
      };
      const event = requestEvent(
        'squire-sandbox-refusal',
        body.agent.publicKey,
        'Can you answer this?',
      );

      await processChannelRequestEvents(
        'parent-channel',
        { repo: 'repo' },
        'repository',
        [event],
        [human.publicKey, body.agent.publicKey],
      );

      expect(agentMessages(published).map((message) => message.content)).toEqual([
        "I couldn't start because this host's required credential sandbox is unavailable. " +
          'The operator must restore working bubblewrap isolation and restart this agent; your request did not reach the model.',
      ]);
      expect(agentMessages(published)[0]?.content).not.toContain('That turn stopped');
      expect(statuses(published)).toEqual(['working', 'failed']);
      await expect(durableState.pending('parent-channel')).resolves.not.toContainEqual(
        expect.objectContaining({ id: event.id }),
      );
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('publishes only the honest fallback and leaves the request retryable', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'buzzy-narration-reply-'));
    try {
      const promptMock = vi.fn().mockResolvedValue(turnResult(NARRATION));
      const { body, published, processChannelRequestEvents } = await makeBody(
        workspaceRoot,
        promptMock,
      );
      const durableState = Reflect.get(body, 'durableState') as {
        pending: (channelId: string) => Promise<NostrEvent[]>;
      };
      const event = requestEvent('narration-request', body.agent.publicKey, 'What changed?');
      const participants = [human.publicKey, body.agent.publicKey];

      await processChannelRequestEvents(
        'parent-channel',
        { repo: 'repo' },
        'repository',
        [event],
        participants,
      );

      // Exactly one durable message reached the Room: the honest fallback.
      // The narration itself never became a reply.
      const messages = agentMessages(published);
      expect(messages).toHaveLength(1);
      expect(messages[0]!.content).toBe(
        "I couldn't produce a response to that message; please try again.",
      );
      expect(messages.map((event) => event.content).join('\n')).not.toContain('Retrying');

      // The turn is reported FAILED, not complete...
      expect(statuses(published)).toEqual(['working', 'failed']);

      // ...and the triggering request was NOT consumed: it stays pending so
      // the ordinary lifecycle re-drives it (the pre-fix behavior marked it
      // delivered behind a "reply" that was pure retry narration).
      await expect(durableState.pending('parent-channel')).resolves.toContainEqual(
        expect.objectContaining({ id: event.id }),
      );

      // A later attempt answers genuinely: exactly one real answer, consumed.
      promptMock.mockResolvedValue(turnResult(ANSWER));
      await processChannelRequestEvents(
        'parent-channel',
        { repo: 'repo' },
        'repository',
        [event],
        participants,
      );

      const afterRetry = agentMessages(published);
      expect(afterRetry).toHaveLength(2);
      expect(afterRetry.at(-1)!.content).toBe(ANSWER);
      expect(statuses(published).at(-1)).toBe('complete');
      await expect(durableState.pending('parent-channel')).resolves.not.toContainEqual(
        expect.objectContaining({ id: event.id }),
      );
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('keeps the request retryable when pre-tool progress and tool work end in narration', async () => {
    // Last-run-only selection: the genuine-looking progress sentence before
    // the tool call is draft-only by contract, so a turn that degrades into
    // captured retry narration after real tool work has NO durable answer.
    // Tool receipts never consume the human's request on their own.
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'buzzy-narration-progress-'));
    try {
      const progressAndNarration = {
        stopReason: 'end_turn',
        updates: [
          {
            sessionId: 'readonly-session',
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'Let me look at the deploy logs first.' },
            },
          },
          {
            sessionId: 'readonly-session',
            update: {
              sessionUpdate: 'tool_call',
              toolCallId: 'read-deploy-log',
              kind: 'read',
              status: 'completed',
            },
          },
          {
            sessionId: 'readonly-session',
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: NARRATION },
            },
          },
        ],
        agentText: '',
        toolCalls: [{ id: 'read-deploy-log', kind: 'read', status: 'completed' }],
      };
      const promptMock = vi.fn().mockResolvedValue(progressAndNarration);
      const { body, published, processChannelRequestEvents } = await makeBody(
        workspaceRoot,
        promptMock,
      );
      const durableState = Reflect.get(body, 'durableState') as {
        pending: (channelId: string) => Promise<NostrEvent[]>;
      };
      const event = requestEvent(
        'degraded-request',
        body.agent.publicKey,
        'Why did the deploy fail?',
      );
      const participants = [human.publicKey, body.agent.publicKey];

      await processChannelRequestEvents(
        'parent-channel',
        { repo: 'repo' },
        'repository',
        [event],
        participants,
      );

      // Neither the progress sentence nor the narration reached the wire —
      // only the honest fallback did — and the request stays retryable even
      // though reads happened, because no answer was produced.
      const messages = agentMessages(published);
      expect(messages).toHaveLength(1);
      expect(messages[0]!.content).toBe(
        "I couldn't produce a response to that message; please try again.",
      );
      expect(messages.map((message) => message.content).join('\n')).not.toContain(
        'deploy logs first.',
      );
      expect(statuses(published)).toEqual(['working', 'failed']);
      await expect(durableState.pending('parent-channel')).resolves.toContainEqual(
        expect.objectContaining({ id: event.id }),
      );

      // The recovered attempt answers genuinely: exactly one real answer.
      promptMock.mockResolvedValue(turnResult(ANSWER));
      await processChannelRequestEvents(
        'parent-channel',
        { repo: 'repo' },
        'repository',
        [event],
        participants,
      );

      const afterRetry = agentMessages(published);
      expect(afterRetry).toHaveLength(2);
      expect(afterRetry.at(-1)!.content).toBe(ANSWER);
      expect(statuses(published).at(-1)).toBe('complete');
      await expect(durableState.pending('parent-channel')).resolves.not.toContainEqual(
        expect.objectContaining({ id: event.id }),
      );
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('delivers an ordinary prose answer through the normal path', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'buzzy-narration-prose-'));
    try {
      const prose =
        'I retried the deploy twice; the second run succeeded and every test passes now.';
      const promptMock = vi.fn().mockResolvedValue(turnResult(prose));
      const { body, published, processChannelRequestEvents } = await makeBody(
        workspaceRoot,
        promptMock,
      );
      const durableState = Reflect.get(body, 'durableState') as {
        pending: (channelId: string) => Promise<NostrEvent[]>;
      };
      const event = requestEvent('prose-request', body.agent.publicKey, 'Did the deploy work?');
      const participants = [human.publicKey, body.agent.publicKey];

      await processChannelRequestEvents(
        'parent-channel',
        { repo: 'repo' },
        'repository',
        [event],
        participants,
      );

      // Genuine prose that merely mentions retries is a real answer: one
      // durable message with the model's own words, complete status, and the
      // request consumed on the first attempt.
      const messages = agentMessages(published);
      expect(messages).toHaveLength(1);
      expect(messages[0]!.content).toContain('every test passes now');
      expect(statuses(published)).toEqual(['working', 'complete']);
      await expect(durableState.pending('parent-channel')).resolves.not.toContainEqual(
        expect.objectContaining({ id: event.id }),
      );
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });
});
