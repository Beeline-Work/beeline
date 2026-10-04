import { commandFixtureApi } from './command-fixture.test-support.js';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync, lstatSync, readdirSync, realpathSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AcpClient, AcpTurnBackstopError, type ToolCallEntry } from './acp.js';
import type { BodyConfig } from './config.js';
import type { DaemonApiClient } from './daemon-api-client.js';
import { MonolithRoomTurnLoop, ROOM_PROMPT_BACKSTOP_MS } from './monolith-room-turn.js';
import { identityFromKey, type AgentRuntimeRecord } from './runtime.js';
import { SessionScheduler } from './session-scheduler.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const AGENT_HEX = '11'.repeat(32);
const HUMAN = '22'.repeat(32);

async function runTurn(options: {
  agentCommand: string;
  agentKind: string;
  turnCount?: number;
  /** Applied over the default config: an OpenRouter pin needs a key and a cache. */
  configOverrides?: Partial<BodyConfig>;
  /** Model id the fake harness advertises, so a selection can be applied. */
  advertisedModel?: string;
  /** Daemon operation the server refuses, so a test can fail one write. */
  rejectWrite?: string;
  beforeRun?: (paths: { agentHomeRoot: string; operatorHome: string }) => Promise<void>;
  prompt: (input: {
    agentHomeRoot: string;
    attempt: number;
    /** The ACP delta hook, so a test can stream a draft before it fails. */
    onChunk: (delta: string, full: string, currentRun?: string) => void;
    /** The ACP tool-call hook: every stream update's tool-call snapshot. */
    onToolCalls?: (calls: readonly ToolCallEntry[]) => void;
  }) => Promise<Awaited<ReturnType<AcpClient['sessionPrompt']>>>;
}): Promise<{
  receipts: Array<Record<string, unknown>>;
  posted: Array<Record<string, unknown>>;
  attempts: number;
  promptTimeouts: number[];
  agentHomeRoot: string;
  /** Every daemon write the turn made, in order. */
  writes: string[];
  /** Harness sessions opened across every turn. */
  sessionsOpened: number;
}> {
  const root = await mkdtemp(join(tmpdir(), 'beeline-room-failure-'));
  roots.push(root);
  const agentHomeRoot = join(root, 'agent-home');
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
    agentBinary: options.agentCommand,
    agentKind: options.agentKind,
    agentCommand: options.agentCommand,
    agentArgs: [],
    mcpBinary: '/fake-dev-mcp',
  } as unknown as AgentRuntimeRecord;
  const config: BodyConfig = {
    agentBinary: options.agentCommand,
    agentKind: options.agentKind,
    agentCommand: options.agentCommand,
    agentArgs: [],
    mcpBinary: '/fake-dev-mcp',
    readonlyMcpCommand: '/fake-beeline-mcp',
    agentEnv: {},
    workspaceRoot: join(root, 'room'),
    autoApprovePermissions: true,
    accessPolicy: 'everyone',
    agentHomeRoot,
    operatorHome: join(root, 'operator-home'),
    ...options.configOverrides,
  } as BodyConfig;
  await options.beforeRun?.({ agentHomeRoot, operatorHome: config.operatorHome! });
  let inboxReads = 0;
  const receipts: Array<Record<string, unknown>> = [];
  let cornerOpens = 0;
  const respond = async (name: string, input: Record<string, unknown>) => {
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
      if (inboxReads >= 2 && inboxReads <= (options.turnCount ?? 1) + 1) {
        const requestId = `ask-${inboxReads - 1}`;
        return {
          items: [
            {
              id: requestId,
              authorId: HUMAN,
              createdAt: 1,
              type: 'message',
              body: "what's up",
              attachments: [],
            },
          ],
          cursor: requestId,
        };
      }
      return { items: [], cursor: 'latest' };
    }
    if (name === 'getRoomConversation') return { items: [], cursor: 'latest' };
    if (name === 'getRoomAuthority') return { member: true, principalKind: 'human' };
    return { id: 'write-id', createdAt: 1 };
  };
  const execute = vi.fn(respond);
  const api = {
    execute,
    connection: () => ({
      baseUrl: 'https://server.example',
      daemonToken: 'daemon-token',
      agentId: agent.publicKey,
    }),
  } as unknown as DaemonApiClient;
  const posted: Array<Record<string, unknown>> = [];
  const writes: string[] = [];
  execute.mockImplementation(async (name: string, input: Record<string, unknown>) => {
    writes.push(name);
    if (name === options.rejectWrite) throw new Error(`${name} refused`);
    if (name === 'postRoomMessage') posted.push(input);
    return respond(name, input);
  });
  const acp = new AcpClient({ agentBinary: options.agentCommand, agentEnv: {} });
  vi.spyOn(acp, 'start').mockResolvedValue(undefined);
  const sessionNew = vi.spyOn(acp, 'sessionNew').mockResolvedValue({
    sessionId: 'room-session',
    raw: options.advertisedModel
      ? {
          models: {
            availableModels: [{ modelId: options.advertisedModel }],
            currentModelId: options.advertisedModel,
          },
        }
      : {},
  });
  vi.spyOn(acp, 'canPromptWithImages').mockReturnValue(false);
  vi.spyOn(acp, 'setModel').mockResolvedValue(undefined);
  let attempts = 0;
  const promptTimeouts: number[] = [];
  vi.spyOn(acp, 'sessionPrompt').mockImplementation(
    (_sessionId, _prompt, timeoutMs, onChunk, _activity, onToolCalls) => {
      attempts += 1;
      promptTimeouts.push(timeoutMs);
      return options.prompt({
        agentHomeRoot,
        attempt: attempts,
        onChunk: (delta, full, currentRun) => onChunk?.(delta, full, currentRun),
        onToolCalls: (calls) => onToolCalls?.(calls),
      });
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
    onCornerOpened: () => {
      cornerOpens += 1;
    },
    signal: abort.signal,
    pollMs: 10,
    createAcpClient: () => acp,
  });
  const running = loop.run();
  await vi.waitFor(
    () =>
      expect(
        receipts.filter((receipt) => receipt.status === 'failed' || receipt.status === 'complete'),
      ).toHaveLength(options.turnCount ?? 1),
    { timeout: 5_000 },
  );
  abort.abort();
  await running.catch(() => undefined);
  await scheduler.dispose();
  return {
    receipts,
    posted,
    attempts,
    promptTimeouts,
    agentHomeRoot,
    writes,
    cornerOpens,
    sessionsOpened: sessionNew.mock.calls.length,
  };
}

