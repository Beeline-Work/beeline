/**
 * Regression for the attach-scratch-root sandbox gap: `write_scratch_file`
 * writes strictly inside `BEELINE_ATTACH_SCRATCH_ROOT` (the per-Room
 * `agent-home` dir, see `room-session.ts`/`read-only-mcp.ts`), but a Room
 * session's bwrap plan bound only harness state writable — the scratch root
 * itself stayed under the whole-root `--ro-bind`, so every write failed
 * EROFS and `attach_file` never had anything to send.
 */
import { existsSync } from 'node:fs';
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
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const AGENT_HEX = '11'.repeat(32);
const HUMAN = '22'.repeat(32);

describe('Room session sandbox — attach scratch root', () => {
  it('creates the agent-home scratch root and binds it writable in the bwrap argv', async () => {
    const root = await mkdtemp(join(tmpdir(), 'beeline-room-sandbox-scratch-'));
    roots.push(root);
    const agentHomeRoot = join(root, 'agent-home');
    // Not pre-created: `roomAgentHomeRoot` normally creates it at room
    // start-up, but the turn loop must not assume that already happened.
    expect(existsSync(agentHomeRoot)).toBe(false);

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
      agentHomeRoot,
      operatorHome: join(root, 'operator-home'),
      // A fake but truthy path: `wrapAgentCommand` only needs this to be set
      // to build bwrap argv — it never actually spawns bwrap in this test.
      bwrapPath: '/usr/bin/bwrap',
    } as BodyConfig;
    let inboxReads = 0;
    const execute = vi.fn(async (name: string) => {
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
      if (name === 'getRoomInbox') {
        inboxReads += 1;
        if (inboxReads === 2) {
          return {
            items: [
              {
                id: 'ask-1',
                authorId: HUMAN,
                createdAt: 1,
                type: 'message',
                body: 'send me a picture',
                mentionIds: [agent.publicKey],
                attachments: [],
              },
            ],
            cursor: 'ask-1',
          };
        }
        return { items: [], cursor: 'latest' };
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
    const acp = new AcpClient({ agentBinary: '/fake-agent', agentEnv: {} });
    vi.spyOn(acp, 'start').mockResolvedValue(undefined);
    vi.spyOn(acp, 'sessionNew').mockResolvedValue({ sessionId: 'room-session', raw: {} });
    vi.spyOn(acp, 'canPromptWithImages').mockReturnValue(false);
    const sessionPrompt = vi.spyOn(acp, 'sessionPrompt').mockResolvedValue({
      stopReason: 'end_turn',
      updates: [],
      agentText: 'sure, one sec',
      toolCalls: [],
    });
    let capturedArgs: string[] | undefined;
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
      createAcpClient: (options: ConstructorParameters<typeof AcpClient>[0]) => {
        capturedArgs = options.agentArgs;
        return acp;
      },
    }).run();
    await vi.waitFor(() => expect(sessionPrompt).toHaveBeenCalled(), { timeout: 5_000 });
    abort.abort();
    await loop;
    await scheduler.dispose();

    // The sandbox must create the scratch root before it can bind it —
    // bwrap's `--bind-try` silently no-ops on a path that doesn't exist.
    expect(existsSync(agentHomeRoot)).toBe(true);
    expect(capturedArgs).toBeDefined();
    const argv = capturedArgs!;
    const bindIndex = argv.indexOf('--bind-try');
    expect(bindIndex).toBeGreaterThanOrEqual(0);
    // `--bind-try <scratch> <scratch>` — the same path handed to the MCP
    // server as BEELINE_ATTACH_SCRATCH_ROOT.
    const scratchBindIndex = argv.findIndex(
      (arg, index) => arg === '--bind-try' && argv[index + 1] === agentHomeRoot,
    );
    expect(scratchBindIndex).toBeGreaterThanOrEqual(0);
    expect(argv[scratchBindIndex + 2]).toBe(agentHomeRoot);
  });
});
