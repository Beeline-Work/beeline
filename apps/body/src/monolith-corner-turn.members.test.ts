import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AcpClient } from './acp.js';
import type { BodyConfig } from './config.js';
import type { DaemonApiClient } from './daemon-api-client.js';
import { MonolithCornerTurnLoop } from './monolith-corner-turn.js';
import { identityFromKey, type AgentRuntimeRecord } from './runtime.js';
import { SessionScheduler } from './session-scheduler.js';

/**
 * A corner is carried by its MEMBERS, so more than one helper now watches one
 * corner. These hold the two rules that keeps that from running the same work
 * twice on one branch: only the opener starts the objective unprompted, and a
 * message that names an agent is answered by that agent alone.
 */
const OPENER_KEY = '11'.repeat(32);
const HELPER_KEY = '33'.repeat(32);
const OPENER = identityFromKey(OPENER_KEY, 'Codex').publicKey;
const HELPER = identityFromKey(HELPER_KEY, 'Goosy').publicKey;
const HUMAN = '22'.repeat(32);
const OTHER_HUMAN = '44'.repeat(32);
const NEW_AGENT_KEY = '55'.repeat(32);
const NEW_AGENT = identityFromKey(NEW_AGENT_KEY, 'Momo').publicKey;

type RosterMember = {
  identityId: string;
  kind: 'human' | 'agent';
  name: string;
  role: 'owner' | 'member';
};

const defaultMembers: readonly RosterMember[] = [
  { identityId: OPENER, kind: 'agent', name: 'Codex', role: 'member' },
  { identityId: HELPER, kind: 'agent', name: 'Goosy', role: 'member' },
  { identityId: HUMAN, kind: 'human', name: 'Captain', role: 'owner' },
  { identityId: OTHER_HUMAN, kind: 'human', name: 'Observer', role: 'member' },
];

const roots: string[] = [];
const execFileAsync = promisify(execFile);
afterEach(async () =>
  Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))),
);

function stored(hex: string, name: string) {
  const identity = identityFromKey(hex, name);
  return {
    name,
    publicKey: identity.publicKey,
    secretKeyHex: Buffer.from(identity.secretKey).toString('hex'),
  };
}

