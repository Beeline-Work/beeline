import { mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { AgentCommand } from '@beeline/api-contract/daemon';
import { ThinDaemonCore } from './thin-core.js';
import { MonolithRoomTurnLoop } from './monolith-room-turn.js';
import { identityFromKey, type AgentRuntimeRecord } from './runtime.js';
import type { DaemonApiClient } from './daemon-api-client.js';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

it('claims and answers in a pending Room while eighty other Room listings reconcile', async () => {
  const root = await mkdtemp(resolve(process.cwd(), '.fast-resume-'));
  vi.stubEnv('XDG_STATE_HOME', root);
  const agent = identityFromKey('11'.repeat(32), 'Bee');
  const rooms = Array.from({ length: 80 }, (_, i) => ({ roomId: `room-${i}`, archived: false }));
  const target = rooms.at(-1)!.roomId;
  const command: AgentCommand = {
    id: 'pending', roomId: target, agentId: agent.publicKey, sourceMessageId: 'human',
    turnRequestId: 'human', rootCommandId: 'pending', rootSourceMessageId: 'human',
    action: 'input', reason: 'human_tag', agentDepth: 0,
    source: { id: 'human', authorId: 'person', body: 'Are you back?', attachments: [], createdAt: 1, type: 'message' },
  };
  const startedAt = performance.now();
  let firstClaimMs: number | undefined;
  let answered = false;
  let listed = 0;
  const execute = vi.fn(async (name: string, input: { roomId?: string }) => {
    if (name === 'getDaemonBootstrap') return {
      workspaceIds: ['workspace'], rooms, pendingRooms: [{ roomId: target }],
    };
    if (name === 'listRoomCorners') {
      await new Promise(resolveWait => setTimeout(resolveWait, 25));
      listed += 1;
      return { corners: [] };
    }
    if (name === 'getAgentCommands') return {
      commandProtocol: 1, commands: input.roomId === target && firstClaimMs === undefined ? [command] : [],
    };
    if (name === 'claimAgentCommand') { firstClaimMs = performance.now() - startedAt; return { id: 'claimed' }; }
    throw new Error(`unexpected operation ${name}`);
  });
  // Exercise the real core, coordinator and command intake without a provider or production account.
  vi.spyOn(MonolithRoomTurnLoop.prototype as unknown as { startPrompt(): void }, 'startPrompt')
    .mockImplementation(function (this: { busy: boolean }) { answered = true; this.busy = false; });
  const core = new ThinDaemonCore({
    agent: { publicKey: agent.publicKey, secretKeyHex: '11'.repeat(32), name: 'Bee' },
    rooms: [], communityId: 'workspace', supervisorRoot: root,
    transport: { kind: 'monolith', baseUrl: 'http://127.0.0.1', daemonToken: 'isolated-fixture' },
  } as unknown as AgentRuntimeRecord, resolve(root, 'agent.json'), { workspaceRoot: root } as never, {
    daemonApi: { execute, liveSubscribe: vi.fn(() => () => undefined) } as unknown as DaemonApiClient,
  });
  const abort = new AbortController();
  const running = core.run({ signal: abort.signal });
  try {
    await vi.waitFor(() => expect(answered).toBe(true));
    console.info('[isolated-fast-resume]', { rooms: rooms.length, firstClaimMs: Math.round(firstClaimMs!), listingsAtAnswer: listed });
    if (process.env.BEELINE_FAST_RESUME_BASELINE === '1') expect(listed).toBe(80);
    else expect(listed).toBeLessThan(80);
  } finally {
    abort.abort();
    await running;
    await rm(root, { recursive: true, force: true });
  }
});

it.each(['room', 'host'] as const)(
  'resumes every Room after restart during %s storage maintenance without waiting for archived cleanup', async lease => {
    const { SessionScheduler } = await import('./session-scheduler.js');
    const root = await mkdtemp(resolve(process.cwd(), '.restart-resume-'));
    const agent = identityFromKey('21'.repeat(32), 'Bee');
    const runtime = {
      agent: { publicKey: agent.publicKey, secretKeyHex: '21'.repeat(32), name: 'Bee' },
      rooms: [], communityId: 'workspace', supervisorRoot: root,
      transport: { kind: 'monolith', baseUrl: 'http://127.0.0.1', daemonToken: 'isolated-fixture' },
    } as unknown as AgentRuntimeRecord;
    const pending = new Map<string, AgentCommand>();
    const listeners = new Map<string, (commands: readonly AgentCommand[]) => void>();
    const answered: string[] = [];
    const claimed: string[] = [];
    const errors: unknown[] = [];
    const execute = vi.fn(async (name: string, input: { roomId?: string; commandId?: string }) => {
      if (name === 'getDaemonBootstrap') return { workspaceIds: ['workspace'],
        rooms: [{ roomId: 'beeline' }, { roomId: 'other' }] };
      if (name === 'listRoomCorners') return { corners: [] };
      if (name === 'getAgentCommands') return { commandProtocol: 1,
        commands: [...pending.values()].filter(c => c.roomId === input.roomId) };
      if (name === 'claimAgentCommand') {
        claimed.push(input.commandId!); pending.delete(input.commandId!); return { id: input.commandId };
      }
      throw new Error(`unexpected operation ${name}`);
    });
    const api = { execute, liveSubscribe: (roomId: string, _cursor: unknown, _items: unknown,
      _state: unknown, _presence: unknown, notify: (commands: readonly AgentCommand[]) => void) => {
      listeners.set(roomId, notify); return () => { listeners.delete(roomId); };
    } } as unknown as DaemonApiClient;
    vi.spyOn(MonolithRoomTurnLoop.prototype as unknown as { prompt(active: { item: { id: string } }): Promise<void> }, 'prompt')
      .mockImplementation(async function (this: { busy: boolean }, active) { answered.push(active.item.id); this.busy = false; });
    const send = (id: string, roomId = 'beeline', action: 'input' | 'restart' = 'input') => {
      const command: AgentCommand = { id, roomId, agentId: agent.publicKey,
        sourceMessageId: id, turnRequestId: id, rootCommandId: id, rootSourceMessageId: id,
        action, reason: action === 'restart' ? 'tagged_lifecycle_restart' : 'human_tag', agentDepth: 0,
        source: { id, authorId: 'owner', body: 'Are you back?', attachments: [], createdAt: 1, type: 'message' } };
      pending.set(id, command); listeners.get(roomId)?.([command]);
    };
    const create = (onRestartRequested = () => undefined) => new ThinDaemonCore(runtime,
      resolve(root, 'agent.json'), { workspaceRoot: root } as never, { daemonApi: api, onRestartRequested });
    const first = create();
    const firstAbort = new AbortController();
    const firstRun = first.run({ signal: firstAbort.signal });
    await vi.waitFor(() => expect(listeners.size).toBe(2));
    await vi.waitFor(() => expect(first.workLoopDiagnostics().stage).toBe('idle'));
    send('before-update');
    await vi.waitFor(() => expect(claimed).toContain('before-update'));
    await vi.waitFor(() => expect(answered).toContain('before-update'));
    firstAbort.abort(); await firstRun;

    let releaseStorage!: () => void;
    const storageHold = new Promise<void>(done => { releaseStorage = done; });
    const maintenance = lease === 'room'
      ? SessionScheduler.withIdleHostRoom('beeline', () => storageHold)
      : SessionScheduler.withIdleHostStorage(() => storageHold);
    const restarted = vi.fn();
    const second = create(restarted);
    const internal = second as unknown as { roomRuntime: {
      retryPendingCornerReaps(): Promise<void>;
    } };
    let releaseCleanup!: () => void;
    const cleanupHold = new Promise<void>(done => { releaseCleanup = done; });
    const cleanup = vi.spyOn(internal.roomRuntime, 'retryPendingCornerReaps').mockReturnValue(cleanupHold);
    const secondAbort = new AbortController();
    const secondRun = second.run({ signal: secondAbort.signal, onProgress: (_status, fault) => {
      if (fault) errors.push(fault);
    } });
    try {
      await vi.waitFor(() => expect(cleanup).toHaveBeenCalled());
      send('after-update');
      send('other-room', 'other');
      // Intake is live even during maintenance; a turn cannot claim its storage lease yet.
      expect(second.activeRoomIds()).toEqual(['beeline', 'other']);
      expect(claimed).not.toContain('after-update');
      releaseStorage(); expect(await maintenance).toBe(true);
      await vi.waitFor(() => expect(answered.slice().sort()).toEqual(['before-update', 'after-update', 'other-room'].sort()));
      // A second lease release must wake the same intake again.
      let releaseAgain!: () => void;
      const again = SessionScheduler.withIdleHostRoom('beeline', () => new Promise<void>(done => { releaseAgain = done; }));
      send('second-maintenance');
      expect(claimed).not.toContain('second-maintenance');
      releaseAgain(); await again;
      await vi.waitFor(() => expect(answered).toContain('second-maintenance'));
      // Lifecycle control bypasses storage and queued input; no model turn is live.
      let releaseLast!: () => void;
      const last = SessionScheduler.withIdleHostRoom('beeline', () => new Promise<void>(done => { releaseLast = done; }));
      try {
        send('still-pending'); send('owner-restart', 'beeline', 'restart');
        await vi.waitFor(() => expect(restarted).toHaveBeenCalledOnce());
        expect(claimed).toContain('owner-restart');
        expect(claimed).not.toContain('still-pending');
        expect(second.activeTurnCount()).toBe(0);
      } finally { releaseLast(); await last; }
      expect(errors).toEqual([]);
    } finally {
      releaseStorage(); await maintenance;
      releaseCleanup(); secondAbort.abort(); await secondRun;
      await rm(root, { recursive: true, force: true });
    }
  },
);