/** The turn's writes to the live lane and the transcript, in order. */
const laneWrites = (writes: readonly string[]): string[] =>
  writes.filter((name) =>
    ['postAgentDraft', 'postRoomMessage', 'retractAgentLiveOutput'].includes(name),
  );

describe('Room turn failure receipt', () => {
  it('re-links a credential replaced by the harness and retries the turn once', async () => {
    let operatorCredential = '';
    const { receipts, posted, attempts, agentHomeRoot } = await runTurn({
      agentCommand: '/opt/harness/claude-agent-acp',
      agentKind: 'claude',
      beforeRun: async ({ operatorHome }) => {
        operatorCredential = join(operatorHome, '.claude/.credentials.json');
        await mkdir(join(operatorHome, '.claude'), { recursive: true });
        await writeFile(operatorCredential, '{"token":"current-operator-login"}');
      },
      prompt: async ({ agentHomeRoot: activeHome, attempt }) => {
        const isolatedCredential = join(activeHome, 'claude/.credentials.json');
        if (attempt === 1) {
          expect(lstatSync(isolatedCredential).isSymbolicLink()).toBe(true);
          const replacement = `${isolatedCredential}.next`;
          await writeFile(replacement, '{"token":"detached-refresh"}');
          await rename(replacement, isolatedCredential);
          throw new Error(
            'ACP error -32603: Internal error; harness stderr: Failed to authenticate: OAuth session expired and could not be refreshed',
          );
        }
        expect(lstatSync(isolatedCredential).isSymbolicLink()).toBe(true);
        expect(realpathSync(isolatedCredential)).toBe(realpathSync(operatorCredential));
        expect(await readFile(isolatedCredential, 'utf8')).toBe(
          '{"token":"current-operator-login"}',
        );
        return {
          stopReason: 'end_turn',
          updates: [],
          agentText: 'Recovered without another login.',
          toolCalls: [],
        };
      },
    });

    expect(attempts).toBe(2);
    expect(posted.map((message) => message.text)).toEqual(['Recovered without another login.']);
    expect(receipts).toContainEqual(expect.objectContaining({ status: 'complete' }));
    expect(receipts).not.toContainEqual(expect.objectContaining({ status: 'failed' }));
    expect(
      readdirSync(join(agentHomeRoot, 'claude')).filter((name) =>
        name.startsWith('.credentials.json.beeline-quarantine-'),
      ),
    ).toHaveLength(1);
  });

  it('shares the login Claude refreshed through a detached isolated credential', async () => {
    const spent = JSON.stringify({ claudeAiOauth: { refreshToken: 'spent', expiresAt: 1_000 } });
    const rotated = JSON.stringify({
      claudeAiOauth: { refreshToken: 'rotated', expiresAt: 2_000 },
    });
    let operatorCredential = '';
    const { receipts, posted, attempts } = await runTurn({
      agentCommand: '/opt/harness/claude-agent-acp',
      agentKind: 'claude',
      beforeRun: async ({ agentHomeRoot: activeHome, operatorHome }) => {
        // An earlier turn refreshed Claude's login. Its atomic write replaced
        // the shared link, so the rotated refresh token lives only in this
        // Room and the operator copy holds the spent one.
        await mkdir(join(operatorHome, '.claude'), { recursive: true });
        operatorCredential = join(operatorHome, '.claude/.credentials.json');
        await writeFile(operatorCredential, spent);
        await mkdir(join(activeHome, 'claude'), { recursive: true });
        await writeFile(join(activeHome, 'claude/.credentials.json'), rotated);
      },
      prompt: async ({ agentHomeRoot: activeHome }) => {
        const isolated = join(activeHome, 'claude/.credentials.json');
        const credential = await readFile(isolated, 'utf8');
        // Activation wrote the rotated login back and relinked this Room.
        expect(lstatSync(isolated).isSymbolicLink()).toBe(true);
        expect(await readFile(operatorCredential, 'utf8')).toBe(rotated);
        if (credential !== rotated) {
          throw new Error(
            'ACP error -32603: Internal error; harness stderr: Failed to authenticate: OAuth session expired and could not be refreshed',
          );
        }
        return {
          stopReason: 'end_turn',
          updates: [],
          agentText: 'Answered with the refreshed login.',
          toolCalls: [],
        };
      },
    });

    expect(attempts).toBe(1);
    expect(posted.map((message) => message.text)).toEqual(['Answered with the refreshed login.']);
    expect(receipts).toContainEqual(expect.objectContaining({ status: 'complete' }));
  });

  it('Reproduction ROOM-REFRESH-1: writes a refresh made during a turn back once the turn ends', async () => {
    // The stub harness refreshes the way Claude Code does: it writes a temp
    // file and renames it over the Room's credential link.
    const spent = JSON.stringify({ claudeAiOauth: { refreshToken: 'spent', expiresAt: 1_000 } });
    const rotated = JSON.stringify({ claudeAiOauth: { refreshToken: 'rotated', expiresAt: 2_000 } });
    let operatorCredential = '';
    const { agentHomeRoot } = await runTurn({
      agentCommand: '/opt/harness/claude-agent-acp',
      agentKind: 'claude',
      beforeRun: async ({ operatorHome }) => {
        operatorCredential = join(operatorHome, '.claude/.credentials.json');
        await mkdir(join(operatorHome, '.claude'), { recursive: true });
        await writeFile(operatorCredential, spent);
      },
      prompt: async ({ agentHomeRoot: activeHome }) => {
        const isolated = join(activeHome, 'claude/.credentials.json');
        await writeFile(`${isolated}.next`, rotated);
        await rename(`${isolated}.next`, isolated);
        return { stopReason: 'end_turn', updates: [], agentText: 'Answered.', toolCalls: [] };
      },
    });

    // Every other Room and the operator CLI read the shared file; it must not
    // keep the refresh token this Room just spent.
    expect(await readFile(operatorCredential, 'utf8')).toBe(rotated);
    expect(lstatSync(join(agentHomeRoot, 'claude/.credentials.json')).isSymbolicLink()).toBe(true);
  });

  it('writes a Claude refresh made during one turn back before the next turn', async () => {
    const spent = JSON.stringify({ claudeAiOauth: { refreshToken: 'spent', expiresAt: 1_000 } });
    const rotated = JSON.stringify({ claudeAiOauth: { refreshToken: 'rotated', expiresAt: 2_000 } });
    let operatorCredential = '';
    const { receipts, posted, attempts } = await runTurn({
      agentCommand: '/opt/harness/claude-agent-acp',
      agentKind: 'claude',
      turnCount: 2,
      beforeRun: async ({ operatorHome }) => {
        operatorCredential = join(operatorHome, '.claude/.credentials.json');
        await mkdir(join(operatorHome, '.claude'), { recursive: true });
        await writeFile(operatorCredential, spent);
      },
      prompt: async ({ agentHomeRoot, attempt }) => {
        const isolated = join(agentHomeRoot, 'claude/.credentials.json');
        if (attempt === 1) {
          expect(lstatSync(isolated).isSymbolicLink()).toBe(true);
          const refreshed = `${isolated}.next`;
          await writeFile(refreshed, rotated);
          await rename(refreshed, isolated);
          return { stopReason: 'end_turn', updates: [], agentText: 'First turn answered.', toolCalls: [] };
        }
        expect(lstatSync(isolated).isSymbolicLink()).toBe(true);
        expect(await readFile(isolated, 'utf8')).toBe(rotated);
        expect(await readFile(operatorCredential, 'utf8')).toBe(rotated);
        return {
          stopReason: 'end_turn',
          updates: [],
          agentText: 'Second turn answered with the refreshed login.',
          toolCalls: [],
        };
      },
    });

    expect(attempts).toBe(2);
    expect(posted.map((message) => message.text)).toEqual([
      'First turn answered.',
      'Second turn answered with the refreshed login.',
    ]);
    expect(receipts.filter((receipt) => receipt.status === 'complete')).toHaveLength(2);
  });

  it('retries a written-back Claude login once through the shared link', async () => {
    const shared = JSON.stringify({ claudeAiOauth: { refreshToken: 'shared', expiresAt: 1_000 } });
    const detached = JSON.stringify({
      claudeAiOauth: { refreshToken: 'detached', expiresAt: 2_000 },
    });
    let operatorCredential = '';
    const { receipts, posted, attempts } = await runTurn({
      agentCommand: '/opt/harness/claude-agent-acp',
      agentKind: 'claude',
      beforeRun: async ({ agentHomeRoot, operatorHome }) => {
        operatorCredential = join(operatorHome, '.claude/.credentials.json');
        await mkdir(join(operatorHome, '.claude'), { recursive: true });
        await writeFile(operatorCredential, shared);
        await mkdir(join(agentHomeRoot, 'claude'), { recursive: true });
        await writeFile(join(agentHomeRoot, 'claude/.credentials.json'), detached);
      },
      prompt: async ({ agentHomeRoot, attempt }) => {
        const isolated = join(agentHomeRoot, 'claude/.credentials.json');
        // Activation wrote the newer login back; both attempts read it
        // through the shared link.
        expect(lstatSync(isolated).isSymbolicLink()).toBe(true);
        expect(realpathSync(isolated)).toBe(realpathSync(operatorCredential));
        expect(await readFile(isolated, 'utf8')).toBe(detached);
        if (attempt === 1) throw new Error('OAuth session expired and could not be refreshed');
        return {
          stopReason: 'end_turn',
          updates: [],
          agentText: 'Recovered with the shared login.',
          toolCalls: [],
        };
      },
    });

    expect(attempts).toBe(2);
    expect(posted.map((message) => message.text)).toEqual(['Recovered with the shared login.']);
    expect(receipts).toContainEqual(expect.objectContaining({ status: 'complete' }));
  });

  it('names the harness and machine only after the repaired operator login also fails', async () => {
    const { receipts, posted, attempts } = await runTurn({
      agentCommand: '/opt/harness/claude-agent-acp',
      agentKind: 'claude',
      beforeRun: async ({ operatorHome }) => {
        await mkdir(join(operatorHome, '.claude'), { recursive: true });
        await writeFile(join(operatorHome, '.claude/.credentials.json'), '{"token":"expired"}');
      },
      prompt: async () => {
        throw new Error('OAuth session expired and could not be refreshed');
      },
    });

    expect(attempts).toBe(2);
    expect(posted.map((message) => message.text)).toEqual([
      `Claude on ${hostname()} needs a fresh login.`,
    ]);
    expect(receipts).toContainEqual(expect.objectContaining({ status: 'complete' }));
    expect(receipts).not.toContainEqual(expect.objectContaining({ status: 'failed' }));
  });

  it('excuses a turn backstop after the turn opened a corner: complete, no failure line', async () => {
    // The production shape (2026-09-15, #ai-study): Charles's turn opened the
    // corner, the Room session then went quiet, and the timeout reported
    // "could not answer" two minutes before the corner reached `done`. The
    // corner-opened fact is observed live from the stream — a throw out of
    // runPrompt() never produces the result the success path reads — so the
    // timeout settles the turn the same quiet, successful way a corner-opening
    // turn that returns normally without text does.
    const timeout = new AcpTurnBackstopError(ROOM_PROMPT_BACKSTOP_MS, 'session/prompt');
    const { receipts, posted, cornerOpens } = await runTurn({
      agentCommand: '/fake-agent',
      agentKind: 'codex',
      prompt: async ({ onToolCalls }) => {
        onToolCalls?.([
          { id: 'call-1', title: 'mcp__beeline-agent__open_corner', status: 'completed' },
        ]);
        throw timeout;
      },
    });

    expect(receipts).toContainEqual(
      expect.objectContaining({ requestId: 'ask-1', status: 'complete' }),
    );
    expect(receipts).not.toContainEqual(expect.objectContaining({ status: 'failed' }));
    expect(posted).toEqual([]);
    expect(cornerOpens).toBe(1);
  });

  it('commits the prose it streamed when the corner-opening turn then times out', async () => {
    // The reported production loss: the reader watched an answer arrive, the
    // session wedged after the corner opened, and the `complete` receipt ended
    // the draft — leaving the card alone and an empty `live_outputs`. The words
    // already read are the same completion as the card, so they settle durably.
    const timeout = new AcpTurnBackstopError(ROOM_PROMPT_BACKSTOP_MS, 'session/prompt');
    const { receipts, posted, cornerOpens } = await runTurn({
      agentCommand: '/fake-agent',
      agentKind: 'codex',
      prompt: async ({ onChunk, onToolCalls }) => {
        // Run one is progress narration around the tool call; the answer is the
        // run after it, exactly as a prompt that returned would report.
        onChunk(
          'Let me take this into a corner.',
          'Let me take this into a corner.',
          'Let me take this into a corner.',
        );
        onToolCalls?.([
          { id: 'call-1', title: 'mcp__beeline-agent__open_corner', status: 'completed' },
        ]);
        onChunk(
          'Here is what I found: the cards go stale.',
          'Let me take this into a corner.\n\nHere is what I found: the cards go stale.',
          'Here is what I found: the cards go stale.',
        );
        await new Promise((resolve) => setImmediate(resolve));
        throw timeout;
      },
    });

    expect(posted).toEqual([
      expect.objectContaining({
        text: 'Here is what I found: the cards go stale.',
        requestId: 'ask-1',
        triggerMessageId: 'ask-1',
      }),
    ]);
    expect(receipts).toContainEqual(
      expect.objectContaining({ requestId: 'ask-1', status: 'complete' }),
    );
    expect(receipts).not.toContainEqual(expect.objectContaining({ status: 'failed' }));
    expect(cornerOpens).toBe(1);
  });

  it('retracts the draft when the corner-open timeout cannot post its reply', async () => {
    // `settle` posts the reply before it retracts, so a refused reply throws
    // past its own retract. The same server trouble can refuse the `complete`
    // receipt that would otherwise clean the row up, leaving a half-written
    // answer pulsing under a turn the Room never settled.
    const timeout = new AcpTurnBackstopError(ROOM_PROMPT_BACKSTOP_MS, 'session/prompt');
    const { writes, posted } = await runTurn({
      agentCommand: '/fake-agent',
      agentKind: 'codex',
      rejectWrite: 'postRoomMessage',
      prompt: async ({ onChunk, onToolCalls }) => {
        onToolCalls?.([
          { id: 'call-1', title: 'mcp__beeline-agent__open_corner', status: 'completed' },
        ]);
        onChunk('The cards go stale.', 'The cards go stale.', 'The cards go stale.');
        await new Promise((resolve) => setImmediate(resolve));
        throw timeout;
      },
    });

    expect(posted).toEqual([]);
    expect(writes).toContain('postRoomMessage');
    expect(laneWrites(writes).at(-1)).toBe('retractAgentLiveOutput');
  });

  it('still reports failed when the turn backstop hits a turn that opened no corner', async () => {
    // The timeout is doing real work on turns that genuinely wedge. Without a
    // corner to excuse it, a turn backstop keeps its old ending.
    const timeout = new AcpTurnBackstopError(ROOM_PROMPT_BACKSTOP_MS, 'session/prompt');
    const { receipts, posted, cornerOpens } = await runTurn({
      agentCommand: '/fake-agent',
      agentKind: 'codex',
      prompt: () => Promise.reject(timeout),
    });

    const failed = receipts.find((receipt) => receipt.status === 'failed')!;
    expect(failed).toEqual(expect.objectContaining({ requestId: 'ask-1', status: 'failed' }));
    expect(failed.reason).toBe(
      `turn_backstop: no ACP traffic for 30 minutes; last activity: session/prompt`,
    );
    expect(receipts).not.toContainEqual(expect.objectContaining({ status: 'complete' }));
    expect(posted).toEqual([]);
    expect(cornerOpens).toBe(0);
  });

  it('cancels a silent turn and answers the next turn in the retained runtime', async () => {
    const { receipts, posted, promptTimeouts, sessionsOpened } = await runTurn({
      agentCommand: '/fake-agent',
      agentKind: 'codex',
      turnCount: 2,
      prompt: async ({ attempt }) => {
        if (attempt === 1)
          throw new AcpTurnBackstopError(ROOM_PROMPT_BACKSTOP_MS, 'session/prompt');
        return { stopReason: 'end_turn', updates: [], agentText: 'Back again.', toolCalls: [] };
      },
    });

    expect(promptTimeouts).toEqual([1_800_000, 1_800_000]);
    expect(receipts.filter((receipt) => receipt.status !== 'working')).toEqual([
      expect.objectContaining({ requestId: 'ask-1', status: 'failed' }),
      expect.objectContaining({ requestId: 'ask-2', status: 'complete' }),
    ]);
    expect(posted).toEqual([expect.objectContaining({ text: 'Back again.' })]);
    expect(sessionsOpened).toBe(1);
  });

  it('allows a Room model thirty minutes of silence before its backstop', async () => {
    const { promptTimeouts, posted } = await runTurn({
      agentCommand: '/opt/harness/pi-acp',
      agentKind: 'pi',
      prompt: async () => ({
        agentText: 'A late but valid answer',
        toolCalls: [],
        stopReason: 'end_turn',
        raw: {},
      }),
    });

    expect(promptTimeouts).toEqual([ROOM_PROMPT_BACKSTOP_MS]);
    expect(ROOM_PROMPT_BACKSTOP_MS).toBe(1_800_000);
    expect(posted).toEqual([expect.objectContaining({ text: 'A late but valid answer' })]);
  });

  it('reports failed with a distilled, secret-free reason and never a stack trace', async () => {
    const failure = new Error(
      'ACP error -32000: provider error 429 concurrency_limit (Authorization: Bearer sk-or-v1-abcdefghijklmnop)',
    );
    failure.stack = `${failure.message}\n    at AcpClient.request (/opt/beeline/acp.js:984:20)`;
    const { receipts } = await runTurn({
      agentCommand: '/fake-agent',
      agentKind: 'codex',
      prompt: () => Promise.reject(failure),
    });

    const failed = receipts.find((receipt) => receipt.status === 'failed')!;
    expect(failed).toEqual(
      expect.objectContaining({ roomId: 'room-id', requestId: 'ask-1', status: 'failed' }),
    );
    const reason = failed.reason as string;
    expect(reason).toContain('provider error 429 concurrency_limit');
    expect(reason).toContain('[REDACTED]');
    expect(reason).not.toMatch(/sk-or-v1|\n|\bat AcpClient/);
    expect(reason.length).toBeLessThanOrEqual(200);
  });

  it("names pi's recorded provider refusal when pi-acp ends a turn with no content", async () => {
    const { receipts, posted } = await runTurn({
      agentCommand: '/opt/harness/pi-acp',
      agentKind: 'pi',
      prompt: async ({ agentHomeRoot }) => {
        // pi's own session record (layout: $PI_CODING_AGENT_DIR/sessions/<cwd>/<ts>_<id>.jsonl),
        // exactly what pi wrote for Candy's turns on 2026-09-03 while pi-acp streamed nothing.
        const dir = join(agentHomeRoot, 'pi', 'sessions', '--room--');
        await mkdir(dir, { recursive: true });
        await writeFile(
          join(dir, '2026-09-03T17-55-38-000Z_room-session.jsonl'),
          [
            JSON.stringify({ type: 'message', message: { role: 'user', content: [] } }),
            JSON.stringify({
              type: 'message',
              message: {
                role: 'assistant',
                content: [],
                stopReason: 'error',
                errorMessage:
                  '402: {"message":"This request requires more credits, or fewer max_tokens. You requested up to 131072 tokens, but can only afford 10381. To increase, visit https://openrouter.ai/settings/credits and add more credits","code":402}',
              },
            }),
          ].join('\n'),
        );
        return { stopReason: 'end_turn', updates: [], agentText: '', toolCalls: [] };
      },
    });
    expect(posted).toEqual([]);
    const failed = receipts.find((receipt) => receipt.status === 'failed')!;
    const reason = failed.reason as string;
    expect(reason).toMatch(/^provider error 402: This request requires more credits/);
    expect(reason).not.toContain('no durable Room reply');
    expect(reason.length).toBeLessThanOrEqual(200);
  });

  it('retries a context-window overflow once in a fresh session', async () => {
    const overflow =
      "400 This endpoint's maximum context length is 1048576 tokens. However, you requested about 1053212 tokens (109494 of text input, 943718 in the output).";
    const turn = (recovers: boolean) =>
      async ({ agentHomeRoot, attempt }: { agentHomeRoot: string; attempt: number }) => {
        const dir = join(agentHomeRoot, 'pi', 'sessions', '--room--');
        await mkdir(dir, { recursive: true });
        const answered = recovers && attempt > 1;
        await writeFile(
          join(dir, '2026_room-session.jsonl'),
          [
            JSON.stringify({ type: 'message', message: { role: 'user', content: [] } }),
            JSON.stringify({
              type: 'message',
              message: answered
                ? { role: 'assistant', content: [{ type: 'text', text: 'Fresh answer.' }], stopReason: 'stop' }
                : { role: 'assistant', content: [], stopReason: 'error', errorMessage: overflow },
            }),
          ].join('\n'),
        );
        return {
          stopReason: 'end_turn',
          updates: [],
          agentText: answered ? 'Fresh answer.' : '',
          toolCalls: [],
        };
      };
    const warnings: string[] = [];
    const warn = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      warnings.push(args.map(String).join(' '));
    });
    const recovered = await runTurn({
      agentCommand: '/opt/harness/pi-acp',
      agentKind: 'pi',
      prompt: turn(true),
    });
    const exhausted = await runTurn({
      agentCommand: '/opt/harness/pi-acp',
      agentKind: 'pi',
      prompt: turn(false),
    });
    warn.mockRestore();

    expect(recovered.attempts).toBe(2);
    expect(recovered.receipts.some((receipt) => receipt.status === 'failed')).toBe(false);
    expect(JSON.stringify(recovered.posted)).toContain('Fresh answer.');
    expect(warnings.join('\n')).toContain('retrying once in a fresh session');

    // One fresh session only: a second overflow fails the turn, typed so the
    // server does not restart the helper for it.
    expect(exhausted.attempts).toBe(2);
    const failed = exhausted.receipts.find((receipt) => receipt.status === 'failed')!;
    expect(failed.reasonKind).toBe('context-overflow');
  });

  it('describes the stream when a non-pi harness ends a turn with reasoning only', async () => {
    const { receipts } = await runTurn({
      agentCommand: '/fake-agent',
      agentKind: 'codex',
      prompt: async () => ({
        stopReason: 'end_turn',
        agentText: '',
        toolCalls: [],
        updates: [
          {
            sessionId: 'room-session',
            update: {
              sessionUpdate: 'agent_thought_chunk',
              content: { type: 'text', text: 'hmm' },
            },
          },
        ],
      }),
    });
    const failed = receipts.find((receipt) => receipt.status === 'failed')!;
    expect(failed.reason).toBe(
      'harness ended the turn (end_turn) with no answer text; the stream carried only agent_thought_chunk×1',
    );
  });

  it('retries an empty completion on the next pinned provider, then fails naming it', async () => {
    // The C92 failure: the provider accepts a tool-enabled request, returns
    // 200, and says nothing. OpenRouter never falls back for that, so the turn
    // loop must rotate the pin itself.
    const cacheRoot = await mkdtemp(join(tmpdir(), 'beeline-room-routing-'));
    roots.push(cacheRoot);
    const emptyTurn = async ({ agentHomeRoot }: { agentHomeRoot: string }) => {
      const dir = join(agentHomeRoot, 'pi', 'sessions', '--room--');
      await mkdir(dir, { recursive: true });
      await writeFile(
        join(dir, '2026_room-session.jsonl'),
        [
          JSON.stringify({ type: 'message', message: { role: 'user', content: [] } }),
          JSON.stringify({
            type: 'message',
            message: { role: 'assistant', content: [], stopReason: 'end_turn' },
          }),
        ].join('\n'),
      );
      return { stopReason: 'end_turn', updates: [], agentText: '', toolCalls: [] };
    };
    await writeFile(
      join(cacheRoot, 'z-ai_glm-5.3-flash.json'),
      JSON.stringify({
        model: 'z-ai/glm-5.3-flash',
        fetchedAt: Date.now(),
        providers: ['venice', 'phala'],
        bar: 98,
        // A post-C87 cache entry always carries `input` (an array, or `null`
        // when the listing named none), and `limits` the same way; omitting
        // either marks an older entry and forces one live re-ask
        // (`resolveUptimeRouting`), which this fully-cached, network-free
        // test must never trigger.
        input: null,
        limits: null,
      }),
    );
    await writeFile(
      join(cacheRoot, 'z-ai_glm-5.3-flash.probe.json'),
      JSON.stringify({
        model: 'z-ai/glm-5.3-flash',
        fetchedAt: Date.now(),
        answered: [
          { provider: 'venice', latencyMs: 700 },
          { provider: 'phala', latencyMs: 4700 },
        ],
      }),
    );
    const warnings: string[] = [];
    const warn = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      warnings.push(args.map(String).join(' '));
    });
    let secondPin: unknown;
    const { receipts, posted, attempts, agentHomeRoot } = await runTurn({
      agentCommand: '/opt/harness/pi-acp',
      agentKind: 'pi',
      advertisedModel: 'z-ai/glm-5.3-flash',
      configOverrides: {
        agentEnv: { OPENROUTER_API_KEY: 'k' },
        openRouterRoutingCacheDir: cacheRoot,
        modelSelection: { model: 'z-ai/glm-5.3-flash' },
      } as Partial<BodyConfig>,
      prompt: async (input) => {
        if (input.attempt === 2) {
          secondPin = JSON.parse(
            await readFile(join(input.agentHomeRoot, 'pi', 'models.json'), 'utf8'),
          );
        }
        return emptyTurn(input);
      },
    });
    warn.mockRestore();

    // Exactly one retry, and it was pinned to ONE named provider with no
    // fallbacks, so the failure names who actually served it.
    expect(attempts).toBe(2);
    expect(posted).toEqual([]);
    expect(
      (secondPin as Record<string, any>).providers.openrouter.modelOverrides['z-ai/glm-5.3-flash']
        .compat.openRouterRouting,
    ).toEqual({
      only: ['phala'],
      order: ['phala'],
      allow_fallbacks: false,
      require_parameters: false,
    });
    expect(existsSync(join(agentHomeRoot, 'pi', 'models.json'))).toBe(true);
    const failed = receipts.find((receipt) => receipt.status === 'failed')!;
    expect(failed.reason).toBe(
      'the model ended its turn with no text (stop reason end_turn) · served by phala',
    );
    expect(warnings.join('\n')).toContain('routed to venice, phala; retrying on phala');
  });

  it('retracts the draft it was writing when the prompt throws', async () => {
    // The draft is provisional and belongs to a turn in flight. A throw never
    // reaches the settle that would dissolve it, so the half-written answer
    // stayed live on the page — still pulsing — under a turn already reported
    // failed, an answer arriving that never arrives.
    const { writes, posted, receipts } = await runTurn({
      agentCommand: '/fake-agent',
      agentKind: 'codex',
      prompt: async ({ onChunk }) => {
        onChunk('The fix is ', 'The fix is ');
        // Let the draft reach the wire before the provider hangs up.
        await new Promise((resolve) => setImmediate(resolve));
        throw new Error('ACP error -32000: provider closed the stream');
      },
    });

    // Nothing is published in the draft's place: the receipt carries the reason.
    expect(laneWrites(writes)).toEqual(['postAgentDraft', 'retractAgentLiveOutput']);
    expect(posted).toEqual([]);
    expect(receipts).toContainEqual(
      expect.objectContaining({ requestId: 'ask-1', status: 'failed' }),
    );
  });

  it('retracts the draft when the turn fails with no answer to settle', async () => {
    // The other failure shape: the harness returns, having streamed something
    // and finished with nothing durable. The reason goes on the receipt and
    // the lane still has to be closed behind it.
    const { writes, posted } = await runTurn({
      agentCommand: '/fake-agent',
      agentKind: 'codex',
      prompt: async ({ onChunk }) => {
        onChunk('Thinking out ', 'Thinking out ');
        await new Promise((resolve) => setImmediate(resolve));
        return { stopReason: 'end_turn', updates: [], agentText: '', toolCalls: [] };
      },
    });

    expect(posted).toEqual([]);
    expect(laneWrites(writes)).toEqual(['postAgentDraft', 'retractAgentLiveOutput']);
  });

  it('leaves one retract on a turn that answers, not two', async () => {
    // The settle already dissolves the lane. The failure path must not add a
    // second retract to every ordinary turn.
    const { writes, posted } = await runTurn({
      agentCommand: '/fake-agent',
      agentKind: 'codex',
      prompt: async ({ onChunk }) => {
        onChunk('The fix ', 'The fix ');
        await new Promise((resolve) => setImmediate(resolve));
        return {
          stopReason: 'end_turn',
          updates: [],
          agentText: 'The fix is ready.',
          toolCalls: [],
        };
      },
    });

    expect(posted.map((message) => message.text)).toEqual(['The fix is ready.']);
    expect(laneWrites(writes)).toEqual([
      'postAgentDraft',
      'postRoomMessage',
      'retractAgentLiveOutput',
    ]);
  });

  it('posts answer text pi recorded when the ACP stream delivered none', async () => {
    const { receipts, posted } = await runTurn({
      agentCommand: '/opt/harness/pi-acp',
      agentKind: 'pi',
      prompt: async ({ agentHomeRoot }) => {
        const dir = join(agentHomeRoot, 'pi', 'sessions', '--room--');
        await mkdir(dir, { recursive: true });
        await writeFile(
          join(dir, '2026_room-session.jsonl'),
          [
            JSON.stringify({ type: 'message', message: { role: 'user', content: [] } }),
            JSON.stringify({
              type: 'message',
              message: {
                role: 'assistant',
                content: [{ type: 'text', text: 'All good.' }],
                stopReason: 'stop',
              },
            }),
          ].join('\n'),
        );
        return { stopReason: 'end_turn', updates: [], agentText: '', toolCalls: [] };
      },
    });
    expect(posted.map((message) => message.text)).toEqual(['All good.']);
    expect(receipts.some((receipt) => receipt.status === 'complete')).toBe(true);
  });

  it('keeps pi-recorded text when a corner opens with an empty ACP stream', async () => {
    const { receipts, posted } = await runTurn({
      agentCommand: '/opt/harness/pi-acp',
      agentKind: 'pi',
      prompt: async ({ agentHomeRoot }) => {
        const dir = join(agentHomeRoot, 'pi', 'sessions', '--room--');
        await mkdir(dir, { recursive: true });
        await writeFile(
          join(dir, '2026_room-session.jsonl'),
          [
            JSON.stringify({ type: 'message', message: { role: 'user', content: [] } }),
            JSON.stringify({
              type: 'message',
              message: {
                role: 'assistant',
                content: [{ type: 'text', text: 'All good.' }],
                stopReason: 'stop',
              },
            }),
          ].join('\n'),
        );
        return {
          stopReason: 'end_turn',
          updates: [],
          agentText: '',
          toolCalls: [
            { id: 'call-1', title: 'mcp__beeline-agent__open_corner', status: 'completed' },
          ],
        };
      },
    });
    expect(posted.map((message) => message.text)).toEqual(['All good.']);
    expect(receipts.some((receipt) => receipt.status === 'complete')).toBe(true);
  });

  it('fails the turn when the only pi-recorded text is harness preamble', async () => {
    // pi records its startup banner as an assistant message, so a turn whose
    // ACP stream delivered nothing recovers text that sanitizes away entirely.
    // With no corner to complete the turn, that is silence — and silence is a
    // failed turn with a named reason, never a quiet `complete`.
    const { receipts, posted } = await runTurn({
      agentCommand: '/opt/harness/pi-acp',
      agentKind: 'pi',
      prompt: async ({ agentHomeRoot }) => {
        const dir = join(agentHomeRoot, 'pi', 'sessions', '--room--');
        await mkdir(dir, { recursive: true });
        await writeFile(
          join(dir, '2026_room-session.jsonl'),
          [
            JSON.stringify({ type: 'message', message: { role: 'user', content: [] } }),
            JSON.stringify({
              type: 'message',
              message: {
                role: 'assistant',
                content: [
                  { type: 'text', text: 'pi v0.85.1\n\n## Skills\n- /home/agent/skills/skill.md' },
                ],
                stopReason: 'stop',
              },
            }),
          ].join('\n'),
        );
        return { stopReason: 'end_turn', updates: [], agentText: '', toolCalls: [] };
      },
    });
    expect(posted).toEqual([]);
    const failed = receipts.find((receipt) => receipt.status === 'failed');
    expect(failed).toBeDefined();
    // Only the branch that actually READ pi's record phrases it this way, so a
    // record the explainer never located cannot pass this test in its place.
    expect(String(failed!.reason)).toContain(
      'pi recorded the answer but the ACP stream delivered no text',
    );
    expect(receipts.some((receipt) => receipt.status === 'complete')).toBe(false);
  });
});
