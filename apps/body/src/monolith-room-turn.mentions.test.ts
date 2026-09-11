import { commandFixtureApi } from './command-fixture.test-support.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AcpClient } from './acp.js';
import type { BodyConfig } from './config.js';
import type { DaemonApiClient } from './daemon-api-client.js';
import {
  agentReplyMentionIds,
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
    {
      identityId: OTHER_AGENT,
      kind: 'agent' as const,
      name: 'Goosy',
      handle: 'goosy-2',
      soul: { name: 'Strategist' },
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
    expect(directory).toContain('- @goosy-2 — Goosy (agent)');
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
      api: commandFixtureApi(api, 'room-id', runtime.agent.publicKey),
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

  it('resolves an agent only by its current canonical handle', () => {
    expect(agentReplyMentionIds('@goosy please help', ROSTER(AGENT_HEX), AGENT_HEX)).toEqual([]);
    expect(agentReplyMentionIds('@GOOSY-2 please help', ROSTER(AGENT_HEX), AGENT_HEX)).toEqual([]);
    expect(agentReplyMentionIds('@Strategist please help', ROSTER(AGENT_HEX), AGENT_HEX)).toEqual(
      [],
    );
    expect(agentReplyMentionIds('@a_goosy-2 please help', ROSTER(AGENT_HEX), AGENT_HEX)).toEqual(
      [],
    );
    expect(agentReplyMentionIds('@goosy-2 please help', ROSTER(AGENT_HEX), AGENT_HEX)).toEqual([
      OTHER_AGENT,
    ]);
  });
});
