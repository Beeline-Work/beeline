import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AcpClient } from './acp.js';
import type { BodyConfig } from './config.js';
import type { DaemonApiClient } from './daemon-api-client.js';
import { MonolithRoomTurnLoop } from './monolith-room-turn.js';
import { identityFromKey, type AgentRuntimeRecord } from './runtime.js';
import { SessionScheduler } from './session-scheduler.js';
import { WARM_TRANSCRIPT_OVERLAP } from './warm-transcript.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const AGENT_HEX = '11'.repeat(32);
const HUMAN = '22'.repeat(32);

/**
 * The 250-row fixture the server audit used, as the daemon sees it: the server
 * answers a conversation read with the NEWEST page, so rows 51..250 arrive.
 */
const CONVERSATION = Array.from({ length: 200 }, (_, index) => ({
  id: `row-${index + 51}`,
  authorId: HUMAN,
  createdAt: index + 51,
  type: 'message',
  body: `row ${index + 51}`,
  mentionIds: [],
  attachments: [],
}));

describe('monolith Room turn context', () => {
  it('prompts from the newest page and sends only what is new to a warm session', async () => {
    const root = await mkdtemp(join(tmpdir(), 'beeline-room-context-'));
    roots.push(root);
    const identity = identityFromKey(AGENT_HEX, 'Bee');
    const agent = {
      name: 'Bee',
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
    const conversationReads: Array<Record<string, unknown>> = [];
    const receipts: Array<Record<string, unknown>> = [];
    let inboxReads = 0;
    const ask = (id: string, body: string) => ({
      id,
      authorId: HUMAN,
      createdAt: 900,
      type: 'message',
      body,
      mentionIds: [agent.publicKey],
      attachments: [],
    });
    const execute = vi.fn(async (name: string, input: Record<string, unknown>) => {
      if (name === 'getAgentConfiguration') return { commands: [], yoloMode: false };
      if (name === 'getRoomRepositoryState') return { resolution: 'none' };
      if (name === 'getWorkspaceRoster') {
        return {
          members: [
            { identityId: agent.publicKey, kind: 'agent', name: 'Bee', role: 'member' },
            { identityId: HUMAN, kind: 'human', name: 'Captain', role: 'owner' },
          ],
        };
      }
      if (name === 'postAgentTurnReceipt') receipts.push(input);
      if (name === 'getRoomInbox') {
        inboxReads += 1;
        if (inboxReads === 2) return { items: [ask('ask-1', 'first ask')], cursor: 'ask-1' };
        if (inboxReads === 3) return { items: [ask('ask-2', 'second ask')], cursor: 'ask-2' };
        return { items: [], cursor: 'latest' };
      }
      if (name === 'getRoomConversation') {
        conversationReads.push(input);
        return { items: CONVERSATION, cursor: 'row-250' };
      }
      if (name === 'getRoomAuthority') return { member: true, principalKind: 'human' };
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
        return { stopReason: 'end_turn', updates: [], agentText: 'done', toolCalls: [] };
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
    await vi.waitFor(() => expect(prompts).toHaveLength(2), { timeout: 10_000 });
    abort.abort();
    await running.catch(() => undefined);
    await scheduler.dispose();

    // The conversation read takes the server default, which is the newest page.
    expect(conversationReads[0]).toEqual({ roomId: 'room-id', limit: 200 });
    expect(conversationReads[0]).not.toHaveProperty('window');

    // Turn one on a cold session carries the whole final-80 window the Room
    // turn renders, which now ends on the newest row instead of row 200.
    expect(prompts[0]).toContain('Room conversation so far:');
    expect(prompts[0]).toContain('Captain: row 171');
    expect(prompts[0]).toContain('Captain: row 250');
    expect(prompts[0]).not.toContain('Captain: row 170');
    expect(prompts[0]).toContain('first ask');

    // Turn two on the SAME warm session sends only what is new, plus a recency
    // overlap, and still carries the newest message in full.
    expect(prompts[1]).toContain('New in the Room since your last turn');
    expect(prompts[1]).not.toContain('Captain: row 171');
    expect(prompts[1]).toContain('second ask');
    const overlapRows = CONVERSATION.slice(-WARM_TRANSCRIPT_OVERLAP);
    for (const row of overlapRows) expect(prompts[1]).toContain(`Captain: ${row.body}`);
    expect(prompts[1]).not.toContain(
      `Captain: ${CONVERSATION.at(-WARM_TRANSCRIPT_OVERLAP - 1)!.body}`,
    );
    const rendered = (prompt: string) => prompt.match(/Captain: row \d+/g)?.length ?? 0;
    expect(rendered(prompts[0]!)).toBe(80);
    expect(rendered(prompts[1]!)).toBe(WARM_TRANSCRIPT_OVERLAP);
    expect(receipts.filter((receipt) => receipt.status === 'complete')).toHaveLength(2);
  }, 20_000);
});
