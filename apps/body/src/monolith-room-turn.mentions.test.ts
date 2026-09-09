import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AcpClient } from './acp.js';
import { AgentResponseRule } from './agent-response-rule.js';
import type { BodyConfig } from './config.js';
import type { DaemonApiClient } from './daemon-api-client.js';
import {
  agentReplyMentionIds,
  inboxItemTriggersTurn,
  MonolithRoomTurnLoop,
  roomMentionDirectory,
} from './monolith-room-turn.js';
import { identityFromKey, type AgentRuntimeRecord } from './runtime.js';
import { SessionScheduler } from './session-scheduler.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const AGENT_HEX = '33'.repeat(32);
const CAPTAIN = '44'.repeat(32);
const PEER = '55'.repeat(32);
const OTHER_AGENT = '66'.repeat(32);

/** The Room roster as the server answers it: display name AND canonical handle. */
const ROSTER = (selfId: string) => ({
  members: [
    { identityId: selfId, kind: 'agent' as const, name: 'Greeter', role: 'member' as const },
    {
      identityId: CAPTAIN,
      kind: 'human' as const,
      name: 'Captain',
      handle: 'lunchboxfortwo',
      role: 'owner' as const,
    },
    {
      identityId: PEER,
      kind: 'human' as const,
      name: 'bananaman614305',
      handle: 'bananaman614305',
      role: 'member' as const,
    },
  ],
});