async function runCorner(input: {
  agentKey: string;
  agentName: string;
  isOpener: boolean;
  message?: {
    body: string;
    mentionIds: string[];
    agentMentionIds?: string[];
    replyToMessageId?: string;
    replyToAuthorId?: string;
    agentHopCount?: number;
  };
  /** A server check note in the same poll, to prove one turn per check state. */
  checkNote?: boolean;
  initialRosterFailure?: boolean;
  lostPostResponse?: boolean;
  initialMembers?: readonly RosterMember[];
  refreshedMembers?: readonly RosterMember[];
  inboxItems?: readonly {
    id: string;
    authorId: string;
    createdAt: number;
    type: 'message' | 'system';
    body: string;
    mentionIds: string[];
    agentMentionIds?: string[];
    agentAuthor?: boolean;
    systemEvent?: { verb: string };
  }[];
  /** Durable replies already in the corner, by author. */
  history?: {
    authorId: string;
    body: string;
    mentionIds?: string[];
    requestAuthorId?: string;
    replyToMessageId?: string;
    replyToAuthorId?: string;
  }[];
}): Promise<{ prompts: string[]; posts: number }> {
  const root = await mkdtemp(join(tmpdir(), 'beeline-corner-members-'));
  roots.push(root);
  await execFileAsync('git', ['init', root]);
  const agent = stored(input.agentKey, input.agentName);
  const runtime = {
    agentId: input.agentKey,
    agent,
    rooms: [],
    supervisorRoot: root,
    transport: {
      kind: 'monolith',
      baseUrl: 'https://server.example',
      daemonToken: 'daemon-token',
    },
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
  const abort = new AbortController();
  let closeReads = 0;
  let rosterReads = 0;
  let committedReply = false;
  let lostPostResponse = false;
  const execute = vi.fn(async (name: string) => {
    if (name === 'getAgentConfiguration') return { commands: [] };
    if (name === 'getWorkspaceRoster') {
      rosterReads += 1;
      if (input.initialRosterFailure && rosterReads === 1) throw new Error('roster unavailable');
      return {
        members:
          rosterReads > 1
            ? (input.refreshedMembers ?? input.initialMembers ?? defaultMembers)
            : (input.initialMembers ?? defaultMembers),
      };
    }
    if (name === 'getRoomInbox') return { items: [], cursor: 'latest' };
    if (name === 'getRoomConversation') {
      return {
        items: [
          ...(input.history ?? []).map((entry, index) => ({
            id: `history-${index}`,
            authorId: entry.authorId,
            createdAt: 1,
            type: 'message',
            body: entry.body,
            mentionIds: entry.mentionIds ?? [],
            ...(entry.requestAuthorId ? { requestAuthorId: entry.requestAuthorId } : {}),
            ...(entry.replyToMessageId ? { replyToMessageId: entry.replyToMessageId } : {}),
            ...(entry.replyToAuthorId ? { replyToAuthorId: entry.replyToAuthorId } : {}),
            attachments: [],
          })),
          ...(committedReply
            ? [
                {
                  id: 'committed-reply',
                  authorId: agent.publicKey,
                  createdAt: 3,
                  type: 'message',
                  body: 'Done.',
                  mentionIds: [HUMAN],
                  attachments: [],
                },
              ]
            : []),
        ],
        cursor: 'latest',
      };
    }
    if (name === 'getCornerCloseRequests') {
      closeReads += 1;
      if (closeReads === 1) {
        return {
          items: [
            ...(input.inboxItems
              ? input.inboxItems.map((item) => ({ ...item, attachments: [] }))
              : input.message
              ? [
                  {
                    id: 'human-msg',
                    authorId: HUMAN,
                    createdAt: 2,
                    type: 'message',
                    body: input.message.body,
                    mentionIds: input.message.mentionIds,
                    agentMentionIds: input.message.agentMentionIds ?? [],
                    ...(input.message.replyToMessageId
                      ? { replyToMessageId: input.message.replyToMessageId }
                      : {}),
                    ...(input.message.replyToAuthorId
                      ? { replyToAuthorId: input.message.replyToAuthorId }
                      : {}),
                    ...(input.message.agentHopCount !== undefined
                      ? { agentHopCount: input.message.agentHopCount }
                      : {}),
                    attachments: [],
                  },
                ]
              : []),
            ...(input.checkNote
              ? [
                  {
                    id: 'check-note',
                    authorId: HUMAN,
                    createdAt: 3,
                    type: 'system',
                    body: 'GitHub passed a check · unit',
                    mentionIds: [],
                    attachments: [],
                    systemEvent: { verb: 'passed a check' },
                  },
                ]
              : []),
          ],
          cursor: 'human-msg',
        };
      }
      if (input.lostPostResponse && closeReads === 2) {
        return {
          items: [
            {
              id: 'follow-up',
              authorId: HUMAN,
              createdAt: 4,
              type: 'message',
              body: 'Please continue.',
              mentionIds: [],
              attachments: [],
            },
          ],
          cursor: 'follow-up',
        };
      }
      return { items: [], cursor: 'latest', closeRequested: true };
    }
    if (name === 'getRoomAuthority') return { member: true, principalKind: 'human' };
    if (name === 'postRoomMessage' && input.lostPostResponse && !lostPostResponse) {
      committedReply = true;
      lostPostResponse = true;
      throw new Error('post response lost');
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
  vi.spyOn(acp, 'start').mockResolvedValue(undefined);
  vi.spyOn(acp, 'sessionNew').mockResolvedValue({ sessionId: 'corner-session', raw: {} });
  const prompts: string[] = [];
  vi.spyOn(acp, 'sessionPrompt').mockImplementation(async (_session, prompt) => {
    prompts.push(String(prompt));
    return { stopReason: 'end_turn', updates: [], agentText: 'Done.', toolCalls: [] };
  });
  const scheduler = new SessionScheduler({ maxLiveSessions: 2 });
  await new MonolithCornerTurnLoop({
    cornerId: 'corner-id',
    parentRoomId: 'room-id',
    workspaceId: 'workspace',
    ...(input.isOpener ? {} : { openedBy: OPENER }),
    objective: 'Rip out the legacy path',
    worktreePath: root,
    repository: {
      featureBranch: 'feature/corner-legacy',
      targetBranch: 'main',
      gitCommonDir: join(root, '.git'),
      githubToken: 'token',
    },
    runtime,
    config,
    api,
    scheduler,
    signal: abort.signal,
    // Exercise the older-server polling fallback without making the unit test
    // wait for its production interval.
    pollMs: 0,
    onPoll: vi.fn(),
    onFailure: vi.fn(),
    onCloseRequested: vi.fn(async () => undefined),
    createAcpClient: () => acp,
  }).run();
  await scheduler.dispose();
  return {
    prompts,
    posts: execute.mock.calls.filter(([name]) => name === 'postRoomMessage').length,
  };
}

describe('a corner carried by its members', () => {
  it('starts the objective for the opener and for nobody else', async () => {
    const opener = await runCorner({
      agentKey: OPENER_KEY,
      agentName: 'Codex',
      isOpener: true,
      message: { body: 'thanks', mentionIds: [] },
    });
    expect(opener.prompts[0]).toContain('Rip out the legacy path');

    // The helper has never replied here either, so a "have I answered yet?"
    // check alone would have it re-run the whole objective on one branch.
    const helper = await runCorner({
      agentKey: HELPER_KEY,
      agentName: 'Goosy',
      isOpener: false,
      message: { body: 'thanks', mentionIds: [] },
      history: [{ authorId: OPENER, body: 'Started on it.' }],
    });
    expect(helper.prompts).toEqual([]);
  });

  it('wakes the member that was addressed, and only that member', async () => {
    // The motivating incident: the opener ran out of credits and the captain
    // asked another member to carry it on.
    const helper = await runCorner({
      agentKey: HELPER_KEY,
      agentName: 'Goosy',
      isOpener: false,
      message: { body: '@Goosy can you pick up where Codex left off?', mentionIds: [HELPER] },
      history: [{ authorId: OPENER, body: 'Started on it.' }],
    });
    expect(helper.prompts).toHaveLength(1);
    expect(helper.prompts[0]).toContain('pick up where Codex left off');

    const bystander = await runCorner({
      agentKey: OPENER_KEY,
      agentName: 'Codex',
      isOpener: true,
      message: { body: '@Goosy can you pick up where Codex left off?', mentionIds: [HELPER] },
      history: [{ authorId: OPENER, body: 'Started on it.' }],
    });
    expect(bystander.prompts).toEqual([]);
  });

  it('rebuilds committed continuity after a lost final-post response', async () => {
    const helper = await runCorner({
      agentKey: HELPER_KEY,
      agentName: 'Goosy',
      isOpener: false,
      lostPostResponse: true,
      message: { body: '@Goosy can you take this?', mentionIds: [HELPER] },
      history: [{ authorId: OPENER, body: 'Started on it.' }],
    });

    expect(helper.prompts).toHaveLength(2);
    expect(helper.prompts[1]).toContain('Please continue.');
  }, 20_000);

  it('recovers the roster before continuing retained sender history', async () => {
    const helper = await runCorner({
      agentKey: HELPER_KEY,
      agentName: 'Goosy',
      isOpener: false,
      initialRosterFailure: true,
      message: { body: 'Please continue.', mentionIds: [] },
      history: [{ authorId: HELPER, body: 'I started this.', requestAuthorId: HUMAN }],
    });

    expect(helper.prompts).toHaveLength(1);
    expect(helper.prompts[0]).toContain('Please continue.');
  });

  it('starts one check turn for the member carrying the corner, not one per member', async () => {
    // A check note is ONE server fact. Every member agent now watches the
    // corner, so without a carrier it would start a turn in each of them.
    const carrying = await runCorner({
      agentKey: HELPER_KEY,
      agentName: 'Goosy',
      isOpener: false,
      checkNote: true,
      history: [
        { authorId: OPENER, body: 'Started on it.' },
        { authorId: HELPER, body: 'Picked it up and pushed.' },
      ],
    });
    expect(carrying.prompts).toHaveLength(1);
    expect(carrying.prompts[0]).toContain('passed a check');

    const handedOver = await runCorner({
      agentKey: OPENER_KEY,
      agentName: 'Codex',
      isOpener: true,
      checkNote: true,
      history: [
        { authorId: OPENER, body: 'Started on it.' },
        { authorId: HELPER, body: 'Picked it up and pushed.' },
      ],
    });
    expect(handedOver.prompts).toEqual([]);
  });

  it('continues only the agent already conversing with this sender', async () => {
    const opener = await runCorner({
      agentKey: OPENER_KEY,
      agentName: 'Codex',
      isOpener: true,
      message: { body: 'please continue', mentionIds: [] },
      history: [
        { authorId: OPENER, body: 'Started on it.', requestAuthorId: HUMAN },
        { authorId: OTHER_HUMAN, body: 'One side observation.' },
      ],
    });
    expect(opener.prompts).toHaveLength(1);
    expect(opener.prompts[0]).toContain('please continue');

    const helper = await runCorner({
      agentKey: HELPER_KEY,
      agentName: 'Goosy',
      isOpener: false,
      message: { body: 'please continue', mentionIds: [] },
      history: [
        { authorId: OPENER, body: 'Started on it.', requestAuthorId: HUMAN },
        { authorId: OTHER_HUMAN, body: 'One side observation.' },
      ],
    });
    expect(helper.prompts).toEqual([]);
  });

  it('keeps an unaddressed message silent when its sender has no active exchange', async () => {
    const opener = await runCorner({
      agentKey: OPENER_KEY,
      agentName: 'Codex',
      isOpener: true,
      message: { body: 'anyone around?', mentionIds: [] },
      history: [
        { authorId: OPENER, body: 'Answered somebody else.', requestAuthorId: OTHER_HUMAN },
      ],
    });
    expect(opener.prompts).toEqual([]);
  });

  it('does not continue when a newly joined agent is explicitly addressed', async () => {
    const opener = await runCorner({
      agentKey: OPENER_KEY,
      agentName: 'Codex',
      isOpener: true,
      message: {
        body: '@new helper, please take this.',
        mentionIds: [NEW_AGENT],
        agentMentionIds: [NEW_AGENT],
      },
      history: [{ authorId: OPENER, body: 'Started on it.', requestAuthorId: HUMAN }],
    });

    expect(opener.prompts).toEqual([]);
  });

  it('hands a check turn to a newly joined replying member', async () => {
    const joinedMembers = [
      ...defaultMembers,
      { identityId: NEW_AGENT, kind: 'agent' as const, name: 'Momo', role: 'member' as const },
    ];
    const check = {
      id: 'check-note',
      authorId: HUMAN,
      createdAt: 4,
      type: 'system' as const,
      body: 'GitHub passed a check · unit',
      mentionIds: [],
      systemEvent: { verb: 'passed a check' },
    };
    const [opener, joined] = await Promise.all([
      runCorner({
        agentKey: OPENER_KEY,
        agentName: 'Codex',
        isOpener: true,
        initialMembers: defaultMembers,
        refreshedMembers: joinedMembers,
        history: [{ authorId: OPENER, body: 'Started on it.' }],
        inboxItems: [
          {
            id: 'joined-reply',
            authorId: NEW_AGENT,
            createdAt: 3,
            type: 'message',
            body: 'I picked this up.',
            mentionIds: [],
            agentAuthor: true,
          },
          check,
        ],
      }),
      runCorner({
        agentKey: NEW_AGENT_KEY,
        agentName: 'Momo',
        isOpener: false,
        initialMembers: joinedMembers,
        history: [
          { authorId: OPENER, body: 'Started on it.' },
          { authorId: NEW_AGENT, body: 'I picked this up.' },
        ],
        inboxItems: [
          {
            id: 'addressed-joiner',
            authorId: HUMAN,
            createdAt: 2,
            type: 'message',
            body: '@Momo please take this.',
            mentionIds: [NEW_AGENT],
            agentMentionIds: [NEW_AGENT],
          },
          check,
        ],
      }),
    ]);

    expect(opener.prompts).toEqual([]);
    expect(joined.prompts).toHaveLength(2);
    expect(joined.prompts[0]).toContain('please take this');
    expect(joined.posts).toBeGreaterThan(0);
    expect(joined.prompts[1]).toContain('passed a check');
  });
});
