import { commandFixtureApi } from './command-fixture.test-support.js';
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

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const AGENT_HEX = '11'.repeat(32);
const HUMAN = '22'.repeat(32);

describe('monolith Room turn institutional-memory prefetch', () => {
  it('starts the snapshot fetch before activation, and serves a snapshot slower than the raw budget when it still beats activation', async () => {
    vi.stubEnv('BEELINE_INSTITUTIONAL_MEMORY_ENABLED', 'true');
    const root = await mkdtemp(join(tmpdir(), 'beeline-room-memory-prefetch-'));
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
    const order: string[] = [];
    const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    const receipts: Array<Record<string, unknown>> = [];
    let inboxReads = 0;
    const execute = vi.fn(async (name: string, _input: Record<string, unknown>) => {
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
      if (name === 'postAgentTurnReceipt') receipts.push(_input);
      if (name === 'getRoomInbox') {
        inboxReads += 1;
        if (inboxReads === 1) {
          return {
            items: [
              {
                id: 'ask-1',
                authorId: HUMAN,
                createdAt: 1,
                type: 'message',
                body: 'first ask',
                attachments: [],
              },
            ],
            cursor: 'ask-1',
          };
        }
        return { items: [], cursor: 'latest' };
      }
      if (name === 'listRoomCorners') return { corners: [] };
      if (name === 'getInstitutionalContext') {
        // Activation (below) takes 300ms; this snapshot alone needs 250ms —
        // longer than the raw 200ms budget on its own, but shorter than
        // activation, so a fetch started alongside activation (not after it)
        // has already resolved by the time the turn asks for it.
        order.push('institutional-context');
        await delay(250);
        return {
          snapshotRevision: 1,
          text: 'Prefetched Room institutional snapshot',
          itemIds: ['memory-1'],
          totalBytes: 39,
          omitted: {},
        };
      }
      if (name === 'getRoomConversation') return { items: [], cursor: 'latest' };
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
    const sessionNew = vi.spyOn(acp, 'sessionNew').mockImplementation(async () => {
      order.push('session-new');
      await delay(300);
      return { sessionId: 'room-session', raw: {} };
    });
    vi.spyOn(acp, 'stop').mockResolvedValue(undefined);
    vi.spyOn(acp, 'canPromptWithImages').mockReturnValue(false);
    vi.spyOn(acp, 'isAlive', 'get').mockReturnValue(true);
    const sessionPrompt = vi
      .spyOn(acp, 'sessionPrompt')
      .mockImplementation(async (_sessionId: string, prompt: unknown) => {
        prompts.push(typeof prompt === 'string' ? prompt : JSON.stringify(prompt));
        return { stopReason: 'end_turn', updates: [], agentText: 'done', toolCalls: [] };
      });
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
    abort.abort();
    await running.catch(() => undefined);
    await scheduler.dispose();

    // The fetch was kicked off before activation was even called, not after
    // it resolved.
    expect(order).toEqual(['institutional-context', 'session-new']);
    expect(sessionNew).toHaveBeenCalledOnce();
    // A snapshot that took longer than the raw 200ms budget on its own is
    // still served, because it was already in flight once activation's own
    // 300ms gave it somewhere to finish.
    expect(prompts[0]).toContain('Prefetched Room institutional snapshot');
    expect(receipts.some((receipt) => receipt.status === 'complete')).toBe(true);
  }, 10_000);
});