describe('who an agent can tag, and how it is spelled', () => {
  it('names every member and the one spelling that reaches them', () => {
    const directory = roomMentionDirectory(ROSTER('self'), 'self');
    // The handle is canonical; the display name rides along only because the
    // rest of the prompt names people by it and the model has to join the two.
    expect(directory).toContain('- @lunchboxfortwo — Captain (person)');
    // No redundant restatement when the display name IS the handle.
    expect(directory).toContain('- @bananaman614305 (person)');
    // Never the agent itself: it cannot tag itself, and the resolver drops it.
    expect(directory).not.toContain('Greeter');
    expect(directory).toContain('Never invent a handle');
  });

  it('falls back to the display name for a member with no handle, and says nothing for an empty Room', () => {
    const roster = {
      members: [
        { identityId: 'self', kind: 'agent' as const, name: 'Greeter', role: 'member' as const },
        { identityId: 'nameless', kind: 'human' as const, name: 'Ada', role: 'member' as const },
      ],
    };
    expect(roomMentionDirectory(roster, 'self')).toContain('- @Ada (person)');
    expect(roomMentionDirectory({ members: [] }, 'self')).toBe('');
  });

  /**
   * Defect 1. The prompt is the model's only source for an @spelling: a helper
   * that has to guess one copies a retired handle out of its own old messages,
   * and the tag reaches nobody. Fails before the fix — no handle appeared in
   * the prompt at all.
   */
  it('carries the canonical handles into a direct-reply turn prompt and final write', async () => {
    const root = await mkdtemp(join(tmpdir(), 'beeline-room-mentions-'));
    roots.push(root);
    const identity = identityFromKey(AGENT_HEX, 'Greeter');
    const agent = {
      name: 'Greeter',
      publicKey: identity.publicKey,
      secretKeyHex: Buffer.from(identity.secretKey).toString('hex'),
    };
    const runtime = {
      agent,
      rooms: [],
      supervisorRoot: root,
      transport: { kind: 'monolith', baseUrl: 'https://server.example', daemonToken: 'token' },
      agentBinary: '/fake-agent',
      agentKind: 'codex',
      agentCommand: '/fake-agent',
      agentArgs: [],
      mcpBinary: '/fake-dev-mcp',
    } as unknown as AgentRuntimeRecord;
    const config: BodyConfig = {
      agentBinary: '/fake-agent',
      agentKind: 'codex',
      agentCommand: '/fake-agent',
      agentArgs: [],
      mcpBinary: '/fake-dev-mcp',
      readonlyMcpCommand: '/fake-beeline-mcp',
      agentEnv: {},
      workspaceRoot: join(root, 'room'),
      autoApprovePermissions: true,
      accessPolicy: 'everyone',
    } as BodyConfig;
    let inboxReads = 0;
    let followUpDelivered = false;
    let releaseFirstPost: (() => void) | undefined;
    const firstPost = new Promise<void>((resolve) => {
      releaseFirstPost = () => resolve();
    });
    let firstPostPending = true;
    const writes: unknown[] = [];
    const execute = vi.fn(async (name: string, input?: unknown) => {
      if (name === 'getAgentConfiguration') return { commands: [], yoloMode: false };
      if (name === 'getRoomRepositoryState') return { resolution: 'none' };
      if (name === 'getWorkspaceRoster') return ROSTER(agent.publicKey);
      if (name === 'getRoomAuthority') return { member: true, principalKind: 'human' };
      if (name === 'getRoomConversation') {
        const committed = writes.some(
          (write) =>
            typeof write === 'object' &&
            write !== null &&
            (write as { triggerMessageId?: string }).triggerMessageId === 'ask-1',
        );
        return {
          items: committed
            ? [
                {
                  id: 'server-committed-answer',
                  authorId: agent.publicKey,
                  createdAt: 902,
                  type: 'message',
                  body: 'hello',
                  mentionIds: [CAPTAIN],
                  attachments: [],
                },
              ]
            : [],
          cursor: 'latest',
        };
      }
      if (name === 'getRoomInbox') {
        inboxReads += 1;
        if (inboxReads === 2)
          return {
            items: [
              {
                id: 'ask-1',
                authorId: CAPTAIN,
                createdAt: 900,
                type: 'message',
                body: 'say hello to the new arrival',
                mentionIds: [],
                replyToMessageId: 'agent-parent',
                replyToAuthorId: agent.publicKey,
                attachments: [],
              },
            ],
            cursor: 'ask-1',
          };
        if (
          !followUpDelivered &&
          writes.some(
            (write) =>
              typeof write === 'object' &&
              write !== null &&
              (write as { triggerMessageId?: string }).triggerMessageId === 'ask-1',
          )
        ) {
          followUpDelivered = true;
          return {
            items: [
              {
                id: 'ask-2',
                authorId: CAPTAIN,
                createdAt: 901,
                type: 'message',
                body: 'and please keep going',
                mentionIds: [],
                attachments: [],
              },
            ],
            cursor: 'ask-2',
          };
        }
        return { items: [], cursor: 'latest' };
      }
      if (name === 'postRoomMessage') {
        writes.push(input);
        if (firstPostPending) {
          firstPostPending = false;
          return firstPost.then(() => {
            throw new Error('post response lost');
          });
        }
      }
      return { id: 'write-id', createdAt: 1 };
    });
    const api = {
      execute,
      connection: () => ({
        baseUrl: 'https://server.example',
        daemonToken: 'daemon-token',
        agentId: agent.publicKey,
      }),
    } as unknown as DaemonApiClient;
    const prompts: string[] = [];
    const acp = new AcpClient({ agentBinary: '/fake-agent', agentEnv: {} });
    vi.spyOn(acp, 'start').mockResolvedValue(undefined);
    vi.spyOn(acp, 'sessionNew').mockResolvedValue({ sessionId: 'room-session', raw: {} });
    vi.spyOn(acp, 'canPromptWithImages').mockReturnValue(false);
    vi.spyOn(acp, 'isAlive', 'get').mockReturnValue(true);
    vi.spyOn(acp, 'sessionPrompt').mockImplementation(
      async (_sessionId: string, prompt: unknown) => {
        prompts.push(typeof prompt === 'string' ? prompt : JSON.stringify(prompt));
        return { stopReason: 'end_turn', updates: [], agentText: 'hello', toolCalls: [] };
      },
    );
    const scheduler = new SessionScheduler({ maxLiveSessions: 2 });
    const abort = new AbortController();
    const loop = new MonolithRoomTurnLoop({
      roomId: 'room-id',
      workspaceId: 'workspace',
      cwd: config.workspaceRoot,
      runtime,
      config,
      api,
      scheduler,
      health: { poll: vi.fn(), failure: vi.fn(), presence: vi.fn() },
      signal: abort.signal,
      pollMs: 10,
      createAcpClient: () => acp,
    });
    const running = loop.run();
    await vi.waitFor(() => expect(prompts).toHaveLength(1), { timeout: 10_000 });
    await vi.waitFor(
      () => expect(writes).toContainEqual(expect.objectContaining({ triggerMessageId: 'ask-1' })),
      { timeout: 10_000 },
    );
    await vi.waitFor(() => expect(followUpDelivered).toBe(true), { timeout: 10_000 });
    releaseFirstPost?.();
    await vi.waitFor(() => expect(prompts).toHaveLength(2), { timeout: 10_000 });
    abort.abort();
    await running.catch(() => undefined);
    await scheduler.dispose();

    expect(prompts[0]).toContain('Room members, and the exact spelling that tags each one:');
    expect(prompts[0]).toContain('- @lunchboxfortwo — Captain (person)');
    expect(prompts[0]).toContain('- @bananaman614305 (person)');
    expect(writes).toContainEqual(expect.objectContaining({ triggerMessageId: 'ask-1' }));
    expect(writes).toContainEqual(expect.objectContaining({ triggerMessageId: 'ask-2' }));
  }, 20_000);

  it('does not continue after a newly joined agent is addressed or capped', async () => {
    const root = await mkdtemp(join(tmpdir(), 'beeline-room-stale-roster-'));
    roots.push(root);
    const identity = identityFromKey(AGENT_HEX, 'Greeter');
    const agent = {
      name: 'Greeter',
      publicKey: identity.publicKey,
      secretKeyHex: Buffer.from(identity.secretKey).toString('hex'),
    };
    const runtime = {
      agent,
      rooms: [],
      supervisorRoot: root,
      transport: { kind: 'monolith', baseUrl: 'https://server.example', daemonToken: 'token' },
      agentBinary: '/fake-agent',
      agentKind: 'codex',
      agentCommand: '/fake-agent',
      agentArgs: [],
      mcpBinary: '/fake-dev-mcp',
    } as unknown as AgentRuntimeRecord;
    const config: BodyConfig = {
      agentBinary: '/fake-agent',
      agentKind: 'codex',
      agentCommand: '/fake-agent',
      agentArgs: [],
      mcpBinary: '/fake-dev-mcp',
      readonlyMcpCommand: '/fake-beeline-mcp',
      agentEnv: {},
      workspaceRoot: root,
      autoApprovePermissions: true,
    };
    let inboxReads = 0;
    const execute = vi.fn(async (name: string) => {
      if (name === 'getWorkspaceRoster') return ROSTER(agent.publicKey);
      if (name === 'getRoomConversation') {
        return {
          items: [
            {
              id: 'prior-answer',
              authorId: agent.publicKey,
              createdAt: 1,
              type: 'message',
              body: 'I can help.',
              mentionIds: [OTHER_AGENT],
              requestAuthorId: CAPTAIN,
              attachments: [],
            },
          ],
          cursor: 'prior-answer',
        };
      }
      if (name === 'getRoomInbox') {
        inboxReads += 1;
        if (inboxReads === 1) return { items: [], cursor: 'activation', rewindIds: [] };
        if (inboxReads === 2) {
          return {
            items: [
              {
                id: 'new-agent-handoff',
                authorId: CAPTAIN,
                createdAt: 2,
                type: 'message',
                body: '@new helper, please take this.',
                mentionIds: [OTHER_AGENT],
                agentMentionIds: [OTHER_AGENT],
                attachments: [],
              },
            ],
            cursor: 'new-agent-handoff',
          };
        }
        if (inboxReads === 3) {
          return {
            items: [
              {
                id: 'capped-new-agent-return',
                authorId: OTHER_AGENT,
                createdAt: 3,
                type: 'message',
                body: 'I have reached the handoff limit.',
                mentionIds: [],
                agentMentionIds: [],
                agentAuthor: true,
                agentHopCount: 3,
                attachments: [],
              },
            ],
            cursor: 'capped-new-agent-return',
          };
        }
        return { items: [], cursor: 'latest' };
      }
      return { id: 'write-id', createdAt: 1 };
    });
    const api = {
      execute,
      connection: () => ({
        baseUrl: 'https://server.example',
        daemonToken: 'daemon-token',
        agentId: agent.publicKey,
      }),
    } as unknown as DaemonApiClient;
    const acp = new AcpClient({ agentBinary: '/fake-agent', agentEnv: {} });
    const prompts: string[] = [];
    vi.spyOn(acp, 'sessionPrompt').mockImplementation(async (_session, prompt) => {
      prompts.push(String(prompt));
      return { stopReason: 'end_turn', updates: [], agentText: '', toolCalls: [] };
    });
    const scheduler = new SessionScheduler({ maxLiveSessions: 1 });
    const abort = new AbortController();
    const running = new MonolithRoomTurnLoop({
      roomId: 'room-id',
      workspaceId: 'workspace',
      cwd: root,
      runtime,
      config,
      api,
      scheduler,
      health: { poll: vi.fn(), failure: vi.fn(), presence: vi.fn() },
      signal: abort.signal,
      pollMs: 0,
      createAcpClient: () => acp,
    }).run();

    await vi.waitFor(() => expect(inboxReads).toBeGreaterThanOrEqual(4));
    expect(prompts).toEqual([]);
    expect(execute.mock.calls.filter(([name]) => name === 'postAgentTurnReceipt')).toEqual([]);

    abort.abort();
    await running.catch(() => undefined);
    await scheduler.dispose();
  });

  it('does not continue a tag the server rejected before its target joined', async () => {
    const root = await mkdtemp(join(tmpdir(), 'beeline-room-unpersisted-tag-'));
    roots.push(root);
    const identity = identityFromKey(AGENT_HEX, 'Greeter');
    const agent = {
      name: 'Greeter',
      publicKey: identity.publicKey,
      secretKeyHex: Buffer.from(identity.secretKey).toString('hex'),
    };
    const runtime = {
      agent,
      rooms: [],
      supervisorRoot: root,
      transport: { kind: 'monolith', baseUrl: 'https://server.example', daemonToken: 'token' },
      agentBinary: '/fake-agent',
      agentKind: 'codex',
      agentCommand: '/fake-agent',
      agentArgs: [],
      mcpBinary: '/fake-dev-mcp',
    } as unknown as AgentRuntimeRecord;
    const roster = {
      members: [
        {
          identityId: agent.publicKey,
          kind: 'agent' as const,
          name: 'Greeter',
          role: 'member' as const,
        },
        { identityId: OTHER_AGENT, kind: 'agent' as const, name: 'Peer', role: 'member' as const },
        { identityId: CAPTAIN, kind: 'human' as const, name: 'Captain', role: 'owner' as const },
      ],
    };
    const config: BodyConfig = {
      agentBinary: '/fake-agent',
      agentKind: 'codex',
      agentCommand: '/fake-agent',
      agentArgs: [],
      mcpBinary: '/fake-dev-mcp',
      readonlyMcpCommand: '/fake-beeline-mcp',
      agentEnv: {},
      workspaceRoot: root,
      autoApprovePermissions: true,
    };
    let inboxReads = 0;
    let settledPosts = 0;
    let peerJoined = false;
    let peerExplicit = false;
    let peerFollowedUp = false;
    const posts: Array<{ mentionIds?: readonly string[] }> = [];
    const execute = vi.fn(async (name: string, input?: unknown) => {
      if (name === 'getAgentConfiguration') return { commands: [], yoloMode: false };
      if (name === 'getRoomRepositoryState') return { resolution: 'none' };
      if (name === 'getWorkspaceRoster') return roster;
      if (name === 'getRoomConversation') return { items: [], cursor: 'latest' };
      if (name === 'getRoomInbox') {
        inboxReads += 1;
        if (inboxReads === 1) return { items: [], cursor: 'activation', rewindIds: [] };
        if (inboxReads === 2) {
          return {
            items: [
              {
                id: 'captain-request',
                authorId: CAPTAIN,
                createdAt: 1,
                type: 'message',
                body: '@Greeter ask @Peer to help.',
                mentionIds: [agent.publicKey],
                agentMentionIds: [agent.publicKey],
                attachments: [],
              },
            ],
            cursor: 'captain-request',
          };
        }
        if (settledPosts >= 1 && !peerJoined) {
          peerJoined = true;
          return {
            items: [
              {
                id: 'peer-follow-up',
                authorId: OTHER_AGENT,
                createdAt: 2,
                type: 'message',
                body: 'I just joined this Room.',
                mentionIds: [],
                agentMentionIds: [],
                attachments: [],
              },
            ],
            cursor: 'peer-follow-up',
          };
        }
        if (peerJoined && !peerExplicit) {
          peerExplicit = true;
          return {
            items: [
              {
                id: 'peer-explicit-request',
                authorId: OTHER_AGENT,
                createdAt: 3,
                type: 'message',
                body: '@Greeter, please respond.',
                mentionIds: [agent.publicKey],
                agentMentionIds: [agent.publicKey],
                attachments: [],
              },
            ],
            cursor: 'peer-explicit-request',
          };
        }
        if (peerExplicit && settledPosts >= 2 && !peerFollowedUp) {
          peerFollowedUp = true;
          return {
            items: [
              {
                id: 'peer-durable-follow-up',
                authorId: OTHER_AGENT,
                createdAt: 4,
                type: 'message',
                body: 'Thank you.',
                mentionIds: [],
                agentMentionIds: [],
                attachments: [],
              },
            ],
            cursor: 'peer-durable-follow-up',
          };
        }
        return { items: [], cursor: 'latest' };
      }
      if (name === 'getRoomAuthority') {
        return {
          member: true,
          principalKind:
            (input as { principalId?: string } | undefined)?.principalId === OTHER_AGENT
              ? 'agent'
              : 'human',
        };
      }
      if (name === 'postRoomMessage') {
        posts.push(input as { mentionIds?: readonly string[] });
        return { id: 'reply', createdAt: 1, mentionIds: [] };
      }
      if (name === 'retractAgentLiveOutput') {
        settledPosts += 1;
        return { id: 'retract', createdAt: 1 };
      }
      return { id: 'write-id', createdAt: 1 };
    });
    const api = {
      execute,
      connection: () => ({
        baseUrl: 'https://server.example',
        daemonToken: 'daemon-token',
        agentId: agent.publicKey,
      }),
    } as unknown as DaemonApiClient;
    const acp = new AcpClient({ agentBinary: '/fake-agent', agentEnv: {} });
    const prompts: string[] = [];
    vi.spyOn(acp, 'start').mockResolvedValue(undefined);
    vi.spyOn(acp, 'sessionNew').mockResolvedValue({ sessionId: 'room-session', raw: {} });
    vi.spyOn(acp, 'canPromptWithImages').mockReturnValue(false);
    vi.spyOn(acp, 'isAlive', 'get').mockReturnValue(true);
    vi.spyOn(acp, 'sessionPrompt').mockImplementation(async (_session, prompt) => {
      prompts.push(String(prompt));
      return {
        stopReason: 'end_turn',
        updates: [],
        agentText: '@Peer, please take over.',
        toolCalls: [],
      };
    });
    const scheduler = new SessionScheduler({ maxLiveSessions: 1 });
    const abort = new AbortController();
    const running = new MonolithRoomTurnLoop({
      roomId: 'room-id',
      workspaceId: 'workspace',
      cwd: root,
      runtime,
      config,
      api,
      scheduler,
      health: { poll: vi.fn(), failure: vi.fn(), presence: vi.fn() },
      signal: abort.signal,
      pollMs: 0,
      createAcpClient: () => acp,
    }).run();

    await vi.waitFor(() => expect(peerFollowedUp).toBe(true));
    await vi.waitFor(() => expect(prompts).toHaveLength(3));
    expect(posts[0]).toEqual(expect.objectContaining({ mentionIds: [OTHER_AGENT] }));
    expect(execute.mock.calls.filter(([name]) => name === 'postAgentTurnReceipt')).toHaveLength(6);

    abort.abort();
    await running.catch(() => undefined);
    await scheduler.dispose();
  });

  /**
   * Defect 2, the daemon half. The resolver is NOT what dropped the correct
   * handle: it returns both ids for the exact shape the Room saw. It does fix
   * their ORDER — aliases are tried longest first, so the legacy `a_` spelling
   * (16 characters) lands ahead of the correct handle (15) — which is why the
   * server's since-removed one-human cap kept the wrong tag and threw away the
   * right one.
   */
  it('resolves a mid-text handle after a newline alongside a legacy spelling', () => {
    const text = [
      '@a_lunchboxfortwo here is where things stand and what I still need from you.',
      '@bananaman614305 you are up next; the checklist below is yours.',
    ].join('\n');
    expect(text.indexOf('@bananaman614305')).toBeGreaterThan(0);
    expect(agentReplyMentionIds(text, ROSTER(AGENT_HEX), AGENT_HEX)).toEqual([CAPTAIN, PEER]);
  });
});

