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
describe('Room conversation and permission-gated work intent', () => {
  const human = newIdentity('human');
  const agent = newIdentity('agent');

  function historyEntry(
    eventId: string,
    body: string,
    kind: 'human-message' | 'agent-message' = 'human-message',
    createdAt = 1,
  ): AgentHistoryEntry {
    return {
      eventId,
      channelId: 'parent-channel',
      type: kind,
      author: {
        pubkey: kind === 'human-message' ? human.publicKey : agent.publicKey,
        kind: kind === 'human-message' ? 'human' : 'agent',
        label: kind === 'human-message' ? 'Milo (@milo)' : 'Joy (@joy)',
      },
      body,
      attachments: [],
      createdAt,
      provenance: 'relay-verified',
    } as AgentHistoryEntry;
  }

  function requestEvent(
    tags: string[][],
    author = human,
    content = 'Implement the channel request',
  ) {
    return signEvent(
      {
        pubkey: author.publicKey,
        created_at: 1,
        kind: 9,
        tags: [['h', 'parent-channel'], ...tags],
        content,
      },
      author.secretKey,
    );
  }

  it('documents the mounted open_corner tool for every harness', () => {
    for (const harness of ['codex-acp', 'claude-agent-acp', 'pi-acp']) {
      const instructions = roomEditPolicyInstructions('repository', harness).join('\n');
      expect(instructions).toContain('mounted open_corner tool');
      expect(instructions).toMatch(/needs no human approval/i);
      expect(instructions).not.toContain('CORNER_REQUEST');
    }
  });

  it('replies to an @-addressed ordinary message without authorizing work', () => {
    const event = requestEvent([['p', agent.publicKey]]);
    expect(isChannelAddressedMessage(event, agent.publicKey)).toBe(true);
    expect(isChannelWorkIntent(event, agent.publicKey)).toBe(false);
    expect(isChannelWorkIntent(event, agent.publicKey)).toBe(false);
  });

  it('replies conversationally in a two-party Room without opening work', () => {
    const event = requestEvent([]);
    const participants = [human.publicKey, agent.publicKey];
    expect(isChannelAddressedMessage(event, agent.publicKey, participants)).toBe(true);
    expect(isChannelWorkIntent(event, agent.publicKey, participants)).toBe(false);
  });

  it.each([
    'open a new corner to do work: add a FEATURE.md',
    'open a corner and implement the retry',
    'start work on the retry in a corner',
    'Could you create a new corner for this change?',
  ])('recognizes an explicit corner command: %s', (content) => {
    const participants = [human.publicKey, agent.publicKey];
    expect(
      isChannelWorkIntent(requestEvent([], human, content), agent.publicKey, participants),
    ).toBe(true);
  });

  it.each([
    'Create FEATURE.md and commit it.',
    'Can you implement the retry?',
    'What happens when an agent opens a corner?',
    'Should we open a corner for this?',
    "Don't open a corner; just explain the change.",
    'Tell me about the active corner.',
  ])('keeps vague or conversational intent in the Room: %s', (content) => {
    const participants = [human.publicKey, agent.publicKey];
    expect(
      isChannelWorkIntent(requestEvent([], human, content), agent.publicKey, participants),
    ).toBe(false);
  });

  it.each([
    'analyze this repository and tell me its principal user stories',
    'Explain what the session scheduler does.',
    'summarize the authentication flow',
    'What does isChannelWorkIntent do?',
    'Find where merge approval is verified.',
    'In one sentence, what is the purpose of a repository Room?',
    "I'd like you to explain how corners work.",
  ])('locks a pure information request to read-only Room analysis: %s', (content) => {
    expect(isReadOnlyInformationRequest(content)).toBe(true);
  });

  it.each([
    'Analyze the scheduler, then fix it.',
    'Explain this and implement the change.',
    'Find and replace the old API.',
    'Review this code and commit any fixes.',
    'Fix the scheduler and explain why it was broken.',
    'Analyze the scheduler. Fix the race.',
  ])('does not misclassify a mixed write request as information-only: %s', (content) => {
    expect(isReadOnlyInformationRequest(content)).toBe(false);
  });

  it('requires @-addressing when multiple people or agents share the Room', () => {
    const colleague = newIdentity('colleague');
    const otherAgent = newIdentity('other-agent');
    const participants = [
      human.publicKey,
      colleague.publicKey,
      agent.publicKey,
      otherAgent.publicKey,
    ];
    expect(isChannelAddressedMessage(requestEvent([]), agent.publicKey, participants)).toBe(false);
    expect(
      isChannelAddressedMessage(
        requestEvent([['p', agent.publicKey]]),
        agent.publicKey,
        participants,
      ),
    ).toBe(true);
    expect(
      isChannelAddressedMessage(
        requestEvent([['p', agent.publicKey]]),
        otherAgent.publicKey,
        participants,
      ),
    ).toBe(false);
  });

  it('routes the multi-party addressing table from indexed reply facts', () => {
    const colleague = newIdentity('continuation-colleague');
    const otherAgent = newIdentity('continuation-other-agent');
    const participants = [
      human.publicKey,
      colleague.publicKey,
      agent.publicKey,
      otherAgent.publicKey,
    ];
    const tagged = requestEvent([['p', agent.publicKey]], human, '@Joy start here.');
    const followup = requestEvent([], human, 'What about the second part?');
    const humanRequest = requestEvent([['p', agent.publicKey]], human, '@Joy answer this.');
    const colleagueRequest = requestEvent(
      [['p', agent.publicKey]],
      colleague,
      '@Joy answer my question.',
    );
    const message = (
      id: string,
      author: { publicKey: string },
      kind: 'human' | 'agent',
      createdAt: number,
      presentation: RoomViewMessage['presentation'] = 'message',
      replyTo?: string,
    ): RoomViewMessage => ({
      id,
      text: id,
      createdAt,
      author: { pubkey: author.publicKey, kind, name: kind === 'agent' ? 'Joy' : 'Person' },
      presentation,
      ...(replyTo
        ? { reply: { channelId: 'parent-channel', eventId: replyTo, rootId: replyTo } }
        : {}),
    });
    const current = message(followup.id, human, 'human', 4);
    const replyToHuman = message(
      'agent-reply-to-human',
      agent,
      'agent',
      2,
      'message',
      humanRequest.id,
    );
    const replyToColleague = message(
      'agent-reply-to-colleague',
      agent,
      'agent',
      2,
      'message',
      colleagueRequest.id,
    );
    const noise = message('status-card', agent, 'agent', 3, 'system');

    expect(isChannelAddressedMessage(tagged, agent.publicKey, participants)).toBe(true);
    expect(
      isChannelAddressedMessage(followup, agent.publicKey, participants, [
        message(humanRequest.id, human, 'human', 1),
        replyToHuman,
        current,
      ]),
    ).toBe(true);
    expect(
      isChannelAddressedMessage(followup, agent.publicKey, participants, [
        message(colleagueRequest.id, colleague, 'human', 1),
        replyToColleague,
        current,
      ]),
    ).toBe(false);
    expect(
      isChannelAddressedMessage(followup, agent.publicKey, participants, [
        message(humanRequest.id, human, 'human', 1),
        replyToHuman,
        noise,
        current,
      ]),
    ).toBe(true);
  });

  it('a message tagging ANY member suppresses continuation for every other agent (captured 2026-08-28 failure)', () => {
    // Captain, mid-exchange with agent A (A's threaded answer was the latest
    // message), tags @B instead: "u back?". A must NOT fire its continuation;
    // B must answer its own direct tag.
    const otherAgent = newIdentity('tag-suppress-other-agent');
    const participants = [human.publicKey, agent.publicKey, otherAgent.publicKey];
    const message = (
      id: string,
      author: { publicKey: string },
      kind: 'human' | 'agent',
      createdAt: number,
      presentation: RoomViewMessage['presentation'] = 'message',
      replyTo?: string,
    ): RoomViewMessage => ({
      id,
      text: id,
      createdAt,
      author: { pubkey: author.publicKey, kind, name: kind === 'agent' ? 'Joy' : 'Person' },
      presentation,
      ...(replyTo
        ? { reply: { channelId: 'parent-channel', eventId: replyTo, rootId: replyTo } }
        : {}),
    });
    const humanRequest = requestEvent([['p', agent.publicKey]], human, '@Joy answer this.');
    const agentReply = message(
      'agent-reply-to-human',
      agent,
      'agent',
      2,
      'message',
      humanRequest.id,
    );
    // "@ox u back?" — a p tag for the OTHER agent, unthreaded to A's answer.
    const taggedSwitch = requestEvent([['p', otherAgent.publicKey]], human, `@other-agent u back?`);
    taggedSwitch.created_at = 4;
    const current = message(taggedSwitch.id, human, 'human', 4);

    // Agent A is in continuation with the human, but the human's message tags
    // another member, so A must not respond.
    expect(
      isChannelAddressedMessage(taggedSwitch, agent.publicKey, participants, [
        message(humanRequest.id, human, 'human', 1),
        agentReply,
        current,
      ]),
    ).toBe(false);

    // Agent B is tagged directly and must respond.
    expect(isChannelAddressedMessage(taggedSwitch, otherAgent.publicKey, participants)).toBe(true);

    // The same continuation still works when the message tags nobody.
    const untaggedFollowup = requestEvent([], human, 'What about the second part?');
    untaggedFollowup.created_at = 4;
    expect(
      isChannelAddressedMessage(untaggedFollowup, agent.publicKey, participants, [
        message(humanRequest.id, human, 'human', 1),
        agentReply,
        message(untaggedFollowup.id, human, 'human', 4),
      ]),
    ).toBe(true);
  });

  it('does not infer a continuation from adjacent unthreaded agent prose', () => {
    const colleague = newIdentity('adjacent-colleague');
    const followup = requestEvent([], human, 'Was that answer meant for me?');
    const participants = [human.publicKey, colleague.publicKey, agent.publicKey];
    const messages: RoomViewMessage[] = [
      {
        id: 'unthreaded-agent-message',
        text: 'An answer without a recorded recipient.',
        createdAt: 1,
        author: { pubkey: agent.publicKey, kind: 'agent', name: 'Joy' },
        presentation: 'message',
      },
      {
        id: followup.id,
        text: followup.content,
        createdAt: 2,
        author: { pubkey: human.publicKey, kind: 'human', name: 'Milo' },
        presentation: 'message',
      },
    ];

    expect(isChannelAddressedMessage(followup, agent.publicKey, participants, messages)).toBe(
      false,
    );
  });

  it('drives only the recorded recipient continuation through Room event processing', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'buzzy-room-continuation-routing-'));
    try {
      const colleague = newIdentity('processed-continuation-colleague');
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
      const participants = [human.publicKey, colleague.publicKey, body.agent.publicKey];
      const original = requestEvent(
        [['p', body.agent.publicKey]],
        human,
        '@Joy give me the first answer.',
      );
      const humanFollowup = requestEvent([], human, 'Now answer the follow-up.');
      const colleagueFollowup = requestEvent([], colleague, 'This is a separate conversation.');
      const indexed = vi.fn(async (): Promise<RoomViewMessage[]> => [
        {
          id: original.id,
          text: original.content,
          createdAt: 1,
          author: { pubkey: human.publicKey, kind: 'human', name: 'Milo' },
          presentation: 'message',
        },
        {
          id: 'threaded-agent-reply',
          text: 'Here is the first answer.',
          createdAt: 2,
          author: { pubkey: body.agent.publicKey, kind: 'agent', name: 'Joy' },
          presentation: 'message',
          reply: { channelId: 'parent-channel', eventId: original.id, rootId: original.id },
        },
        {
          id: humanFollowup.id,
          text: humanFollowup.content,
          createdAt: 3,
          author: { pubkey: human.publicKey, kind: 'human', name: 'Milo' },
          presentation: 'message',
        },
      ]);
      const replyInRoom = vi.fn(async () => ({ openedCorner: false, producedReply: true }));
      Reflect.set(body, 'indexedRoomMessages', indexed);
      Reflect.set(
        body,
        'roomAuthorAttributions',
        vi.fn(
          async () =>
            new Map([
              [human.publicKey, { kind: 'Person', name: 'Milo', handle: 'milo' }],
              [colleague.publicKey, { kind: 'Person', name: 'Nia', handle: 'nia' }],
              [body.agent.publicKey, { kind: 'Agent', name: 'Joy', handle: 'joy' }],
            ]),
        ),
      );
      Reflect.set(
        body,
        'requestAlreadyOpened',
        vi.fn(async () => false),
      );
      Reflect.set(
        body,
        'channelCommunityId',
        vi.fn(async () => undefined),
      );
      Reflect.set(body, 'replyInRoom', replyInRoom);
      Reflect.set(body, 'agentRelay', { queryEvents: vi.fn(async () => []) });
      const processChannelRequestEvents = (
        Reflect.get(body, 'processChannelRequestEvents') as (...args: unknown[]) => Promise<number>
      ).bind(body);

      await processChannelRequestEvents(
        'parent-channel',
        { repo: 'repo' },
        'repository',
        [humanFollowup],
        participants,
      );
      expect(replyInRoom).toHaveBeenCalledOnce();
      expect(replyInRoom).toHaveBeenCalledWith(
        'parent-channel',
        { repo: 'repo' },
        expect.objectContaining({ eventId: humanFollowup.id, authorPubkey: human.publicKey }),
        false,
        'repository',
        undefined,
        false,
      );

      replyInRoom.mockClear();
      indexed.mockResolvedValueOnce([
        {
          id: humanFollowup.id,
          text: humanFollowup.content,
          createdAt: 3,
          author: { pubkey: human.publicKey, kind: 'human', name: 'Milo' },
          presentation: 'message',
        },
        {
          id: 'threaded-followup-reply',
          text: 'Here is the follow-up answer.',
          createdAt: 4,
          author: { pubkey: body.agent.publicKey, kind: 'agent', name: 'Joy' },
          presentation: 'message',
          reply: {
            channelId: 'parent-channel',
            eventId: humanFollowup.id,
            rootId: humanFollowup.id,
          },
        },
        {
          id: colleagueFollowup.id,
          text: colleagueFollowup.content,
          createdAt: 5,
          author: { pubkey: colleague.publicKey, kind: 'human', name: 'Nia' },
          presentation: 'message',
        },
      ]);
      await processChannelRequestEvents(
        'parent-channel',
        { repo: 'repo' },
        'repository',
        [colleagueFollowup],
        participants,
      );
      expect(replyInRoom).not.toHaveBeenCalled();
      expect(indexed).toHaveBeenCalledTimes(2);
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('retires the signed Start work marker as an edit authorization', () => {
    const participants = [human.publicKey, agent.publicKey];
    const work = requestEvent([['t', 'buzz-agent-request']]);
    expect(isChannelAddressedMessage(work, agent.publicKey, participants)).toBe(true);
    expect(isChannelWorkIntent(work, agent.publicKey, participants)).toBe(false);
  });

  it('never accepts the agent tasking itself', () => {
    expect(
      isChannelAddressedMessage(requestEvent([['p', agent.publicKey]], agent), agent.publicKey, [
        human.publicKey,
        agent.publicKey,
      ]),
    ).toBe(false);
  });

  it('quotes attributed shared history without granting it turn authority', () => {
    const prompt = roomTurnPrompt(
      [
        historyEntry('joy-message', 'I prefer mushroom.', 'agent-message', 0),
        historyEntry('current', '@xian what did Joy recommend?', 'human-message', 1),
      ],
      '[Person Milo (@milo) · def456]: @xian what did Joy recommend?',
      'current',
    );

    expect(prompt).toContain('[Agent Joy (@joy) ·');
    expect(prompt).toContain('I prefer mushroom.');
    expect(prompt).toContain('Current human-addressed request:');
    expect(prompt).toContain('@xian what did Joy recommend?');
    expect(prompt).toContain('It does not authorize mutation');
    expect(prompt).toContain(
      'your own final Room reply may @mention current peer agents for host-bounded delegation turns',
    );
    expect(prompt).toContain('at most 4 agent hops');
    expect(prompt).toContain('Never claim the peer replied or completed work');
    expect(prompt).toContain('Never claim that someone agreed, approved, or said something');
    expect(prompt).toContain('Never claim that an action or agent exchange happened');
  });

  it('assembles the bounded Room window from conversation only', () => {
    const identity = (kind: 'human' | 'agent', name: string) => ({
      pubkey: kind === 'human' ? human.publicKey : agent.publicKey,
      kind,
      name,
    });
    const message = (
      id: string,
      text: string,
      presentation: RoomViewMessage['presentation'],
      kind: 'human' | 'agent' = 'agent',
    ): RoomViewMessage => ({
      id,
      text,
      createdAt: Number(id.replace(/\D/gu, '')) || 1,
      author: identity(kind, kind === 'human' ? 'Captain' : 'Joy'),
      presentation,
    });
    const durableInbox: RoomViewMessage[] = [
      message('1', 'Captain: you are my chief of staff.', 'message', 'human'),
      message('2', '🤖 Agent session started', 'system'),
      message('3', 'Model unavailable · unavailable-model', 'system'),
      message('4', 'GitHub · PR #42 merged', 'system'),
      message('5', 'GitHub polling degraded', 'system'),
      message('6', 'Steer queued for the active turn.', 'system'),
      message('7', 'Requested permission to edit.', 'card'),
      message('8', 'Running tests', 'activity'),
      message('9', 'Corner opened', 'card'),
      message('10', 'I will maintain the launch checklist.', 'message'),
    ];

    const history = roomViewConversationHistory('parent-channel', durableInbox);
    const prompt = roomTurnPrompt(history, 'What is your job?', 'current');

    expect(history.map((entry) => entry.body)).toEqual([
      'Captain: you are my chief of staff.',
      'I will maintain the launch checklist.',
    ]);
    expect(prompt).toContain('Captain: you are my chief of staff.');
    expect(prompt).toContain('I will maintain the launch checklist.');
    for (const junk of durableInbox.filter((entry) => entry.presentation !== 'message')) {
      expect(prompt).not.toContain(junk.text);
    }
  });

  it.each([
    ['Room', roomTurnPrompt],
    ['corner', cornerTurnPrompt],
  ] as const)('quotes only the six newest %s shared-context messages', (_surface, turnPrompt) => {
    const transcript = Array.from({ length: 8 }, (_, index) =>
      historyEntry(`context-${index}`, `context-${index}`, 'human-message', index),
    );

    const prompt = turnPrompt(transcript, '[Person current]: answer this', 'current');

    expect(prompt).not.toContain('context-0');
    expect(prompt).not.toContain('context-1');
    for (let index = 2; index < 8; index++) {
      expect(prompt).toContain(`context-${index}`);
    }
  });

  it('seeds a corner task prompt with only the bounded objective and opening request', () => {
    const prompt = cornerOpenTaskPrompt(
      'add retry logic to the sync loop',
      '[Person Milo (@milo) · def456]: open a corner',
    );

    expect(prompt).toContain('add retry logic to the sync loop');
    expect(prompt).toContain('Bounded task objective:');
    expect(prompt).toContain('Message that opened this corner:');
    expect(prompt).toContain('open a corner');
    expect(prompt).not.toContain('Recent Room transcript');
  });

  it('recognizes only a human-addressed conversation command with one known peer agent', () => {
    const joy = newIdentity('Joy');
    const participants = [human.publicKey, agent.publicKey, joy.publicKey];
    const attributions = new Map([
      [agent.publicKey, { kind: 'Agent' as const, name: 'Xian', handle: 'xian' }],
      [joy.publicKey, { kind: 'Agent' as const, name: 'Joy', handle: 'joy' }],
    ]);
    const authorized = requestEvent(
      [['p', agent.publicKey]],
      human,
      '@xian talk to @joy for a bit',
    );

    expect(
      humanAgentExchangeRequest(authorized, agent.publicKey, participants, attributions),
    ).toEqual({
      kind: 'authorized',
      authorization: {
        authorizationEventId: authorized.id,
        humanPubkey: human.publicKey,
        initiatorPubkey: agent.publicKey,
        peerPubkey: joy.publicKey,
      },
    });
    expect(humanAgentExchangeRequest(authorized, joy.publicKey, participants, attributions)).toBe(
      undefined,
    );
    expect(
      humanAgentExchangeRequest(
        requestEvent([['p', agent.publicKey]], human, '@xian have a conversation with @missing'),
        agent.publicKey,
        participants,
        attributions,
      ),
    ).toEqual({ kind: 'invalid', reason: 'missing-or-unknown-peer' });
  });

  it('tells an authorized peer to ground one reply and exposes the N=2 hard cap', () => {
    const prompt = agentExchangeTurnPrompt(
      [historyEntry('turn-1', 'What tradeoff matters most?', 'agent-message', 0)],
      '[Agent Xian (@xian) · abc123]: What tradeoff matters most?',
      'turn-1',
      {
        authorizationEventId: 'human-request',
        humanPubkey: human.publicKey,
        initiatorPubkey: agent.publicKey,
        peerPubkey: 'f'.repeat(64),
        turn: 1,
        stopped: false,
      },
    );

    expect(AGENT_EXCHANGE_MAX_MESSAGES).toBe(2);
    expect(prompt).toContain('your message 1 of at most 2');
    expect(prompt).toContain("peer's actual latest message");
    expect(prompt).toContain('Do not claim that later replies');
    expect(prompt).toContain('strictly read-only');
  });

  it('routes a validated agent delegation with the root human as authority', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'buzzy-room-delegation-route-'));
    const source = newIdentity('source-agent');
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
        accessPolicy: 'creator',
        accessOwnerPubkey: human.publicKey,
      },
      undefined,
      agent,
    );
    try {
      const root = requestEvent([['p', source.publicKey]], human, '@source ask @agent for quotes');
      const content = '@agent produce the ten quotes and post them here.';
      const envelope: AgentDelegationEnvelope = {
        rootRequestId: root.id,
        rootHumanPubkey: human.publicKey,
        fromAgentId: source.publicKey,
        toAgentIds: [agent.publicKey],
        sourceEventId: root.id,
        hop: 1,
        dedupe: agentDelegationDedupe({
          rootRequestId: root.id,
          fromAgentId: source.publicKey,
          toAgentIds: [agent.publicKey],
          text: content,
        }),
      };
      const delegated = signEvent(
        {
          pubkey: source.publicKey,
          created_at: 2,
          kind: 9,
          tags: [
            ['h', 'parent-channel'],
            ['t', 'agent-message'],
            ['e', root.id, '', 'reply'],
            ...agentDelegationTags(envelope),
          ],
          content,
        },
        source.secretKey,
      );
      const registry = signEvent(
        {
          pubkey: source.publicKey,
          created_at: 1,
          kind: 9,
          tags: [['t', TAG_AGENT]],
          content: '{}',
        },
        source.secretKey,
      );
      Reflect.set(
        body,
        'roomAuthorAttributions',
        vi.fn(
          async () =>
            new Map([
              [human.publicKey, { kind: 'Member', name: 'Human', handle: 'human' }],
              [source.publicKey, { kind: 'Agent', name: 'Source', handle: 'source' }],
              [agent.publicKey, { kind: 'Agent', name: 'Agent', handle: 'agent' }],
            ]),
        ),
      );
      Reflect.set(
        body,
        'requestAlreadyOpened',
        vi.fn(async () => false),
      );
      Reflect.set(
        body,
        'validateAgentDelegationEnvelope',
        vi.fn(async () => envelope),
      );
      Reflect.set(
        body,
        'agentDelegationAlreadyAnswered',
        vi.fn(async () => false),
      );
      const access = vi.fn(async () => true);
      Reflect.set(body, 'senderAccessAllowedFresh', access);
      Reflect.set(
        body,
        'channelCommunityId',
        vi.fn(async () => 'workspace'),
      );
      const replyInRoom = vi.fn(async () => ({ openedCorner: false, producedReply: true }));
      Reflect.set(body, 'replyInRoom', replyInRoom);
      Reflect.set(body, 'agentRelay', {
        queryEvents: vi.fn(async (filters: Array<Record<string, unknown>>) =>
          filters[0]?.['#t'] ? [registry] : [],
        ),
      });
      const processChannelRequestEvents = (
        Reflect.get(body, 'processChannelRequestEvents') as (...args: unknown[]) => Promise<number>
      ).bind(body);

      await processChannelRequestEvents(
        'parent-channel',
        { repo: 'repo' },
        'repository',
        [delegated],
        [human.publicKey, source.publicKey, agent.publicKey],
      );

      expect(access).toHaveBeenCalledWith('workspace', human.publicKey);
      expect(replyInRoom).toHaveBeenCalledWith(
        'parent-channel',
        { repo: 'repo' },
        expect.objectContaining({
          eventId: delegated.id,
          authorPubkey: human.publicKey,
          authorAttribution: expect.objectContaining({ kind: 'Agent', handle: 'source' }),
          replyRootId: root.id,
          delegation: envelope,
        }),
        false,
        'repository',
        undefined,
        false,
      );
    } finally {
      await body.dispose();
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('validates the same-Room human root before admitting a signed first hop', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'buzzy-room-delegation-root-'));
    const source = newIdentity('root-source');
    const peer = newIdentity('root-peer');
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
    try {
      const root = requestEvent([['p', source.publicKey]], human, '@source ask the peer');
      const content = '@peer answer the root request.';
      const envelope: AgentDelegationEnvelope = {
        rootRequestId: root.id,
        rootHumanPubkey: human.publicKey,
        fromAgentId: source.publicKey,
        toAgentIds: [body.agent.publicKey, peer.publicKey],
        sourceEventId: root.id,
        hop: 1,
        dedupe: agentDelegationDedupe({
          rootRequestId: root.id,
          fromAgentId: source.publicKey,
          toAgentIds: [body.agent.publicKey, peer.publicKey],
          text: content,
        }),
      };
      const event = signEvent(
        {
          pubkey: source.publicKey,
          created_at: 2,
          kind: 9,
          tags: [
            ['h', 'parent-channel'],
            ['t', 'agent-message'],
            ['e', root.id, '', 'reply'],
            ...agentDelegationTags(envelope),
          ],
          content,
        },
        source.secretKey,
      );
      Reflect.set(body, 'agentRelay', {
        queryEvents: vi.fn(async (filters: Array<Record<string, unknown>>) =>
          filters[0]?.ids ? [root] : [],
        ),
      });
      const validate = (
        Reflect.get(body, 'validateAgentDelegationEnvelope') as (
          channelId: string,
          event: NostrEvent,
          participants: string[],
        ) => Promise<AgentDelegationEnvelope | undefined>
      ).bind(body);
      const participants = [human.publicKey, source.publicKey, body.agent.publicKey, peer.publicKey];

      await expect(validate('parent-channel', event, participants)).resolves.toEqual(envelope);
      const forgedEnvelope = { ...envelope, rootHumanPubkey: newIdentity('forger').publicKey };
      const forged = signEvent(
        {
          pubkey: source.publicKey,
          created_at: 3,
          kind: 9,
          tags: [
            ['h', 'parent-channel'],
            ['t', 'agent-message'],
            ['e', root.id, '', 'reply'],
            ...agentDelegationTags(forgedEnvelope),
          ],
          content,
        },
        source.secretKey,
      );
      await expect(validate('parent-channel', forged, participants)).resolves.toBeUndefined();
      await expect(validate('another-room', event, participants)).resolves.toBeUndefined();
    } finally {
      await body.dispose();
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('fans out to every delimited Room agent and refuses only real workspace agents outside the Room', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'buzzy-room-delegation-mentions-'));
    const codex = newIdentity('mention-codex');
    const bee = newIdentity('mention-bee');
    const outside = newIdentity('mention-outside');
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
    try {
      Reflect.set(
        body,
        'agentMentionRoster',
        vi.fn(async (channelId: string) => ({
          roster:
            channelId === 'workspace'
              ? [
                  { handle: 'codex', pubkey: codex.publicKey, kind: 'agent' as const },
                  { handle: 'bee', pubkey: bee.publicKey, kind: 'agent' as const },
                  { handle: 'outside', pubkey: outside.publicKey, kind: 'agent' as const },
                ]
              : [
                  { handle: 'codex', pubkey: codex.publicKey, kind: 'agent' as const },
                  { handle: 'bee', pubkey: bee.publicKey, kind: 'agent' as const },
                ],
          attributions: new Map(),
        })),
      );
      Reflect.set(
        body,
        'channelCommunityId',
        vi.fn(async () => 'workspace'),
      );
      Reflect.set(
        body,
        'isRoomAgentOnline',
        vi.fn(async () => true),
      );
      const prepare = (
        Reflect.get(body, 'prepareRoomDelegation') as (
          channelId: string,
          request: ChannelTaskRequest,
          text: string,
        ) => Promise<{ status: string; noticeStatus?: string; envelope?: AgentDelegationEnvelope }>
      ).bind(body);
      const request: ChannelTaskRequest = {
        eventId: '1'.repeat(64),
        authorPubkey: human.publicKey,
        content: 'ask codex',
        createdAt: 1,
      };

      await expect(
        prepare(
          'room',
          request,
          '...trying it again, fresh and clean: --- **@codex** and @bee, please help ...',
        ),
      ).resolves.toMatchObject({
        status: 'dispatch',
        envelope: { toAgentIds: [codex.publicKey, bee.publicKey] },
      });
      await expect(prepare('room', request, '@mention me')).resolves.toMatchObject({
        status: 'none',
      });
      await expect(prepare('room', request, '@outside please help')).resolves.toMatchObject({
        status: 'notice',
        noticeStatus: 'unknown',
      });
    } finally {
      await body.dispose();
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('turns offline and exhausted peer mentions into host notices without dispatch', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'buzzy-room-delegation-notices-'));
    const peer = newIdentity('notice-peer');
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
      agentDelegationMaxHops: 1,
    });
    try {
      Reflect.set(
        body,
        'agentMentionRoster',
        vi.fn(async () => ({
          roster: [{ handle: 'peer', pubkey: peer.publicKey, kind: 'agent' }],
          attributions: new Map(),
        })),
      );
      Reflect.set(
        body,
        'isRoomAgentOnline',
        vi.fn(async () => false),
      );
      const prepare = (
        Reflect.get(body, 'prepareRoomDelegation') as (
          channelId: string,
          request: ChannelTaskRequest,
          text: string,
        ) => Promise<{ status: string; noticeStatus?: string }>
      ).bind(body);
      const request: ChannelTaskRequest = {
        eventId: '1'.repeat(64),
        authorPubkey: human.publicKey,
        content: 'ask peer',
        createdAt: 1,
      };
      await expect(prepare('parent-channel', request, '@peer answer this')).resolves.toMatchObject({
        status: 'notice',
        noticeStatus: 'offline',
      });
      const exhausted: ChannelTaskRequest = {
        ...request,
        delegation: {
          rootRequestId: '2'.repeat(64),
          rootHumanPubkey: human.publicKey,
          fromAgentId: peer.publicKey,
          toAgentIds: [body.agent.publicKey],
          sourceEventId: '2'.repeat(64),
          hop: 1,
          dedupe: '3'.repeat(64),
        },
      };
      await expect(
        prepare('parent-channel', exhausted, '@peer answer again'),
      ).resolves.toMatchObject({ status: 'notice', noticeStatus: 'limit' });
    } finally {
      await body.dispose();
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('starts a fresh bounded root when a human replies mid-thread', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'buzzy-room-delegation-new-root-'));
    const peer = newIdentity('new-root-peer');
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
    try {
      Reflect.set(
        body,
        'agentMentionRoster',
        vi.fn(async () => ({
          roster: [{ handle: 'peer', pubkey: peer.publicKey, kind: 'agent' }],
          attributions: new Map(),
        })),
      );
      Reflect.set(
        body,
        'isRoomAgentOnline',
        vi.fn(async () => true),
      );
      const prepare = (
        Reflect.get(body, 'prepareRoomDelegation') as (
          channelId: string,
          request: ChannelTaskRequest,
          text: string,
        ) => Promise<{ status: string; envelope?: AgentDelegationEnvelope }>
      ).bind(body);
      const firstHumanEventId = '1'.repeat(64);
      const laterHumanEventId = '2'.repeat(64);

      const first = await prepare(
        'parent-channel',
        {
          eventId: firstHumanEventId,
          authorPubkey: human.publicKey,
          content: 'first root',
          createdAt: 1,
        },
        '@peer take this',
      );
      const later = await prepare(
        'parent-channel',
        {
          eventId: laterHumanEventId,
          authorPubkey: human.publicKey,
          content: 'human interruption',
          createdAt: 2,
        },
        '@peer take this instead',
      );

      expect(first.envelope).toMatchObject({ rootRequestId: firstHumanEventId, hop: 1 });
      expect(later.envelope).toMatchObject({ rootRequestId: laterHumanEventId, hop: 1 });
    } finally {
      await body.dispose();
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('dedupes an identical delegation from relay evidence after a daemon restart', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'buzzy-room-delegation-restart-'));
    const target = newIdentity('restart-target');
    const source = newIdentity('restart-source');
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
      },
      undefined,
      target,
    );
    try {
      const envelope = {
        rootRequestId: '3'.repeat(64),
        rootHumanPubkey: human.publicKey,
        fromAgentId: source.publicKey,
        toAgentIds: [target.publicKey],
        sourceEventId: '4'.repeat(64),
        hop: 1,
        dedupe: '5'.repeat(64),
      } satisfies AgentDelegationEnvelope;
      const priorReply = signEvent(
        {
          pubkey: target.publicKey,
          created_at: 10,
          kind: 9,
          tags: [
            ['h', 'parent-channel'],
            ['t', 'agent-message'],
            ['t', 'buzz-agent-delegation'],
            ['root-request', envelope.rootRequestId],
            ['input-dedupe', envelope.dedupe],
          ],
          content: 'Already answered before restart.',
        },
        target.secretKey,
      );
      const queryEvents = vi.fn(async () => [priorReply]);
      Reflect.set(body, 'agentRelay', { queryEvents });
      const alreadyAnswered = (
        Reflect.get(body, 'agentDelegationAlreadyAnswered') as (
          channelId: string,
          candidate: AgentDelegationEnvelope,
        ) => Promise<boolean>
      ).bind(body);

      await expect(alreadyAnswered('parent-channel', envelope)).resolves.toBe(true);
      expect(queryEvents).toHaveBeenCalledWith([
        expect.objectContaining({
          authors: [target.publicKey],
          '#h': ['parent-channel'],
          '#t': ['buzz-agent-delegation'],
        }),
      ]);
    } finally {
      await body.dispose();
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('visibly refuses a delegation when the root human fails this agent policy', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'buzzy-room-delegation-policy-'));
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
      accessPolicy: 'allowlist',
      accessAllowlist: ['f'.repeat(64)],
    });
    try {
      const source = newIdentity('policy-source');
      const envelope = {
        rootRequestId: 'a'.repeat(64),
        rootHumanPubkey: human.publicKey,
        fromAgentId: source.publicKey,
        toAgentIds: [body.agent.publicKey],
        sourceEventId: 'a'.repeat(64),
        hop: 1,
        dedupe: 'b'.repeat(64),
      } satisfies AgentDelegationEnvelope;
      const delegated = requestEvent([['p', body.agent.publicKey]], source, '@agent do the work');
      Reflect.set(
        body,
        'roomAuthorAttributions',
        vi.fn(
          async () =>
            new Map([[source.publicKey, { kind: 'Agent', name: 'Source', handle: 'source' }]]),
        ),
      );
      Reflect.set(
        body,
        'requestAlreadyOpened',
        vi.fn(async () => false),
      );
      Reflect.set(
        body,
        'validateAgentDelegationEnvelope',
        vi.fn(async () => envelope),
      );
      Reflect.set(
        body,
        'agentDelegationAlreadyAnswered',
        vi.fn(async () => false),
      );
      Reflect.set(
        body,
        'channelCommunityId',
        vi.fn(async () => undefined),
      );
      const refusal = vi.fn(async () => undefined);
      Reflect.set(body, 'postDelegationStatus', refusal);
      const registry = signEvent(
        {
          pubkey: source.publicKey,
          created_at: 1,
          kind: 9,
          tags: [['t', TAG_AGENT]],
          content: '',
        },
        source.secretKey,
      );
      Reflect.set(body, 'agentRelay', {
        queryEvents: vi.fn(async () => [registry]),
      });
      const processChannelRequestEvents = (
        Reflect.get(body, 'processChannelRequestEvents') as (...args: unknown[]) => Promise<number>
      ).bind(body);

      await processChannelRequestEvents(
        'parent-channel',
        { repo: 'repo' },
        'repository',
        [delegated],
        [human.publicKey, source.publicKey, body.agent.publicKey],
      );

      expect(refusal).toHaveBeenCalledWith(
        'parent-channel',
        delegated.id,
        envelope.rootRequestId,
        human.publicKey,
        'refused',
        expect.stringContaining('root human is not permitted'),
        envelope.rootRequestId,
        envelope.dedupe,
      );
    } finally {
      await body.dispose();
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('forces a delegated corner request through approval even for a direct-open human', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'buzzy-room-delegation-corner-'));
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
    try {
      const request = {
        eventId: 'c'.repeat(64),
        authorPubkey: human.publicKey,
        content: 'open a corner and implement the change',
        createdAt: 1,
        delegation: {
          rootRequestId: 'd'.repeat(64),
          rootHumanPubkey: human.publicKey,
          fromAgentId: 'e'.repeat(64),
          toAgentIds: [body.agent.publicKey],
          sourceEventId: 'd'.repeat(64),
          hop: 1,
          dedupe: 'f'.repeat(64),
        },
      } satisfies ChannelTaskRequest;
      Reflect.set(
        body,
        'requesterCanOpenCornerDirectly',
        vi.fn(async () => true),
      );
      Reflect.set(
        body,
        'channelCommunityId',
        vi.fn(async () => 'workspace'),
      );
      const approval = vi.fn(async () => undefined);
      Reflect.set(body, 'requestCornerApproval', approval);
      const replyInRoom = (
        Reflect.get(body, 'replyInRoom') as (...args: unknown[]) => Promise<RoomReplyOutcome>
      ).bind(body);

      await expect(
        replyInRoom(
          'parent-channel',
          { repo: 'repo' },
          request,
          true,
          'repository',
          undefined,
          true,
        ),
      ).resolves.toEqual({ openedCorner: false, producedReply: true });
      expect(approval).toHaveBeenCalledWith(
        expect.objectContaining({
          request: expect.objectContaining({ authorPubkey: human.publicKey }),
        }),
      );
    } finally {
      await body.dispose();
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('uses the read-only Room session and publishes one durable assistant message', async () => {
    const body = new Body({
      agentBinary: '/nonexistent',
      mcpBinary: '/nonexistent',
      agentEnv: {},
      workspaceRoot: mkdtempSync(join(tmpdir(), 'buzzy-room-reply-unit-')),
      relayBaseUrl: 'http://relay.test',
      relayHost: 'relay.test',
      relayScheme: 'http',
      relayWsUrl: 'ws://relay.test',
      autoApprovePermissions: true,
    });
    stubEmptyAgentHistory(body);
    vi.spyOn(body as never, 'requesterCanOpenCornerDirectly' as never).mockResolvedValue(
      true as never,
    );
    const client = new AcpClient({ agentBinary: '/nonexistent', agentEnv: {} });
    const prompt = vi.spyOn(client, 'sessionPrompt').mockResolvedValue({
      stopReason: 'end_turn',
      updates: [],
      agentText:
        'Warning: Skill descriptions were shortened to fit the 2% skills context budget. Codex can still see every skill by reading its SKILL.md.\n\nDoing well. What are you thinking about?',
      toolCalls: [],
    });
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
    const event = requestEvent([['p', body.agent.publicKey]]);

    await Reflect.get(body, 'replyInRoom').call(
      body,
      'parent-channel',
      { repo: 'repo' },
      {
        eventId: event.id,
        authorPubkey: event.pubkey,
        content: "Hey, what's up?",
        createdAt: event.created_at,
      },
    );

    expect(prompt).toHaveBeenCalledWith(
      'readonly-session',
      expect.stringContaining("Hey, what's up?"),
      ROOM_AGENT_PROMPT_TIMEOUT_MS,
      expect.any(Function),
      expect.any(Function),
    );
    expect(body.listSessions()).toHaveLength(1);
    expect(published).toHaveLength(3);
    expect(published[0]).toMatchObject({
      kind: 9,
      content: expect.stringContaining('thinking'),
    });
    expect(published[0]!.tags).toContainEqual(['t', 'agent-turn']);
    expect(published[0]!.tags).toContainEqual(['status', 'working']);
    expect(published[1]).toMatchObject({
      kind: 9,
      content: 'Doing well. What are you thinking about?',
    });
    expect(published[1]!.tags).toContainEqual(['h', 'parent-channel']);
    expect(published[1]!.tags).toContainEqual(['t', 'agent-message']);
    expect(published[2]!.tags).toContainEqual(['t', 'agent-turn']);
    expect(published[2]!.tags).toContainEqual(['status', 'complete']);

    prompt
      .mockResolvedValueOnce({
        stopReason: 'end_turn',
        updates: [],
        agentText: '',
        toolCalls: [],
      })
      .mockResolvedValueOnce({
        stopReason: 'end_turn',
        updates: [],
        agentText: "It looks like the other agent's adapter returned an empty turn.",
        toolCalls: [],
      });
    await Reflect.get(body, 'replyInRoom').call(
      body,
      'parent-channel',
      { repo: 'repo' },
      {
        eventId: 'empty-conversation-result',
        authorPubkey: event.pubkey,
        content: 'What do you think about that response?',
        createdAt: event.created_at + 1,
      },
    );

    expect(
      published.slice(-2).map((item) => item.tags.find((tag) => tag[0] === 'status')?.[1]),
    ).toEqual(['working', 'complete']);
    expect(prompt).toHaveBeenLastCalledWith(
      'readonly-session',
      expect.stringContaining('What do you think about that response?'),
      ROOM_AGENT_PROMPT_TIMEOUT_MS,
      expect.any(Function),
      expect.any(Function),
    );

    prompt
      .mockResolvedValueOnce({
        stopReason: 'end_turn',
        updates: [],
        agentText: '',
        toolCalls: [],
      })
      .mockResolvedValueOnce({
        stopReason: 'end_turn',
        updates: [],
        agentText: '',
        toolCalls: [],
      });
    await Reflect.get(body, 'replyInRoom').call(
      body,
      'parent-channel',
      { repo: 'repo' },
      {
        eventId: 'twice-empty-conversation-result',
        authorPubkey: event.pubkey,
        content: 'What do you think?',
        createdAt: event.created_at + 2,
      },
    );

    expect(
      published.some((item) => item.content.includes("couldn't produce a response")),
    ).toBe(false);

    prompt.mockRejectedValueOnce(new Error('prompt cancelled'));
    await expect(
      Reflect.get(body, 'replyInRoom').call(
        body,
        'parent-channel',
        { repo: 'repo' },
        {
          eventId: 'cancelled-research-result',
          authorPubkey: event.pubkey,
          content: 'Research this, but cancel the turn.',
          createdAt: event.created_at + 3,
        },
      ),
    ).resolves.toEqual({ openedCorner: false, producedReply: false });
    expect(
      published.slice(-2).map((item) => item.tags.find((tag) => tag[0] === 'status')?.[1]),
    ).toEqual(['working', 'complete']);
    expect(published.some((item) => item.content.includes("won't retry it without another message"))).toBe(false);
  });

  it('publishes and then honestly replaces a Room receipt before cold provisioning starts', async () => {
    const body = new Body({
      agentBinary: '/nonexistent',
      mcpBinary: '/nonexistent',
      agentEnv: {},
      workspaceRoot: '/tmp/buzzy-room-instant-receipt',
      relayBaseUrl: 'http://relay.test',
      relayHost: 'relay.test',
      relayScheme: 'http',
      relayWsUrl: 'ws://relay.test',
      autoApprovePermissions: true,
    });
    const order: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        const event = JSON.parse(String(init?.body)) as NostrEvent;
        if (event.tags.some((tag) => tag[0] === 't' && tag[1] === 'agent-turn')) {
          order.push(`receipt:${event.tags.find((tag) => tag[0] === 'status')?.[1]}`);
        }
        return new Response(JSON.stringify({ accepted: true }), { status: 200 });
      }),
    );
    vi.spyOn(body as never, 'provision' as never).mockImplementation((async () => {
      order.push('spawn');
      throw new Error('adapter could not start');
    }) as never);
    const event = requestEvent([['p', body.agent.publicKey]], undefined, 'Are you alive?');

    await expect(
      Reflect.get(body, 'replyInRoom').call(
        body,
        'cold-room',
        { repo: 'repo' },
        {
          eventId: event.id,
          authorPubkey: event.pubkey,
          content: event.content,
          createdAt: event.created_at,
        },
      ),
    ).rejects.toThrow('adapter could not start');

    expect(order).toEqual(['receipt:working', 'spawn', 'receipt:complete']);
  });

  it('recycles the read-only ACP generation after a handled edit permission', async () => {
    const body = new Body({
      agentBinary: '/nonexistent',
      mcpBinary: '/nonexistent',
      agentEnv: {},
      workspaceRoot: mkdtempSync(join(tmpdir(), 'buzzy-room-permission-recycle-unit-')),
      relayBaseUrl: 'http://relay.test',
      relayHost: 'relay.test',
      relayScheme: 'http',
      relayWsUrl: 'ws://relay.test',
      autoApprovePermissions: true,
    });
    stubEmptyAgentHistory(body);
    const scheduler = Reflect.get(body, 'scheduler') as {
      suspend: (channelId: string) => Promise<void>;
    };
    const suspend = vi.spyOn(scheduler, 'suspend').mockResolvedValue();
    const client = new AcpClient({ agentBinary: '/nonexistent', agentEnv: {} });
    vi.spyOn(client, 'sessionPrompt').mockImplementation(async () => {
      const turn = (
        Reflect.get(body, 'pendingRoomTurns') as Map<string, { permissionHandled: boolean }>
      ).get('parent-channel');
      if (!turn) throw new Error('expected a pending Room turn');
      turn.permissionHandled = true;
      return {
        stopReason: 'end_turn',
        updates: [],
        agentText: 'Editing was not allowed, so I stayed read-only.',
        toolCalls: [],
      };
    });
    body.registerSession({
      channelId: 'parent-channel',
      sessionId: 'readonly-session',
      client,
      mode: 'readonly',
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ accepted: true }), {
            status: 200,
          }),
      ),
    );

    await expect(
      Reflect.get(body, 'replyInRoom').call(
        body,
        'parent-channel',
        { repo: 'repo' },
        {
          eventId: 'permission-request',
          authorPubkey: human.publicKey,
          content: 'Take care of the requested repository task.',
          createdAt: 1,
        },
      ),
    ).resolves.toEqual({ openedCorner: false, producedReply: true });

    expect(suspend).toHaveBeenCalledOnce();
    expect(suspend).toHaveBeenCalledWith('parent-channel');
  });

  it('opens explicitly authorized corner work without prompting the read-only session', async () => {
    const body = new Body({
      agentBinary: '/nonexistent',
      mcpBinary: '/nonexistent',
      agentEnv: {},
      workspaceRoot: '/tmp/buzzy-explicit-corner-unit',
      relayBaseUrl: 'http://relay.test',
      relayHost: 'relay.test',
      relayScheme: 'http',
      relayWsUrl: 'ws://relay.test',
      autoApprovePermissions: true,
    });
    stubEmptyAgentHistory(body);
    vi.spyOn(body as never, 'requesterCanOpenCornerDirectly' as never).mockResolvedValue(
      true as never,
    );
    const client = new AcpClient({ agentBinary: '/nonexistent', agentEnv: {} });
    const prompt = vi.spyOn(client, 'sessionPrompt');
    body.registerSession({
      channelId: 'parent-channel',
      sessionId: 'readonly-session',
      client,
      mode: 'readonly',
    });
    const request = {
      eventId: 'explicit-corner-request',
      authorPubkey: human.publicKey,
      content: 'open a new corner to do work: add a FEATURE.md',
      createdAt: 1,
    };
    const editClient = new AcpClient({ agentBinary: '/nonexistent', agentEnv: {} });
    const info = {
      subchannelId: 'corner-id',
      worktreePath: '/tmp/worktree',
      featureBranch: 'feature/corner',
      role: body.agent,
      taskDescription: 'add a FEATURE.md',
      session: {
        channelId: 'corner-id',
        sessionId: 'edit-session',
        client: editClient,
        mode: 'edit' as const,
      },
      lastPolledAt: 1,
      archived: false,
    };
    const open = vi.spyOn(body, 'openSubchannel').mockResolvedValue(info);
    const start = vi
      .spyOn(body as never, 'startAgentTask' as never)
      .mockImplementation(() => undefined as never);

    await expect(
      Reflect.get(body, 'replyInRoom').call(
        body,
        'parent-channel',
        { repo: 'repo' },
        request,
        true,
      ),
    ).resolves.toEqual({ openedCorner: true, producedReply: true });

    expect(open).toHaveBeenCalledWith(
      'parent-channel',
      { repo: 'repo' },
      request.content,
      request,
      expect.objectContaining({ onCreated: expect.any(Function) }),
    );
    expect(start).toHaveBeenCalledWith(
      info,
      request.content,
      cornerOpenTaskPrompt(info.taskDescription, request.content),
      {
        cause: 'corner-opening',
        originalRequestId: request.eventId,
        requestId: request.eventId,
      },
    );
    expect(prompt).not.toHaveBeenCalled();
  });

  it('seeds an explicitly opened corner with the bounded task objective, not Room chatter', async () => {
    const body = new Body({
      agentBinary: '/nonexistent',
      mcpBinary: '/nonexistent',
      agentEnv: {},
      workspaceRoot: '/tmp/buzzy-explicit-corner-context-unit',
      relayBaseUrl: 'http://relay.test',
      relayHost: 'relay.test',
      relayScheme: 'http',
      relayWsUrl: 'ws://relay.test',
      autoApprovePermissions: true,
    });
    stubEmptyAgentHistory(body);
    vi.spyOn(body as never, 'requesterCanOpenCornerDirectly' as never).mockResolvedValue(
      true as never,
    );
    const client = new AcpClient({ agentBinary: '/nonexistent', agentEnv: {} });
    body.registerSession({
      channelId: 'parent-channel',
      sessionId: 'readonly-session',
      client,
      mode: 'readonly',
    });
    const request = {
      eventId: 'explicit-corner-request',
      authorPubkey: human.publicKey,
      content: 'open a corner',
      createdAt: 1,
    };
    const editClient = new AcpClient({ agentBinary: '/nonexistent', agentEnv: {} });
    const info = {
      subchannelId: 'corner-id',
      worktreePath: '/tmp/worktree',
      featureBranch: 'feature/corner',
      role: body.agent,
      taskDescription: 'add retry logic to the sync loop',
      session: {
        channelId: 'corner-id',
        sessionId: 'edit-session',
        client: editClient,
        mode: 'edit' as const,
      },
      lastPolledAt: 1,
      archived: false,
    };
    vi.spyOn(body, 'openSubchannel').mockResolvedValue(info);
    const start = vi
      .spyOn(body as never, 'startAgentTask' as never)
      .mockImplementation(() => undefined as never);

    await expect(
      Reflect.get(body, 'replyInRoom').call(
        body,
        'parent-channel',
        { repo: 'repo' },
        request,
        true,
      ),
    ).resolves.toEqual({ openedCorner: true, producedReply: true });

    expect(start).toHaveBeenCalledOnce();
    const taskInstructions = (start.mock.calls[0] as unknown[])[2] as string;
    expect(taskInstructions).toContain('add retry logic to the sync loop');
    expect(taskInstructions).toContain('Message that opened this corner:');
    expect(taskInstructions).toContain(request.content);
    expect(taskInstructions).not.toContain('unrelated lunch plans');
    expect(taskInstructions).not.toContain('Recent Room transcript');

    await rm('/tmp/buzzy-explicit-corner-context-unit', { recursive: true, force: true });
  });

  it('creates exactly one corner when the same mention event is processed concurrently (WS-push + backstop-poll race)', async () => {
    await rm('/tmp/buzzy-corner-dedup-unit', { recursive: true, force: true });
    const body = new Body({
      agentBinary: '/nonexistent',
      mcpBinary: '/nonexistent',
      agentEnv: {},
      workspaceRoot: '/tmp/buzzy-corner-dedup-unit',
      relayBaseUrl: 'http://relay.test',
      relayHost: 'relay.test',
      relayScheme: 'http',
      relayWsUrl: 'ws://relay.test',
      autoApprovePermissions: true,
    });
    // Every relay-backed idempotency check (requestAlreadyOpened, author
    // attribution lookups, registered-agent lookup) sees no prior state, the
    // worst case for a real relay round-trip that hasn't converged yet.
    Reflect.set(body, 'agentRelay', { queryEvents: vi.fn(async () => []) });
    vi.spyOn(body as never, 'requesterCanOpenCornerDirectly' as never).mockResolvedValue(
      true as never,
    );
    const editClient = new AcpClient({ agentBinary: '/nonexistent', agentEnv: {} });
    const info = {
      subchannelId: 'corner-id',
      worktreePath: '/tmp/worktree',
      featureBranch: 'feature/corner',
      role: body.agent,
      session: {
        channelId: 'corner-id',
        sessionId: 'edit-session',
        client: editClient,
        mode: 'edit' as const,
      },
      lastPolledAt: 1,
      archived: false,
    };
    const open = vi.spyOn(body, 'openSubchannel').mockResolvedValue(info);
    const start = vi
      .spyOn(body as never, 'startAgentTask' as never)
      .mockImplementation(() => undefined as never);

    const event = requestEvent(
      [['p', body.agent.publicKey]],
      human,
      'open a new corner to do work: add a FEATURE.md',
    );
    const processChannelRequestEvents = (
      Reflect.get(body, 'processChannelRequestEvents') as (...args: unknown[]) => Promise<number>
    ).bind(body);
    const roomParticipants = [human.publicKey, body.agent.publicKey];

    // The same relay event, handed to the same processing method twice at
    // once: this is exactly what happens when the instant WS-push delivery
    // and the HTTP backstop poll fired right after subscribe (runRoomPushLoop)
    // both observe the mention before either has finished handling it.
    await Promise.all([
      processChannelRequestEvents(
        'parent-channel',
        { repo: 'repo' },
        'repository',
        [event],
        roomParticipants,
      ),
      processChannelRequestEvents(
        'parent-channel',
        { repo: 'repo' },
        'repository',
        [event],
        roomParticipants,
      ),
    ]);

    expect(open).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledTimes(1);

    await rm('/tmp/buzzy-corner-dedup-unit', { recursive: true, force: true });
  });

  it('never retries a stalled backend without a new user message', async () => {
    const body = new Body({
      agentBinary: '/nonexistent',
      mcpBinary: '/nonexistent',
      agentEnv: {},
      workspaceRoot: '/tmp/buzzy-stall-retry-cap-unit',
      relayBaseUrl: 'http://relay.test',
      relayHost: 'relay.test',
      relayScheme: 'http',
      relayWsUrl: 'ws://relay.test',
      autoApprovePermissions: true,
    });
    stubEmptyAgentHistory(body);
    // Every relay-backed idempotency check sees no prior state, matching the
    // worst case for a real relay round-trip that hasn't converged yet.
    Reflect.set(body, 'agentRelay', { queryEvents: vi.fn(async () => []) });
    const client = new AcpClient({ agentBinary: '/nonexistent', agentEnv: {} });
    const sessionPromptSpy = vi
      .spyOn(client, 'sessionPrompt')
      .mockRejectedValue(
        new Error(
          `ACP session/prompt timed out after ${ROOM_AGENT_PROMPT_TIMEOUT_MS}ms of inactivity`,
        ),
      );
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
    const event = requestEvent([['p', body.agent.publicKey]], human, 'What does this repo do?');
    const roomParticipants = [human.publicKey, body.agent.publicKey];
    const processChannelRequestEvents = (
      Reflect.get(body, 'processChannelRequestEvents') as (...args: unknown[]) => Promise<number>
    ).bind(body);

    // The one user-authored event gets one model attempt. A timeout is
    // terminal for that event: maintenance may report it, but never re-prompt.
    await expect(
      processChannelRequestEvents(
        'parent-channel',
        { repo: 'repo' },
        'repository',
        [event],
        roomParticipants,
      ),
    ).resolves.toBe(0);
    expect(sessionPromptSpy).toHaveBeenCalledTimes(1);
    expect(
      published.some((item) => item.content?.includes("won't retry it without another message")),
    ).toBe(false);

    // A later poll must not re-drive the backend a further time — the event
    // is terminally delivered, not endlessly retried.
    sessionPromptSpy.mockClear();
    await processChannelRequestEvents(
      'parent-channel',
      { repo: 'repo' },
      'repository',
      [event],
      roomParticipants,
    );
    expect(sessionPromptSpy).not.toHaveBeenCalled();

    await rm('/tmp/buzzy-stall-retry-cap-unit', { recursive: true, force: true });
  });

  it('opens an edit corner directly on the first mutating request', async () => {
    const body = new Body({
      agentBinary: '/nonexistent',
      mcpBinary: '/nonexistent',
      agentEnv: {},
      workspaceRoot: '/tmp/buzzy-room-permission-unit',
      relayBaseUrl: 'http://relay.test',
      relayHost: 'relay.test',
      relayScheme: 'http',
      relayWsUrl: 'ws://relay.test',
      autoApprovePermissions: true,
    });
    vi.spyOn(body as never, 'requesterCanOpenCornerDirectly' as never).mockResolvedValue(
      true as never,
    );
    const request = {
      eventId: 'human-request',
      authorPubkey: human.publicKey,
      content: 'Create a file and commit it.',
      createdAt: 1,
    };
    const turn = {
      request,
      boundRepo: { repo: 'repo' },
      permissionHandled: false,
      transitionedToCorner: false,
      readOnlyInformationRequest: false,
    };
    (Reflect.get(body, 'pendingRoomTurns') as Map<string, unknown>).set('parent-channel', turn);
    const wait = vi.spyOn(body as never, 'waitForWritePermissionDecision' as never);
    const editClient = new AcpClient({ agentBinary: '/nonexistent', agentEnv: {} });
    const info = {
      subchannelId: 'corner-id',
      worktreePath: '/tmp/worktree',
      featureBranch: 'feature/corner',
      role: body.agent,
      taskDescription: request.content,
      session: {
        channelId: 'corner-id',
        sessionId: 'edit-session',
        client: editClient,
        mode: 'edit' as const,
      },
      lastPolledAt: 1,
      archived: false,
    };
    const open = vi.spyOn(body, 'openSubchannel').mockResolvedValue(info);
    const start = vi
      .spyOn(body as never, 'startAgentTask' as never)
      .mockImplementation(() => undefined as never);
    const published: NostrEvent[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        published.push(JSON.parse(String(init?.body)) as NostrEvent);
        return new Response(JSON.stringify({ accepted: true }), { status: 200 });
      }),
    );

    await expect(
      Reflect.get(body, 'handleRoomPermissionRequest').call(body, 'parent-channel', {
        sessionId: 'readonly-session',
        toolCall: { kind: 'edit', title: 'str_replace README.md' },
      }),
    ).resolves.toBe('reject');

    expect(open).toHaveBeenCalledWith(
      'parent-channel',
      { repo: 'repo' },
      request.content,
      request,
      expect.objectContaining({ onCreated: expect.any(Function) }),
    );
    // A corner reached through write-permission escalation gets the same
    // bounded objective/opening-request brief as an explicitly opened corner.
    expect(start).toHaveBeenCalledWith(
      info,
      request.content,
      expect.stringContaining('Bounded task objective:'),
      {
        cause: 'corner-opening',
        originalRequestId: request.eventId,
        requestId: request.eventId,
      },
    );
    expect(start.mock.calls[0]![2]).toContain(request.content);
    expect(start.mock.calls[0]![2]).not.toContain('Recent Room transcript');
    expect(turn.transitionedToCorner).toBe(true);
    expect(wait).not.toHaveBeenCalled();
    expect(
      published.some((event) =>
        event.tags.some((tag) => tag[0] === 't' && tag[1] === 'buzz-write-permission-request'),
      ),
    ).toBe(false);
  });

  it('keeps DMs strictly read-only without publishing an edit-permission prompt', async () => {
    const body = new Body({
      agentBinary: '/nonexistent',
      mcpBinary: '/nonexistent',
      agentEnv: {},
      workspaceRoot: '/tmp/buzzy-dm-readonly-unit',
      relayBaseUrl: 'http://relay.test',
      relayHost: 'relay.test',
      relayScheme: 'http',
      relayWsUrl: 'ws://relay.test',
      autoApprovePermissions: true,
    });
    const turn = {
      request: {
        eventId: 'dm-edit-request',
        authorPubkey: human.publicKey,
        content: 'Edit lunchboxfortwo/buzzy.',
        createdAt: 1,
      },
      editPolicy: 'direct-message',
      permissionHandled: false,
      transitionedToCorner: false,
      readOnlyInformationRequest: false,
    };
    (Reflect.get(body, 'pendingRoomTurns') as Map<string, unknown>).set('dm-channel', turn);
    const open = vi.spyOn(body, 'openSubchannel');
    const wait = vi.spyOn(body as never, 'waitForWritePermissionDecision' as never);
    const publish = vi.fn();
    vi.stubGlobal('fetch', publish);

    await expect(
      Reflect.get(body, 'handleRoomPermissionRequest').call(
        body,
        'dm-channel',
        {
          toolCall: {
            kind: 'execute',
            title: 'Run shell',
            rawInput: {
              command: 'beeline-request-edit-corner --repo lunchboxfortwo/buzzy',
            },
          },
        },
        'direct-message',
      ),
    ).resolves.toBe('reject');

    expect(open).not.toHaveBeenCalled();
    expect(wait).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
    expect(turn.permissionHandled).toBe(false);
    expect(roomEditPolicyInstructions('direct-message').join(' ')).toContain('strictly read-only');
  });

  it('answers DM edit requests without starting ACP or suggesting an approval path', async () => {
    const body = new Body({
      agentBinary: '/nonexistent',
      mcpBinary: '/nonexistent',
      agentEnv: {},
      workspaceRoot: '/tmp/buzzy-dm-edit-answer-unit',
      relayBaseUrl: 'http://relay.test',
      relayHost: 'relay.test',
      relayScheme: 'http',
      relayWsUrl: 'ws://relay.test',
      autoApprovePermissions: true,
    });
    stubEmptyAgentHistory(body);
    vi.spyOn(body as never, 'requesterCanOpenCornerDirectly' as never).mockResolvedValue(
      true as never,
    );
    const provision = vi.spyOn(body, 'provision');
    const open = vi.spyOn(body, 'openSubchannel');
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
        'dm-channel',
        undefined,
        {
          eventId: 'dm-edit-answer',
          authorPubkey: human.publicKey,
          content: 'Append DM-EDIT-PROOF to README.md now.',
          createdAt: 1,
        },
        false,
        'direct-message',
      ),
    ).resolves.toEqual({ openedCorner: false, producedReply: true });

    expect(isRepositoryMutationRequest('Append DM-EDIT-PROOF to README.md now.')).toBe(true);
    expect(provision).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    expect(published).toHaveLength(0);
  });

  it('retries only transient write-permission polling failures', () => {
    expect(isTransientPermissionPollError(new Error('HTTP 429 quota exceeded'))).toBe(true);
    expect(isTransientPermissionPollError(new Error('HTTP 503 unavailable'))).toBe(true);
    expect(isTransientPermissionPollError(new Error('fetch failed'))).toBe(true);
    expect(isTransientPermissionPollError(new Error('HTTP 403 forbidden'))).toBe(false);
    expect(isTransientPermissionPollError(new Error('invalid signature'))).toBe(false);
  });

  function memberProjection(roomId: string, pubkeys: string[]): NostrEvent {
    return signEvent(
      {
        pubkey: human.publicKey,
        created_at: 1_700_000_000,
        kind: 39002,
        tags: [['d', roomId], ...pubkeys.map((pubkey) => ['p', pubkey])],
        content: '',
      },
      human.secretKey,
    );
  }

  function routeWritePermissionQuery(
    filter: Record<string, unknown>,
    roomId: string,
    onWritePermissionQuery: () => NostrEvent[],
  ): Response {
    const kinds = (filter.kinds as number[] | undefined) ?? [];
    if (kinds.includes(39002)) {
      return new Response(JSON.stringify([memberProjection(roomId, [human.publicKey])]), {
        status: 200,
      });
    }
    if (kinds.includes(39001)) return new Response(JSON.stringify([]), { status: 200 });
    // isRegisteredAgentIdentity's query is the only one filtering by `authors`.
    if (filter.authors) return new Response(JSON.stringify([]), { status: 200 });
    if ((filter['#t'] as string[] | undefined)?.includes(WRITE_PERMISSION_RESPONSE_TAG)) {
      return new Response(JSON.stringify(onWritePermissionQuery()), { status: 200 });
    }
    return new Response(JSON.stringify([]), { status: 200 });
  }

  it('resolves a write-permission decision pushed over the Room WS without waiting on the backstop poll', async () => {
    const roomId = 'wp-ws-room';
    const permissionId = 'perm-ws-1';
    const requestId = 'req-ws-1';
    const repository = 'repo';
    const body = new Body(
      {
        agentBinary: '/nonexistent',
        mcpBinary: '/nonexistent',
        agentEnv: {},
        workspaceRoot: '/tmp/buzzy-write-permission-ws-unit',
        relayBaseUrl: 'http://relay.test',
        relayHost: 'relay.test',
        relayScheme: 'http',
        relayWsUrl: 'ws://relay.test',
        autoApprovePermissions: true,
      },
      undefined,
      agent,
    );

    let backstopQueries = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        const filter = (JSON.parse(String(init?.body)) as Record<string, unknown>[])[0]!;
        return routeWritePermissionQuery(filter, roomId, () => {
          backstopQueries += 1;
          return []; // The WS push below should win before any decision ever appears here.
        });
      }),
    );

    let capturedHandler: ((event: NostrEvent) => void) | undefined;
    const unsubscribe = vi.fn();
    const fakeSocket = {
      connected: true,
      subscribe: vi.fn((_filters: unknown, onEvent: (event: NostrEvent) => void) => {
        capturedHandler = onEvent;
        return unsubscribe;
      }),
    };
    (Reflect.get(body, 'roomSockets') as Map<string, unknown>).set(roomId, {
      socket: fakeSocket,
    });

    const decisionPromise = Reflect.get(body, 'waitForWritePermissionDecision').call(
      body,
      roomId,
      permissionId,
      requestId,
      repository,
    ) as Promise<'allow' | 'deny' | 'timeout'>;

    expect(fakeSocket.subscribe).toHaveBeenCalledOnce();
    expect(capturedHandler).toBeDefined();

    capturedHandler!(
      signEvent(
        {
          pubkey: human.publicKey,
          created_at: Math.floor(Date.now() / 1000),
          kind: 9,
          tags: [
            ['h', roomId],
            ['t', WRITE_PERMISSION_RESPONSE_TAG],
            ['permission', permissionId],
            ['request', requestId],
            ['decision', 'allow'],
            ['repo', repository],
            ['p', body.agent.publicKey],
          ],
          content: 'Allowed editing.',
        },
        human.secretKey,
      ),
    );

    await expect(decisionPromise).resolves.toBe('allow');
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(backstopQueries).toBeLessThanOrEqual(1);
  });

  it('refuses an agent-signed corner approval and waits for a human decision', async () => {
    const roomId = 'agent-approval-refused-room';
    const permissionId = 'agent-approval-refused-permission';
    const requestId = 'agent-approval-refused-request';
    const repository = 'repo';
    const body = new Body(
      {
        agentBinary: '/nonexistent',
        mcpBinary: '/nonexistent',
        agentEnv: {},
        workspaceRoot: '/tmp/buzzy-agent-approval-refused-unit',
        relayBaseUrl: 'http://relay.test',
        relayHost: 'relay.test',
        relayScheme: 'http',
        relayWsUrl: 'ws://relay.test',
        autoApprovePermissions: true,
      },
      undefined,
      agent,
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        const filter = (JSON.parse(String(init?.body)) as Record<string, unknown>[])[0]!;
        return routeWritePermissionQuery(filter, roomId, () => []);
      }),
    );

    let capturedHandler: ((event: NostrEvent) => void) | undefined;
    const fakeSocket = {
      connected: true,
      subscribe: vi.fn((_filters: unknown, onEvent: (event: NostrEvent) => void) => {
        capturedHandler = onEvent;
        return vi.fn();
      }),
    };
    (Reflect.get(body, 'roomSockets') as Map<string, unknown>).set(roomId, {
      socket: fakeSocket,
    });

    let settled = false;
    const decisionPromise = (
      Reflect.get(body, 'waitForWritePermissionDecision').call(
        body,
        roomId,
        permissionId,
        requestId,
        repository,
      ) as Promise<'allow' | 'deny' | 'timeout'>
    ).then((decision) => {
      settled = true;
      return decision;
    });
    const decisionEvent = (author: typeof agent, decision: 'allow' | 'deny') =>
      signEvent(
        {
          pubkey: author.publicKey,
          created_at: Math.floor(Date.now() / 1000),
          kind: 9,
          tags: [
            ['h', roomId],
            ['t', WRITE_PERMISSION_RESPONSE_TAG],
            ['permission', permissionId],
            ['request', requestId],
            ['decision', decision],
            ['repo', repository],
            ['p', body.agent.publicKey],
          ],
          content: decision === 'allow' ? 'Allowed editing.' : 'Denied editing.',
        },
        author.secretKey,
      );

    capturedHandler!(decisionEvent(agent, 'allow'));
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);

    capturedHandler!(decisionEvent(human, 'deny'));
    await expect(decisionPromise).resolves.toBe('deny');
  });

  it('falls back to the low-rate HTTP backstop poll when no Room WS is available', async () => {
    vi.useFakeTimers();
    const roomId = 'wp-poll-room';
    const permissionId = 'perm-poll-1';
    const requestId = 'req-poll-1';
    const repository = 'repo';
    const body = new Body(
      {
        agentBinary: '/nonexistent',
        mcpBinary: '/nonexistent',
        agentEnv: {},
        workspaceRoot: '/tmp/buzzy-write-permission-poll-unit',
        relayBaseUrl: 'http://relay.test',
        relayHost: 'relay.test',
        relayScheme: 'http',
        relayWsUrl: 'ws://relay.test',
        autoApprovePermissions: true,
      },
      undefined,
      agent,
    );

    let decisionPublished = false;
    let backstopQueries = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        const filter = (JSON.parse(String(init?.body)) as Record<string, unknown>[])[0]!;
        return routeWritePermissionQuery(filter, roomId, () => {
          backstopQueries += 1;
          if (!decisionPublished) return [];
          return [
            signEvent(
              {
                pubkey: human.publicKey,
                created_at: Math.floor(Date.now() / 1000),
                kind: 9,
                tags: [
                  ['h', roomId],
                  ['t', WRITE_PERMISSION_RESPONSE_TAG],
                  ['permission', permissionId],
                  ['request', requestId],
                  ['decision', 'allow'],
                  ['repo', repository],
                  ['p', body.agent.publicKey],
                ],
                content: 'Allowed editing.',
              },
              human.secretKey,
            ),
          ];
        });
      }),
    );

    // No `roomSockets` entry for this Room: this is the correctness backstop
    // path (mirrors `room-conversation.live.test.ts`, which drives Body via
    // `pollChannelRequests` and never establishes `runRoomPushLoop`'s WS).
    const decisionPromise = Reflect.get(body, 'waitForWritePermissionDecision').call(
      body,
      roomId,
      permissionId,
      requestId,
      repository,
    ) as Promise<'allow' | 'deny' | 'timeout'>;

    await vi.advanceTimersByTimeAsync(0);
    expect(backstopQueries).toBe(1);

    decisionPublished = true;
    await vi.advanceTimersByTimeAsync(WRITE_PERMISSION_BACKSTOP_POLL_MS);

    await expect(decisionPromise).resolves.toBe('allow');
    expect(backstopQueries).toBeGreaterThanOrEqual(2);
    vi.useRealTimers();
  });

  it('lets a capable harness initiate the native permission flow for a plain mutation request', async () => {
    const body = new Body({
      agentBinary: '/nonexistent',
      agentCommand: 'codex-acp',
      mcpBinary: '/nonexistent',
      agentEnv: {},
      workspaceRoot: '/tmp/buzzy-direct-bound-request-unit',
      relayBaseUrl: 'http://relay.test',
      relayHost: 'relay.test',
      relayScheme: 'http',
      relayWsUrl: 'ws://relay.test',
      autoApprovePermissions: true,
    });
    stubEmptyAgentHistory(body);
    vi.spyOn(body as never, 'requesterCanOpenCornerDirectly' as never).mockResolvedValue(
      true as never,
    );
    const client = new AcpClient({ agentCommand: 'codex-acp', agentEnv: {} });
    body.registerSession({
      channelId: 'parent-channel',
      sessionId: 'codex-readonly-session',
      client,
      mode: 'readonly',
    });
    vi.spyOn(body as never, 'waitForWritePermissionDecision' as never).mockResolvedValue(
      'allow' as never,
    );
    const editClient = new AcpClient({ agentBinary: '/nonexistent', agentEnv: {} });
    const info = {
      subchannelId: 'native-corner-id',
      worktreePath: '/tmp/native-corner-worktree',
      featureBranch: 'feature/native-corner',
      role: body.agent,
      session: {
        channelId: 'native-corner-id',
        sessionId: 'edit-session',
        client: editClient,
        mode: 'edit' as const,
      },
      lastPolledAt: 1,
      archived: false,
    };
    const open = vi.spyOn(body, 'openSubchannel').mockResolvedValue(info);
    const start = vi
      .spyOn(body as never, 'startAgentTask' as never)
      .mockImplementation(() => undefined as never);
    const permission = vi.spyOn(body as never, 'handleRoomPermissionRequest' as never);
    vi.spyOn(client, 'sessionPrompt').mockImplementation(async () => {
      await Reflect.get(body, 'handleRoomPermissionRequest').call(
        body,
        'parent-channel',
        {
          sessionId: 'codex-readonly-session',
          toolCall: { kind: 'edit', title: 'apply_patch PROOF.txt' },
        },
        'repository',
      );
      return {
        stopReason: 'end_turn',
        updates: [],
        agentText: 'I requested approval for the required edit.',
        toolCalls: [],
      };
    });
    const provision = vi.spyOn(body, 'provision');
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
        'parent-channel',
        { repo: 'buzzy', repositoryId: 'lunchboxfortwo/buzzy' },
        {
          eventId: 'direct-bound-request',
          authorPubkey: human.publicKey,
          content: 'Create PROOF.txt and commit it.',
          createdAt: 1,
        },
      ),
    ).resolves.toEqual({ openedCorner: true, producedReply: true });

    expect(permission).toHaveBeenCalledWith(
      'parent-channel',
      expect.objectContaining({
        toolCall: expect.objectContaining({
          title: 'apply_patch PROOF.txt',
        }),
      }),
      'repository',
    );
    expect(open).toHaveBeenCalledWith(
      'parent-channel',
      { repo: 'buzzy', repositoryId: 'lunchboxfortwo/buzzy' },
      'Create PROOF.txt and commit it.',
      expect.objectContaining({ eventId: 'direct-bound-request' }),
      expect.objectContaining({ onCreated: expect.any(Function) }),
    );
    expect(start).toHaveBeenCalledWith(
      info,
      'Create PROOF.txt and commit it.',
      expect.stringContaining('Create PROOF.txt and commit it.'),
      expect.objectContaining({ cause: 'corner-opening' }),
    );
    expect(
      published.filter((event) =>
        event.tags.some((tag) => tag[0] === 't' && tag[1] === 'buzz-write-permission-request'),
      ),
    ).toHaveLength(0);
    expect(published.every((event) => !event.content.includes('CORNER_REQUEST'))).toBe(true);
    expect(provision).not.toHaveBeenCalled();
  });

  it('keeps a repo-less Room read-only when the agent does not name an exact target', async () => {
    const body = new Body({
      agentBinary: '/nonexistent',
      mcpBinary: '/nonexistent',
      agentEnv: {},
      workspaceRoot: '/tmp/buzzy-no-target-unit',
      relayBaseUrl: 'http://relay.test',
      relayHost: 'relay.test',
      relayScheme: 'http',
      relayWsUrl: 'ws://relay.test',
      autoApprovePermissions: true,
    });
    const turn = {
      request: {
        eventId: 'no-target-request',
        authorPubkey: human.publicKey,
        content: 'Please edit the code.',
        createdAt: 1,
      },
      editPolicy: 'named-repository',
      permissionHandled: false,
      transitionedToCorner: false,
      readOnlyInformationRequest: false,
    };
    (Reflect.get(body, 'pendingRoomTurns') as Map<string, unknown>).set('repo-less-room', turn);
    const open = vi.spyOn(body, 'openSubchannel');
    const publish = vi.fn();
    vi.stubGlobal('fetch', publish);

    await expect(
      Reflect.get(body, 'handleRoomPermissionRequest').call(
        body,
        'repo-less-room',
        { toolCall: { kind: 'edit', title: 'str_replace README.md' } },
        'named-repository',
      ),
    ).resolves.toBe('reject');

    expect(open).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
    expect(turn.permissionHandled).toBe(false);
  });

  it('lets a repo-less Room agent initiate the target-bound native permission request', async () => {
    const body = new Body({
      agentBinary: '/nonexistent',
      agentCommand: 'codex-acp',
      mcpBinary: '/nonexistent',
      agentEnv: {},
      workspaceRoot: mkdtempSync(join(tmpdir(), 'buzzy-direct-named-request-unit-')),
      relayBaseUrl: 'http://relay.test',
      relayHost: 'relay.test',
      relayScheme: 'http',
      relayWsUrl: 'ws://relay.test',
      autoApprovePermissions: true,
    });
    stubEmptyAgentHistory(body);
    vi.spyOn(body as never, 'cornerOpenAudience' as never).mockResolvedValue([
      human.publicKey,
    ] as never);
    const client = new AcpClient({ agentCommand: 'codex-acp', agentEnv: {} });
    body.registerSession({
      channelId: 'repo-less-room',
      sessionId: 'codex-named-readonly-session',
      client,
      mode: 'readonly',
    });
    vi.spyOn(body as never, 'waitForWritePermissionDecision' as never).mockResolvedValue(
      'deny' as never,
    );
    const permission = vi.spyOn(body as never, 'handleRoomPermissionRequest' as never);
    vi.spyOn(client, 'sessionPrompt').mockImplementation(async () => {
      await Reflect.get(body, 'handleRoomPermissionRequest').call(
        body,
        'repo-less-room',
        {
          sessionId: 'codex-named-readonly-session',
          toolCall: {
            kind: 'execute',
            title: 'beeline-request-edit-corner --repo lunchboxfortwo/buzzy',
            rawInput: {
              command: 'beeline-request-edit-corner --repo lunchboxfortwo/buzzy',
            },
          },
        },
        'named-repository',
      );
      return {
        stopReason: 'end_turn',
        updates: [],
        agentText: 'I requested human approval for that repository.',
        toolCalls: [],
      };
    });
    const provision = vi.spyOn(body, 'provision');
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
        'repo-less-room',
        undefined,
        {
          eventId: 'direct-named-request',
          authorPubkey: human.publicKey,
          content: 'Repo lunchboxfortwo/buzzy append PROOF to README.',
          createdAt: 1,
        },
        false,
        'named-repository',
      ),
    ).resolves.toEqual({ openedCorner: false, producedReply: true });

    expect(permission).toHaveBeenCalledWith(
      'repo-less-room',
      expect.objectContaining({
        toolCall: expect.objectContaining({
          rawInput: {
            command: 'beeline-request-edit-corner --repo lunchboxfortwo/buzzy',
          },
        }),
      }),
      'named-repository',
    );
    expect(
      published.some(
        (event) =>
          event.tags.some((tag) => tag[0] === 'status' && tag[1] === 'pending') &&
          event.tags.some((tag) => tag[0] === 'repo' && tag[1] === 'lunchboxfortwo/buzzy'),
      ),
    ).toBe(true);
    expect(provision).not.toHaveBeenCalled();
  });

  it('opens a repo-less Room corner only after target-bound human approval', async () => {
    const targetRepo = {
      repo: 'buzzy',
      repositoryId: 'lunchboxfortwo/buzzy',
      localPath: '/tmp/named-buzzy',
      remoteName: 'origin',
      targetBranch: 'refs/heads/main',
    };
    const resolveNamedRepository = vi.fn(async () => targetRepo);
    const body = new Body(
      {
        agentBinary: '/nonexistent',
        mcpBinary: '/nonexistent',
        agentEnv: {},
        workspaceRoot: '/tmp/buzzy-named-repo-unit',
        relayBaseUrl: 'http://relay.test',
        relayHost: 'relay.test',
        relayScheme: 'http',
        relayWsUrl: 'ws://relay.test',
        autoApprovePermissions: true,
      },
      undefined,
      undefined,
      undefined,
      { resolveNamedRepository },
    );
    vi.spyOn(body as never, 'cornerOpenAudience' as never).mockResolvedValue([
      human.publicKey,
    ] as never);
    const request = {
      eventId: 'named-repo-request',
      authorPubkey: human.publicKey,
      content: 'Edit lunchboxfortwo/buzzy.',
      createdAt: 1,
    };
    const turn = {
      request,
      editPolicy: 'named-repository',
      namedRepositoryTarget: {
        id: 'lunchboxfortwo/buzzy',
        owner: 'lunchboxfortwo',
        repo: 'buzzy',
        kind: 'github',
      },
      permissionHandled: false,
      transitionedToCorner: false,
      readOnlyInformationRequest: false,
    };
    (Reflect.get(body, 'pendingRoomTurns') as Map<string, unknown>).set('parent-channel', turn);
    vi.spyOn(body as never, 'waitForWritePermissionDecision' as never).mockResolvedValue(
      'allow' as never,
    );
    vi.spyOn(body, 'assertRepositorySafety').mockResolvedValue();
    const editClient = new AcpClient({ agentBinary: '/nonexistent', agentEnv: {} });
    const info = {
      subchannelId: 'named-corner-id',
      worktreePath: '/tmp/named-worktree',
      featureBranch: 'feature/named',
      role: body.agent,
      session: {
        channelId: 'named-corner-id',
        sessionId: 'edit-session',
        client: editClient,
        mode: 'edit' as const,
      },
      lastPolledAt: 1,
      archived: false,
    };
    const open = vi.spyOn(body, 'openSubchannel').mockResolvedValue(info);
    vi.spyOn(body as never, 'startAgentTask' as never).mockImplementation(() => undefined as never);
    const published: NostrEvent[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        published.push(JSON.parse(String(init?.body)) as NostrEvent);
        return new Response(JSON.stringify({ accepted: true }), { status: 200 });
      }),
    );

    await Reflect.get(body, 'handleRoomPermissionRequest').call(
      body,
      'parent-channel',
      {
        toolCall: {
          kind: 'edit',
          title: 'Apply patch to README.md',
          rawInput: { path: 'README.md' },
        },
      },
      'named-repository',
    );

    expect(resolveNamedRepository).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'lunchboxfortwo/buzzy', kind: 'github' }),
    );
    expect(open).toHaveBeenCalledWith('parent-channel', targetRepo, request.content, request);
    expect(turn.transitionedToCorner).toBe(true);
    expect(
      published.find((event) =>
        event.tags.some((tag) => tag[0] === 'status' && tag[1] === 'pending'),
      ),
    ).toMatchObject({ content: expect.stringContaining('lunchboxfortwo/buzzy') });
    expect(
      published.every((event) => {
        const status = event.tags.find((tag) => tag[0] === 'status')?.[1];
        return (
          !status ||
          event.tags.some((tag) => tag[0] === 'repo' && tag[1] === 'lunchboxfortwo/buzzy')
        );
      }),
    ).toBe(true);
  });

  it('fails closed before creating a corner when the approved repo cannot be cloned', async () => {
    const resolveNamedRepository = vi.fn(async () => {
      throw new Error(
        'repository inaccessible-owner/private-repo could not be cloned or accessed with the available credentials',
      );
    });
    const body = new Body(
      {
        agentBinary: '/nonexistent',
        mcpBinary: '/nonexistent',
        agentEnv: {},
        workspaceRoot: '/tmp/buzzy-named-repo-failure-unit',
        relayBaseUrl: 'http://relay.test',
        relayHost: 'relay.test',
        relayScheme: 'http',
        relayWsUrl: 'ws://relay.test',
        autoApprovePermissions: true,
      },
      undefined,
      undefined,
      undefined,
      { resolveNamedRepository },
    );
    vi.spyOn(body as never, 'cornerOpenAudience' as never).mockResolvedValue([
      human.publicKey,
    ] as never);
    const turn = {
      request: {
        eventId: 'uncloneable-request',
        authorPubkey: human.publicKey,
        content: 'Edit inaccessible-owner/private-repo.',
        createdAt: 1,
      },
      editPolicy: 'named-repository',
      permissionHandled: false,
      transitionedToCorner: false,
      readOnlyInformationRequest: false,
    };
    (Reflect.get(body, 'pendingRoomTurns') as Map<string, unknown>).set('parent-channel', turn);
    vi.spyOn(body as never, 'waitForWritePermissionDecision' as never).mockResolvedValue(
      'allow' as never,
    );
    const open = vi.spyOn(body, 'openSubchannel');
    const published: NostrEvent[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        published.push(JSON.parse(String(init?.body)) as NostrEvent);
        return new Response(JSON.stringify({ accepted: true }), { status: 200 });
      }),
    );

    await Reflect.get(body, 'handleRoomPermissionRequest').call(
      body,
      'parent-channel',
      {
        toolCall: {
          kind: 'execute',
          title: 'Run shell',
          rawInput: {
            command: 'beeline-request-edit-corner --repo inaccessible-owner/private-repo',
          },
        },
      },
      'named-repository',
    );

    expect(open).not.toHaveBeenCalled();
    expect(turn.transitionedToCorner).toBe(false);
    const failed = published.find((event) =>
      event.tags.some((tag) => tag[0] === 'status' && tag[1] === 'failed'),
    );
    expect(failed?.content).toContain('inaccessible-owner/private-repo');
    expect(failed?.content).toContain('could not be cloned or accessed');
    expect(failed?.tags).toContainEqual(['repo', 'inaccessible-owner/private-repo']);
    expect(failed?.tags.some((tag) => tag[0] === 'subchannel')).toBe(false);
  });

  it('does not clone or open a named repository when the human denies it', async () => {
    const resolveNamedRepository = vi.fn();
    const body = new Body(
      {
        agentBinary: '/nonexistent',
        mcpBinary: '/nonexistent',
        agentEnv: {},
        workspaceRoot: '/tmp/buzzy-named-deny-unit',
        relayBaseUrl: 'http://relay.test',
        relayHost: 'relay.test',
        relayScheme: 'http',
        relayWsUrl: 'ws://relay.test',
        autoApprovePermissions: true,
      },
      undefined,
      undefined,
      undefined,
      { resolveNamedRepository },
    );
    vi.spyOn(body as never, 'cornerOpenAudience' as never).mockResolvedValue([
      human.publicKey,
    ] as never);
    const turn = {
      request: {
        eventId: 'named-deny-request',
        authorPubkey: human.publicKey,
        content: 'Edit lunchboxfortwo/buzzy.',
        createdAt: 1,
      },
      editPolicy: 'named-repository',
      permissionHandled: false,
      transitionedToCorner: false,
      readOnlyInformationRequest: false,
    };
    (Reflect.get(body, 'pendingRoomTurns') as Map<string, unknown>).set('repo-less-room', turn);
    vi.spyOn(body as never, 'waitForWritePermissionDecision' as never).mockResolvedValue(
      'deny' as never,
    );
    const open = vi.spyOn(body, 'openSubchannel');
    const published: NostrEvent[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        published.push(JSON.parse(String(init?.body)) as NostrEvent);
        return new Response(JSON.stringify({ accepted: true }), { status: 200 });
      }),
    );

    await Reflect.get(body, 'handleRoomPermissionRequest').call(
      body,
      'repo-less-room',
      {
        toolCall: {
          kind: 'execute',
          title: 'Run shell',
          rawInput: {
            command: 'beeline-request-edit-corner --repo lunchboxfortwo/buzzy',
          },
        },
      },
      'named-repository',
    );

    expect(resolveNamedRepository).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    expect(turn.transitionedToCorner).toBe(false);
    expect(
      published.find((event) =>
        event.tags.some((tag) => tag[0] === 'status' && tag[1] === 'denied'),
      )?.tags,
    ).toContainEqual(['repo', 'lunchboxfortwo/buzzy']);
  });

  it('lets an admin or owner open a bound Room corner without another decision', async () => {
    const body = new Body({
      agentBinary: '/nonexistent',
      mcpBinary: '/nonexistent',
      agentEnv: {},
      workspaceRoot: '/tmp/buzzy-room-deny-unit',
      relayBaseUrl: 'http://relay.test',
      relayHost: 'relay.test',
      relayScheme: 'http',
      relayWsUrl: 'ws://relay.test',
      autoApprovePermissions: true,
    });
    vi.spyOn(body as never, 'requesterCanOpenCornerDirectly' as never).mockResolvedValue(
      true as never,
    );
    const turn = {
      request: {
        eventId: 'human-request',
        authorPubkey: human.publicKey,
        content: 'Edit README.',
        createdAt: 1,
      },
      boundRepo: { repo: 'repo' },
      permissionHandled: false,
      transitionedToCorner: false,
      readOnlyInformationRequest: false,
    };
    (Reflect.get(body, 'pendingRoomTurns') as Map<string, unknown>).set('parent-channel', turn);
    const wait = vi.spyOn(body as never, 'waitForWritePermissionDecision' as never);
    const info = {
      subchannelId: 'direct-corner',
      taskDescription: turn.request.content,
    };
    const open = vi.spyOn(body, 'openSubchannel').mockResolvedValue(info as never);
    const start = vi
      .spyOn(body as never, 'startAgentTask' as never)
      .mockImplementation(() => undefined as never);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ accepted: true }), { status: 200 })),
    );

    await Reflect.get(body, 'handleRoomPermissionRequest').call(body, 'parent-channel', {
      toolCall: { kind: 'execute', title: 'shell' },
    });

    expect(wait).not.toHaveBeenCalled();
    expect(open).toHaveBeenCalledOnce();
    expect(start).toHaveBeenCalledOnce();
    expect(turn.transitionedToCorner).toBe(true);
  });

  it('raises one approval card when a non-admin member requests bound Room work', async () => {
    const body = new Body({
      agentBinary: '/nonexistent',
      mcpBinary: '/nonexistent',
      agentEnv: {},
      workspaceRoot: '/tmp/buzzy-member-corner-card',
      relayBaseUrl: 'http://relay.test',
      relayHost: 'relay.test',
      relayScheme: 'http',
      relayWsUrl: 'ws://relay.test',
      autoApprovePermissions: true,
    });
    vi.spyOn(body as never, 'requesterCanOpenCornerDirectly' as never).mockResolvedValue(
      false as never,
    );
    vi.spyOn(body as never, 'channelCommunityId' as never).mockResolvedValue('workspace' as never);
    const request = {
      eventId: 'member-request',
      authorPubkey: human.publicKey,
      content: 'Edit README.',
      createdAt: 1,
    };
    (Reflect.get(body, 'pendingRoomTurns') as Map<string, unknown>).set('parent-channel', {
      request,
      boundRepo: { repo: 'repo' },
      permissionHandled: false,
      transitionedToCorner: false,
      readOnlyInformationRequest: false,
    });
    const requestApproval = vi
      .spyOn(body as never, 'requestCornerApproval' as never)
      .mockResolvedValue({
        request_id: 'permission',
        event_id: 'event',
        message: 'pending',
      } as never);
    const open = vi.spyOn(body, 'openSubchannel');

    await expect(
      Reflect.get(body, 'handleRoomPermissionRequest').call(body, 'parent-channel', {
        toolCall: { kind: 'edit', title: 'Write README.md' },
      }),
    ).resolves.toBe('reject');

    expect(requestApproval).toHaveBeenCalledOnce();
    expect(requestApproval).toHaveBeenCalledWith(
      expect.objectContaining({ request, objective: request.content, tool: 'Write README.md' }),
    );
    expect(open).not.toHaveBeenCalled();
  });

  it('refuses agent mutation escalation for research without posting ALLOW or opening a corner', async () => {
    const root = await mkdtemp(join(tmpdir(), 'buzzy-research-boundary-'));
    const source = join(root, 'README.md');
    await writeFile(source, '# Evidence\n');
    const body = new Body({
      agentBinary: '/nonexistent',
      mcpBinary: '/nonexistent',
      agentEnv: {},
      workspaceRoot: root,
      relayBaseUrl: 'http://relay.test',
      relayHost: 'relay.test',
      relayScheme: 'http',
      relayWsUrl: 'ws://relay.test',
      autoApprovePermissions: true,
    });
    const turn = {
      request: {
        eventId: 'research-request',
        authorPubkey: human.publicKey,
        content: 'Analyze this repository and summarize its user stories.',
        createdAt: 1,
      },
      boundRepo: { repo: 'repo', localPath: root },
      permissionHandled: false,
      transitionedToCorner: false,
      readOnlyInformationRequest: true,
    };
    (Reflect.get(body, 'pendingRoomTurns') as Map<string, unknown>).set('parent-channel', turn);
    const open = vi.spyOn(body, 'openSubchannel');
    const publish = vi.fn();
    vi.stubGlobal('fetch', publish);

    await expect(
      Reflect.get(body, 'handleRoomPermissionRequest').call(body, 'parent-channel', {
        sessionId: 'readonly-session',
        _meta: { is_mcp_tool_approval: true },
        toolCall: {
          kind: 'execute',
          title: 'mcp.buzz-readonly-mcp.read_file',
          rawInput: {
            server: 'buzz-readonly-mcp',
            tool: 'read_file',
            arguments: { path: 'README.md' },
          },
        },
      }),
    ).resolves.toBe('allow');

    await expect(
      Reflect.get(body, 'handleRoomPermissionRequest').call(body, 'parent-channel', {
        sessionId: 'readonly-session',
        toolCall: { kind: 'execute', title: 'shell: echo mutation > README.md' },
      }),
    ).resolves.toBe('reject');

    expect(open).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
    expect(turn.permissionHandled).toBe(false);
    expect(turn.transitionedToCorner).toBe(false);
    expect(await readFile(source, 'utf8')).toBe('# Evidence\n');
    await rm(root, { recursive: true, force: true });
  });
  /** Drive one Room turn whose backend requests a mutation mid-turn, so the
   *  permission handler opens a corner and marks the turn
   *  transitionedToCorner exactly as production does. */
  async function replyInRoomWithMidTurnCornerTransition(options: {
    readonly agentText: string;
    readonly requestMutation?: boolean;
  }): Promise<{ readonly published: NostrEvent[]; readonly eventId: string }> {
    const body = new Body({
      agentBinary: '/nonexistent',
      mcpBinary: '/nonexistent',
      agentEnv: {},
      workspaceRoot: mkdtempSync(join(tmpdir(), 'buzzy-corner-transition-')),
      relayBaseUrl: 'http://relay.test',
      relayHost: 'relay.test',
      relayScheme: 'http',
      relayWsUrl: 'ws://relay.test',
      autoApprovePermissions: true,
    });
    stubEmptyAgentHistory(body);
    vi.spyOn(body as never, 'requesterCanOpenCornerDirectly' as never).mockResolvedValue(
      true as never,
    );
    const published: NostrEvent[] = [];
    const client = new AcpClient({ agentBinary: '/nonexistent', agentEnv: {} });
    vi.spyOn(client, 'sessionPrompt').mockImplementation(async () => {
      if (options.requestMutation ?? true) {
        // The model attempts a repository mutation mid-turn; the daemon's real
        // permission handler opens an isolated corner for it.
        await Reflect.get(body, 'handleRoomPermissionRequest').call(body, 'parent-channel', {
          sessionId: 'readonly-session',
          toolCall: { kind: 'edit', title: 'str_replace README.md' },
        });
      }
      return { stopReason: 'end_turn', updates: [], agentText: options.agentText, toolCalls: [] };
    });
    body.registerSession({
      channelId: 'parent-channel',
      sessionId: 'readonly-session',
      client,
      mode: 'readonly',
    });
    const editClient = new AcpClient({ agentBinary: '/nonexistent', agentEnv: {} });
    const event = requestEvent([['p', body.agent.publicKey]], human, 'Fix this in a corner');
    const info = {
      worktreePath: '/tmp/worktree',
      featureBranch: 'feature/corner',
      role: body.agent,
      taskDescription: 'Fix the retry loop',
      cornerName: 'fix-the-retry-loop',
      // Production openSubchannel records the triggering request on the
      // corner; the continuation fallback uses it to name the corner.
      request: { eventId: event.id } as never,
      session: {
        channelId: 'corner-id',
        parentChannelId: 'parent-channel',
        sessionId: 'edit-session',
        client: editClient,
        mode: 'edit' as const,
      },
      lastPolledAt: 1,
      archived: false,
    };
    vi.spyOn(body, 'openSubchannel').mockImplementation(async () => {
      // Exercise the production relay-record writer while avoiding the git
      // worktree and ACP setup that openSubchannel performs afterwards.
      const subchannelId = await createAgentSubchannel(
        body.agent,
        'parent-channel',
        'fix-the-retry-loop',
        human.publicKey,
        undefined,
        info.taskDescription,
      );
      const registered = { ...info, subchannelId };
      // Production openSubchannel registers the actor only after the signed
      // create/member records and the edit session exist.
      (Reflect.get(body, 'subchannels') as Map<string, unknown>).set(subchannelId, registered);
      return registered as never;
    });
    vi.spyOn(body as never, 'startAgentTask' as never).mockImplementation(() => undefined as never);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        published.push(JSON.parse(String(init?.body)) as NostrEvent);
        return new Response(JSON.stringify({ accepted: true }), { status: 200 });
      }),
    );
    await Reflect.get(body, 'replyInRoom').call(
      body,
      'parent-channel',
      { repo: 'repo' },
      {
        eventId: event.id,
        authorPubkey: event.pubkey,
        content: event.content,
        createdAt: event.created_at,
      },
    );
    return { published, eventId: event.id };
  }

  function turnStatuses(published: readonly NostrEvent[]): (string | undefined)[] {
    return published
      .filter((event) => event.tags.some((tag) => tag[0] === 't' && tag[1] === 'agent-turn'))
      .map((event) => event.tags.find((tag) => tag[0] === 'status')?.[1]);
  }

  it('answers the Room when a mid-turn mutation moves the work into a corner', async () => {
    // Production evidence (Room 9d5e2285, 2026-08-25): a corner transition
    // settled with only a complete receipt, leaving no visible Room reply for
    // hours while the request was silently consumed.
    const { published, eventId } = await replyInRoomWithMidTurnCornerTransition({
      agentText:
        'Yes — I diagnosed it and started the fix in an isolated corner so the Room stays read-only.',
    });
    expect(turnStatuses(published)).toEqual(['working', 'complete']);
    const replies = published.filter((event) =>
      event.tags.some((tag) => tag[0] === 't' && tag[1] === 'agent-message'),
    );
    expect(replies).toHaveLength(1);
    expect(replies[0]!.content).toBe(
      'Yes — I diagnosed it and started the fix in an isolated corner so the Room stays read-only.',
    );
    // The answer threads to the human request like every other Room reply.
    expect(replies[0]!.tags).toContainEqual(['e', eventId, '', 'reply']);
    expect(replies[0]!.tags).toContainEqual(['h', 'parent-channel']);
  });

  it('publishes a corner completion claim only when the turn created signed corner records', async () => {
    const claim = 'I started the implementation in a real Beeline edit corner.';
    const { published } = await replyInRoomWithMidTurnCornerTransition({ agentText: claim });
    const create = published.find(
      (event) =>
        event.kind === 9007 &&
        event.tags.some((tag) => tag[0] === 'parent' && tag[1] === 'parent-channel'),
    );
    expect(create).toBeDefined();
    const cornerId = create!.tags.find((tag) => tag[0] === 'h')?.[1];
    expect(
      published.some(
        (event) =>
          event.kind === 9000 &&
          event.tags.some((tag) => tag[0] === 'h' && tag[1] === cornerId) &&
          event.tags.some((tag) => tag[0] === 'p' && tag[1] === human.publicKey),
      ),
    ).toBe(true);
    expect(
      published.find((event) =>
        event.tags.some((tag) => tag[0] === 't' && tag[1] === 'agent-message'),
      )?.content,
    ).toBe(claim);
  });

  it('replaces the captured false completion claim when no corner records exist', async () => {
    const falseClaim = 'I have now created an active mission.';
    const { published } = await replyInRoomWithMidTurnCornerTransition({
      agentText: falseClaim,
      requestMutation: false,
    });
    expect(published.some((event) => event.kind === 9007 || event.kind === 9000)).toBe(false);
    const reply = published.find((event) =>
      event.tags.some((tag) => tag[0] === 't' && tag[1] === 'agent-message'),
    );
    expect(reply?.content).toBe(
      'No Beeline corner or mission record was created, so no coordinated work started.',
    );
    expect(reply?.content).not.toContain(falseClaim);
  });

  it('joins an explicit-command corner with the same request tool call and rejects false-denial prose', async () => {
    const body = new Body({
      agentBinary: '/nonexistent',
      mcpBinary: '/nonexistent',
      agentEnv: {},
      workspaceRoot: '/tmp/buzzy-corner-dual-authority',
      relayBaseUrl: 'http://relay.test',
      relayHost: 'relay.test',
      relayScheme: 'http',
      relayWsUrl: 'ws://relay.test',
      autoApprovePermissions: true,
    });
    stubEmptyAgentHistory(body);
    vi.spyOn(body as never, 'requesterCanOpenCornerDirectly' as never).mockResolvedValue(
      true as never,
    );
    const published: NostrEvent[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        published.push(JSON.parse(String(init?.body)) as NostrEvent);
        return new Response(JSON.stringify({ accepted: true }), { status: 200 });
      }),
    );

    const request = {
      eventId: 'f'.repeat(64),
      authorPubkey: human.publicKey,
      content: 'Go and try to find it and fix it.',
      createdAt: 1,
    };
    const boundRepo = {
      repo: 'repo',
      localPath: '/tmp/buzzy-corner-dual-authority/repo',
      targetBranch: 'refs/heads/main',
    };
    (Reflect.get(body, 'agentToolRoomRepositories') as Map<string, unknown>).set(
      'parent-channel',
      boundRepo,
    );
    vi.spyOn(body as never, 'currentAgentToolMandate' as never).mockResolvedValue({
      schema_version: 3,
      generation: { event_id: 'a'.repeat(64), generation: 1 },
      grants: [],
      defaults: [{ action: 'corner.open', version: 2, effect: 'allow' }],
      blockers: [],
    } as never);

    let openCount = 0;
    let releaseFirstOpen!: () => void;
    let reportFirstOpen!: () => void;
    const firstOpenStarted = new Promise<void>((resolve) => {
      reportFirstOpen = resolve;
    });
    const firstOpenGate = new Promise<void>((resolve) => {
      releaseFirstOpen = resolve;
    });
    const editClient = new AcpClient({ agentBinary: '/nonexistent', agentEnv: {} });
    const open = vi.spyOn(body, 'openSubchannel').mockImplementation(async (...args) => {
      const ordinal = ++openCount;
      if (ordinal === 1) {
        reportFirstOpen();
        await firstOpenGate;
      }
      const triggeringRequest = args[3] as typeof request | undefined;
      const info = {
        subchannelId: `corner-${ordinal}`,
        worktreePath: `/tmp/worktree-${ordinal}`,
        featureBranch: `feature/corner-${ordinal}`,
        role: body.agent,
        taskDescription: request.content,
        cornerName: `incident-fix-${ordinal}`,
        request: triggeringRequest,
        session: {
          channelId: `corner-${ordinal}`,
          parentChannelId: 'parent-channel',
          sessionId: `edit-session-${ordinal}`,
          client: editClient,
          mode: 'edit' as const,
        },
        lastPolledAt: 1,
        archived: false,
      };
      (Reflect.get(body, 'subchannels') as Map<string, unknown>).set(info.subchannelId, info);
      return info as never;
    });
    const start = vi
      .spyOn(body as never, 'startAgentTask' as never)
      .mockImplementation(() => undefined as never);

    let toolResult: unknown;
    const roomClient = new AcpClient({ agentBinary: '/nonexistent', agentEnv: {} });
    vi.spyOn(roomClient, 'sessionPrompt').mockImplementation(async () => {
      toolResult = await Reflect.get(body, 'invokeAgentTool').call(
        body,
        { channelId: 'parent-channel', roomId: 'parent-channel', workspaceId: 'parent-channel' },
        'open_corner',
        { objective: request.content },
      );
      return {
        stopReason: 'end_turn',
        updates: [],
        agentText:
          'The corner-opening request was rejected by the host/user, so no edit session started and I made no repository changes.',
        toolCalls: [],
      };
    });
    body.registerSession({
      channelId: 'parent-channel',
      sessionId: 'readonly-session',
      client: roomClient,
      mode: 'readonly',
    });

    const toolPath = Reflect.get(body, 'replyInRoom').call(
      body,
      'parent-channel',
      boundRepo,
      request,
      false,
      'repository',
    );
    await firstOpenStarted;
    const explicitCommandPath = Reflect.get(body, 'replyInRoom').call(
      body,
      'parent-channel',
      boundRepo,
      request,
      true,
      'repository',
    );
    await Promise.resolve();
    releaseFirstOpen();
    await Promise.all([toolPath, explicitCommandPath]);

    expect(open).toHaveBeenCalledOnce();
    expect(start).toHaveBeenCalledOnce();
    expect(toolResult).toMatchObject({
      status: 'executed',
      result: { corner_id: 'corner-1', feature_ref: 'feature/corner-1' },
    });
    expect(Reflect.get(body, 'subchannels')).toHaveLength(1);
    const replies = published.filter((event) =>
      event.tags.some((tag) => tag[0] === 't' && tag[1] === 'agent-message'),
    );
    expect(replies).toHaveLength(1);
    expect(replies[0]!.content).toContain('incident-fix-1');
    expect(replies[0]!.content).toMatch(/corner/i);
    expect(replies[0]!.content).not.toMatch(/rejected|no edit session|no repository changes/i);
  });

  it('returns timeout-recovery truth for the triggering request and lists the opening corner', async () => {
    const body = new Body({
      agentBinary: '/nonexistent',
      mcpBinary: '/nonexistent',
      agentEnv: {},
      workspaceRoot: '/tmp/buzzy-corner-truth',
      relayBaseUrl: 'http://relay.test',
      relayHost: 'relay.test',
      relayScheme: 'http',
      relayWsUrl: 'ws://relay.test',
      autoApprovePermissions: true,
    });
    const request = {
      eventId: 'd'.repeat(64),
      authorPubkey: human.publicKey,
      content: 'Fix the corner timeout',
      createdAt: 1,
    };
    (Reflect.get(body, 'pendingRoomTurns') as Map<string, unknown>).set('parent-channel', {
      request,
      permissionHandled: false,
      transitionedToCorner: false,
      readOnlyInformationRequest: false,
    });
    (Reflect.get(body, 'cornerOpenAttempts') as Map<string, unknown>).set(request.eventId, {
      roomId: 'parent-channel',
      requestId: request.eventId,
      objective: request.content,
      cornerId: 'corner-created-before-timeout',
      name: 'Fix corner timeout',
    });

    const binding = {
      channelId: 'parent-channel',
      roomId: 'parent-channel',
      workspaceId: 'workspace',
    };
    await expect(
      Reflect.get(body, 'invokeAgentTool').call(body, binding, 'read_corner', {}),
    ).resolves.toEqual({
      request_id: request.eventId,
      exists: true,
      state: 'opening',
      corner: {
        corner_id: 'corner-created-before-timeout',
        name: 'Fix corner timeout',
        objective: request.content,
        state: 'opening',
      },
    });
    await expect(
      Reflect.get(body, 'invokeAgentTool').call(body, binding, 'list_corners', {}),
    ).resolves.toMatchObject({
      corners: [{ corner_id: 'corner-created-before-timeout', state: 'opening' }],
    });
  });

  it('publishes one audience-scoped approval card for repeated corner requests', async () => {
    const body = new Body({
      agentBinary: '/nonexistent',
      mcpBinary: '/nonexistent',
      agentEnv: {},
      workspaceRoot: '/tmp/buzzy-corner-approval-card',
      relayBaseUrl: 'http://relay.test',
      relayHost: 'relay.test',
      relayScheme: 'http',
      relayWsUrl: 'ws://relay.test',
      autoApprovePermissions: true,
    });
    const admin = newIdentity('corner-admin');
    const owner = newIdentity('corner-owner');
    vi.spyOn(body as never, 'cornerOpenAudience' as never).mockResolvedValue([
      human.publicKey,
      admin.publicKey,
      owner.publicKey,
    ] as never);
    vi.spyOn(body as never, 'waitForWritePermissionDecision' as never).mockReturnValue(
      new Promise(() => undefined) as never,
    );
    const published: NostrEvent[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        published.push(JSON.parse(String(init?.body)) as NostrEvent);
        return new Response(JSON.stringify({ accepted: true }), { status: 200 });
      }),
    );
    const input = {
      roomId: 'parent-channel',
      workspaceId: 'workspace',
      roomRepo: { repo: 'repo' },
      request: {
        eventId: 'e'.repeat(64),
        authorPubkey: human.publicKey,
        content: 'Repair approval cards',
        createdAt: 1,
      },
      objective: 'Repair approval cards',
      tool: 'open_corner',
    };
    const [first, second] = await Promise.all([
      Reflect.get(body, 'requestCornerApproval').call(body, input),
      Reflect.get(body, 'requestCornerApproval').call(body, input),
    ]);

    expect(second).toEqual(first);
    const cards = published.filter((event) =>
      event.tags.some((tag) => tag[0] === 't' && tag[1] === 'buzz-write-permission-request'),
    );
    expect(cards).toHaveLength(1);
    expect(cards[0]!.content).toContain('Repair approval cards');
    expect(cards[0]!.tags.filter((tag) => tag[0] === 'p').map((tag) => tag[1])).toEqual([
      human.publicKey,
      admin.publicKey,
      owner.publicKey,
    ]);
  });

  it('self-closes a child whose setup fails after its durable create', async () => {
    const body = new Body({
      agentBinary: '/nonexistent',
      mcpBinary: '/nonexistent',
      agentEnv: {},
      workspaceRoot: '/tmp/buzzy-corner-orphan-hygiene',
      relayBaseUrl: 'http://relay.test',
      relayHost: 'relay.test',
      relayScheme: 'http',
      relayWsUrl: 'ws://relay.test',
      autoApprovePermissions: true,
    });
    const published: NostrEvent[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        published.push(JSON.parse(String(init?.body)) as NostrEvent);
        return new Response(JSON.stringify({ accepted: true }), { status: 200 });
      }),
    );
    vi.spyOn(body, 'openSubchannel').mockImplementation(async (...args) => {
      const options = args[4] as {
        onCreated?: (cornerId: string, name: string, objective: string) => void;
      };
      options.onCreated?.('orphan-corner', 'Repair kickoff', 'Repair kickoff');
      throw new Error('session activation failed');
    });
    const request = {
      eventId: 'c'.repeat(64),
      authorPubkey: human.publicKey,
      content: 'Repair kickoff',
      createdAt: 1,
    };

    await expect(
      Reflect.get(body, 'openSubchannelForRequest').call(
        body,
        'parent-channel',
        { repo: 'repo' },
        request.content,
        request,
      ),
    ).rejects.toThrow('session activation failed');
    expect(
      published.some(
        (event) =>
          event.kind === 9 &&
          event.content.includes('could not start and was closed') &&
          event.tags.some((tag) => tag[0] === 'subchannel' && tag[1] === 'orphan-corner'),
      ),
    ).toBe(true);
  });

  it('still announces the corner when the transition turn produced no text', async () => {
    const { published } = await replyInRoomWithMidTurnCornerTransition({ agentText: '' });
    expect(turnStatuses(published)).toEqual(['working', 'complete']);
    const replies = published.filter((event) =>
      event.tags.some((tag) => tag[0] === 't' && tag[1] === 'agent-message'),
    );
    expect(replies).toHaveLength(0);
  });
});
