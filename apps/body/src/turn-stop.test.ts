import { isControlKind } from '@beeline/api-contract/daemon';
import { commandFixtureApi } from './command-fixture.test-support.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AcpClient, type PromptResult } from './acp.js';
import type { BodyConfig } from './config.js';
import type { DaemonApiClient } from './daemon-api-client.js';
import { MonolithRoomTurnLoop } from './monolith-room-turn.js';
import { identityFromKey, type AgentRuntimeRecord } from './runtime.js';
import { SessionScheduler } from './session-scheduler.js';
import { turnStopRequestId } from './turn-stop.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const AGENT_HEX = '11'.repeat(32);
const HUMAN = '22'.repeat(32);
const AGENT = 'a'.repeat(64);
const OTHER_AGENT = 'b'.repeat(64);

/** The stop as the server writes it: kinded, mentioning the agent, carrying the request id. */
const stopLine = (over: Record<string, unknown> = {}) =>
  ({
    id: 'stop-1',
    authorId: HUMAN,
    createdAt: 9,
    type: 'system',
    body: '@captain stopped @bee · turn cancelled',
    requestId: 'ask-1',
    mentionIds: [AGENT],
    attachments: [],
    systemEvent: {
      subject: { kind: 'person', id: HUMAN, name: '@captain' },
      verb: 'stopped',
      object: { text: '@bee', id: AGENT },
      consequence: 'turn cancelled',
      kind: 'turn-cancelled',
    },
    ...over,
  }) as import('./daemon-api-client.js').InboxItem & { requestId?: string };

describe('the stop a requester wrote', () => {
  it('names the one request it ends', () => {
    expect(turnStopRequestId(stopLine(), AGENT)).toBe('ask-1');
  });

  it('reads the kind and the request id, never the wording', () => {
    // Reworded prose under the same kind still stops the same turn.
    const reworded = stopLine({
      body: '@captain called off @bee · turn cancelled',
      systemEvent: {
        subject: { kind: 'person', id: HUMAN, name: '@captain' },
        verb: 'called off',
        kind: 'turn-cancelled',
      },
    });
    expect(turnStopRequestId(reworded, AGENT)).toBe('ask-1');
    // The same sentence with no kind is an ordinary system line and stops nothing.
    expect(
      turnStopRequestId(
        stopLine({
          systemEvent: { subject: { kind: 'person', name: '@captain' }, verb: 'stopped' },
        }),
        AGENT,
      ),
    ).toBeUndefined();
    // A stop with no request id names no turn, so it silences none.
    expect(turnStopRequestId(stopLine({ requestId: undefined }), AGENT)).toBeUndefined();
  });

  it('reaches only the agent it mentions, and only as a system line', () => {
    expect(turnStopRequestId(stopLine(), OTHER_AGENT)).toBeUndefined();
    expect(turnStopRequestId(stopLine({ mentionIds: [] }), AGENT)).toBeUndefined();
    expect(turnStopRequestId(stopLine({ type: 'message' }), AGENT)).toBeUndefined();
  });

  it('never starts the very turn it exists to end', () => {
    // A control kind is off the subscribed-event path, so a stop can neither
    // wake a subscriber nor be answered as if it were news.
    expect(isControlKind('turn-cancelled')).toBe(true);
  });
});

describe('a Room turn the requester stopped', () => {
  it('cancels the harness session without publishing after its authority ends', async () => {
    const root = await mkdtemp(join(tmpdir(), 'beeline-turn-stop-'));
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
      agentHomeRoot: join(root, 'agent-home'),
      operatorHome: join(root, 'operator-home'),
    } as BodyConfig;

    let promptStarted: (() => void) | undefined;
    const promptRunning = new Promise<void>((resolve) => {
      promptStarted = resolve;
    });
    let releasePrompt: (() => void) | undefined;
    const promptReleased = new Promise<void>((resolve) => {
      releasePrompt = resolve;
    });

    let inboxReads = 0;
    let stopDelivered = false;
    let promptStartedAlready = false;
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
                body: 'Summarise the release please',
                mentionIds: [agent.publicKey],
                attachments: [],
              },
            ],
            cursor: 'ask-1',
          };
        }
        // The stop arrives only once the turn is genuinely mid-run, which is
        // the only moment it has anything to do.
        if (!stopDelivered && promptStartedAlready) {
          stopDelivered = true;
          return {
            items: [
              {
                ...stopLine(),
                mentionIds: [agent.publicKey],
                fixtureCommandAction: 'stop',
                fixtureTurnRequestId: 'ask-1',
              },
            ],
            cursor: 'stop-1',
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
    const sessionCancel = vi.spyOn(acp, 'sessionCancel').mockReturnValue(undefined);
    vi.spyOn(acp, 'sessionPrompt').mockImplementation(async (): Promise<PromptResult> => {
      promptStartedAlready = true;
      promptStarted?.();
      await promptReleased;
      // The harness returns whatever it had written when it was cancelled.
      return {
        stopReason: 'cancelled',
        updates: [],
        agentText: 'Half of an answer, cut off mid-',
        toolCalls: [],
      } as unknown as PromptResult;
    });

    const scheduler = new SessionScheduler({ maxLiveSessions: 2 });
    const abort = new AbortController();
    const loop = new MonolithRoomTurnLoop({
      roomId: 'room-id',
      workspaceId: 'workspace',
      cwd: config.workspaceRoot,
      runtime,
      config,
      api: commandFixtureApi(api, 'room-id', agent.publicKey),
      scheduler,
      health: { poll: vi.fn(), failure: vi.fn(), presence: vi.fn() },
      signal: abort.signal,
      pollMs: 10,
      createAcpClient: () => acp,
    });
    const running = loop.run();
    await promptRunning;
    await vi.waitFor(() => expect(sessionCancel).toHaveBeenCalledWith('room-session'), {
      timeout: 5_000,
    });
    releasePrompt?.();
    await vi.waitFor(() => expect(loop.isBusy()).toBe(false), { timeout: 5_000 });
    abort.abort();
    await running;
    await scheduler.dispose();

    const posted = execute.mock.calls
      .filter(([name]) => name === 'postRoomMessage')
      .map(([, input]) => input as { text: string; mentionIds?: string[] });
    const receipts = execute.mock.calls
      .filter(([name]) => name === 'postAgentTurnReceipt')
      .map(([, input]) => (input as { status: string; heartbeat?: boolean }).status);
    expect(posted).toEqual([]);
    // No terminal receipt is claimed: the server settled this turn `cancelled`
    // before the line that stopped it was even written.
    expect(receipts).not.toContain('complete');
    expect(receipts).not.toContain('failed');
    // The server clears the cancelled draft; the helper sends no late output.
    expect(execute.mock.calls.filter(([name]) => name === 'retractAgentLiveOutput')).toEqual([]);
  });
});