describe('the per-sender Room response rule', () => {
  const message = (overrides: Record<string, unknown> = {}) => ({
    id: 'message',
    authorId: CAPTAIN,
    createdAt: 1,
    type: 'message',
    body: 'Continue.',
    mentionIds: [] as string[],
    attachments: [],
    ...overrides,
  });

  function rule(): AgentResponseRule {
    const responseRule = new AgentResponseRule();
    responseRule.setAgents([AGENT_HEX, OTHER_AGENT]);
    return responseRule;
  }

  it('drops failed local continuity after an empty authoritative rebuild', () => {
    const responseRule = rule();
    responseRule.noteReply(AGENT_HEX, [CAPTAIN]);
    expect(responseRule.continues(message(), AGENT_HEX)).toBe(true);

    responseRule.replaceHistory([]);

    expect(responseRule.continues(message(), AGENT_HEX)).toBe(false);
  });

  it('always accepts a server-resolved explicit mention', () => {
    const tagged = message({ mentionIds: [AGENT_HEX] });
    expect(inboxItemTriggersTurn(tagged, AGENT_HEX)).toBe(true);
  });

  it('continues the same sender exchange across a third-party interjection', () => {
    const responseRule = rule();
    responseRule.observe(
      message({
        id: 'agent-answer',
        authorId: AGENT_HEX,
        requestAuthorId: CAPTAIN,
      }),
    );
    responseRule.observe(message({ id: 'interjection', authorId: PEER }));
    const followUp = message({ id: 'follow-up' });
    expect(responseRule.continues(followUp, AGENT_HEX)).toBe(true);
    expect(
      inboxItemTriggersTurn(followUp, AGENT_HEX, responseRule.continues(followUp, AGENT_HEX)),
    ).toBe(true);
  });

  it('rebuilds in-window continuity after restart, while an aged-out exchange needs a tag or reply', () => {
    const restarted = rule();
    restarted.observeAll([
      message({ id: 'agent-answer', authorId: AGENT_HEX, requestAuthorId: CAPTAIN }),
      ...Array.from({ length: 199 }, (_, index) =>
        message({ id: `interjection-${index}`, authorId: PEER }),
      ),
    ]);
    expect(restarted.continues(message({ id: 'within-window' }), AGENT_HEX)).toBe(true);

    const agedOut = rule();
    agedOut.observeAll(
      Array.from({ length: 200 }, (_, index) => message({ id: `later-${index}`, authorId: PEER })),
    );
    const unaddressed = message({ id: 'aged-out' });
    expect(agedOut.continues(unaddressed, AGENT_HEX)).toBe(false);
    expect(
      inboxItemTriggersTurn(message({ id: 'tagged', mentionIds: [AGENT_HEX] }), AGENT_HEX),
    ).toBe(true);
    expect(
      agedOut.continues(
        message({
          id: 'reply',
          replyToMessageId: 'aged-out-agent-answer',
          replyToAuthorId: AGENT_HEX,
        }),
        AGENT_HEX,
      ),
    ).toBe(true);
  });

  it('keeps an unaddressed new exchange silent and selects at most one prior responder', () => {
    const responseRule = rule();
    const first = message({ id: 'first' });
    expect(responseRule.continues(first, AGENT_HEX)).toBe(false);
    expect(responseRule.continues(first, OTHER_AGENT)).toBe(false);

    responseRule.noteReply(AGENT_HEX, [CAPTAIN]);
    responseRule.noteReply(OTHER_AGENT, [CAPTAIN]);
    const followUp = message({ id: 'follow-up' });
    expect(responseRule.continues(followUp, AGENT_HEX)).toBe(false);
    expect(responseRule.continues(followUp, OTHER_AGENT)).toBe(true);
  });

  it('does not revive an older responder after the latest agent has left the Room', () => {
    const responseRule = new AgentResponseRule();
    responseRule.setAgents([AGENT_HEX]);
    responseRule.observeAll([
      message({ id: 'older-live-answer', authorId: AGENT_HEX, requestAuthorId: CAPTAIN }),
      message({
        id: 'latest-retired-answer',
        authorId: OTHER_AGENT,
        requestAuthorId: CAPTAIN,
        agentAuthor: true,
      }),
    ]);

    expect(responseRule.continues(message({ id: 'unaddressed-follow-up' }), AGENT_HEX)).toBe(false);
    expect(responseRule.continues(message({ id: 'retired-follow-up' }), OTHER_AGENT)).toBe(false);
    expect(
      inboxItemTriggersTurn(
        message({
          id: 'explicit-live-agent',
          mentionIds: [AGENT_HEX],
          agentMentionIds: [AGENT_HEX],
        }),
        AGENT_HEX,
      ),
    ).toBe(true);
  });

  it('gives an explicit agent mention precedence over parentless continuity', () => {
    const responseRule = rule();
    responseRule.noteReply(AGENT_HEX, [CAPTAIN]);
    const handoff = message({ id: 'handoff', mentionIds: [OTHER_AGENT] });
    expect(responseRule.continues(handoff, AGENT_HEX)).toBe(false);
    expect(inboxItemTriggersTurn(handoff, OTHER_AGENT)).toBe(true);

    const directReply = message({
      id: 'direct-handoff',
      mentionIds: [OTHER_AGENT],
      replyToMessageId: 'prior-agent-answer',
      replyToAuthorId: AGENT_HEX,
    });
    expect(responseRule.continues(directReply, AGENT_HEX)).toBe(false);
    expect(inboxItemTriggersTurn(directReply, OTHER_AGENT)).toBe(true);
  });

  it('uses server-projected agent mentions when the local roster is stale', () => {
    const responseRule = new AgentResponseRule();
    responseRule.setAgents([AGENT_HEX]);
    responseRule.noteReply(AGENT_HEX, [CAPTAIN]);

    expect(
      responseRule.continues(
        message({
          id: 'new-agent-address',
          mentionIds: [OTHER_AGENT],
          agentMentionIds: [OTHER_AGENT],
        }),
        AGENT_HEX,
      ),
    ).toBe(false);
  });

  it('retains outgoing agent targets for the return exchange until the hop cap', () => {
    const responseRule = rule();
    responseRule.noteReply(AGENT_HEX, [CAPTAIN, OTHER_AGENT]);
    responseRule.observe(
      message({ id: 'other-answer', authorId: OTHER_AGENT, requestAuthorId: AGENT_HEX }),
    );
    expect(
      responseRule.continues(
        message({ id: 'return', authorId: OTHER_AGENT, agentHopCount: 2 }),
        AGENT_HEX,
      ),
    ).toBe(true);
    expect(
      responseRule.continues(
        message({ id: 'capped-return', authorId: OTHER_AGENT, agentHopCount: 3 }),
        AGENT_HEX,
      ),
    ).toBe(false);
  });

  it('retains outgoing human targets for an unmentioned follow-up', () => {
    const responseRule = rule();
    responseRule.noteReply(AGENT_HEX, [PEER]);

    expect(responseRule.continues(message({ id: 'human-return', authorId: PEER }), AGENT_HEX)).toBe(
      true,
    );
  });

  it('expires parentless continuity after 200 later messages', () => {
    const responseRule = rule();
    responseRule.noteReply(AGENT_HEX, [CAPTAIN]);
    responseRule.observeAll(
      Array.from({ length: 200 }, (_, index) =>
        message({ id: `later-message-${index}`, authorId: PEER }),
      ),
    );
    expect(responseRule.continues(message({ id: 'expired' }), AGENT_HEX)).toBe(false);
  });

  it('uses the reply parent when present and stops agent continuity at the hop cap', () => {
    const responseRule = rule();
    expect(
      responseRule.continues(
        message({ id: 'threaded', replyToMessageId: 'parent', replyToAuthorId: AGENT_HEX }),
        AGENT_HEX,
      ),
    ).toBe(true);
    expect(
      responseRule.continues(
        message({ id: 'other-thread', replyToMessageId: 'parent', replyToAuthorId: OTHER_AGENT }),
        AGENT_HEX,
      ),
    ).toBe(false);

    responseRule.observe(
      message({ id: 'agent-address', authorId: AGENT_HEX, mentionIds: [OTHER_AGENT] }),
    );
    expect(
      responseRule.continues(
        message({ id: 'hop-2', authorId: OTHER_AGENT, agentHopCount: 2 }),
        AGENT_HEX,
      ),
    ).toBe(true);
    expect(
      responseRule.continues(
        message({ id: 'hop-3', authorId: OTHER_AGENT, agentHopCount: 3 }),
        AGENT_HEX,
      ),
    ).toBe(false);
  });
});
