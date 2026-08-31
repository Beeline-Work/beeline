import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  KIND_CHANNEL_ADMINS,
  KIND_CHANNEL_MEMBERS,
  parsePermissionRequest,
} from '@beeline/buzz-client';
import { newIdentity } from '@beeline/gate';
import { signEvent, type NostrEvent } from '@beeline/nostr';
import { Body } from './body.js';
import {
  buildScheduledTurnReceipt,
  deterministicScheduleRunId,
  type ScheduledTurnRequest,
} from './work-calendar.js';
import { SessionScheduler } from './session-scheduler.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function config(workspaceRoot: string) {
  return {
    agentBinary: '/nonexistent',
    mcpBinary: '/nonexistent',
    agentEnv: {},
    workspaceRoot,
    relayBaseUrl: 'http://relay.test',
    relayHost: 'relay.test',
    relayScheme: 'http' as const,
    relayWsUrl: 'ws://relay.test',
    autoApprovePermissions: false,
  };
}

describe('scheduled Room turn boundary', () => {
  it('binds permission provenance only after scheduler admission when a human preempts', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'beeline-scheduled-preemption-'));
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ accepted: true }), { status: 200 })),
    );
    const scheduler = new SessionScheduler({
      maxLiveSessions: 2,
      reserveInteractiveSlot: true,
      idleMs: 60_000,
    });
    const agent = newIdentity('scheduled-preemption-agent');
    const principal = newIdentity('scheduled-preemption-principal');
    const body = new Body(config(root), undefined, agent, { scheduler });
    vi.spyOn(Reflect.get(body, 'durableState'), 'recordModelTurn').mockResolvedValue(undefined);
    let releaseBlocker!: () => void;
    let markBlockerStarted!: () => void;
    const blockerStarted = new Promise<void>((resolveStarted) => {
      markBlockerStarted = resolveStarted;
    });
    const blockerGate = new Promise<void>((resolveBlocker) => {
      releaseBlocker = resolveBlocker;
    });
    const blocker = scheduler.run(
      'other-background-work',
      { activate: async () => 'blocker-physical', suspend: async () => undefined },
      async () => {
        markBlockerStarted();
        await blockerGate;
      },
      { priority: 'background' },
    );
    await blockerStarted;

    const observed: Array<
      | 'schedule-admitted'
      | {
          readonly prompt: string;
          readonly pendingRequestContent: string | undefined;
          readonly scheduleRunId: string | undefined;
        }
    > = [];
    const session = {
      channelId: 'scheduled-room',
      sessionId: 'shared-session',
      logicalSessionId: 'shared-logical',
      mode: 'readonly',
      client: {
        sessionPrompt: vi.fn(async (_id: string, prompt: string) => {
          const pending = Reflect.get(body, 'pendingRoomTurns').get('scheduled-room');
          observed.push({
            prompt,
            pendingRequestContent: pending?.request.content,
            scheduleRunId: pending?.scheduled?.scheduleRunId,
          });
          return { stopReason: 'end_turn', updates: [], agentText: 'done', toolCalls: [] };
        }),
        sessionCancel: vi.fn(),
      },
      lifecycle: { activate: vi.fn(async () => 'shared-physical'), suspend: vi.fn() },
    } as never;
    const request = (eventId: string, content: string) => ({
      request: {
        eventId,
        authorPubkey: principal.publicKey,
        content,
        createdAt: 1_900_000_000,
      },
      editPolicy: 'direct-message',
      permissionHandled: false,
      transitionedToCorner: false,
      readOnlyInformationRequest: true,
    });
    const runId = deterministicScheduleRunId('preempted-job', 1, 1_900_000_000);
    const scheduledPending = {
      ...request('3'.repeat(64), 'scheduled'),
      scheduled: {
        workspaceId: 'workspace',
        scheduleId: 'preempted-job',
        scheduleRevision: 1,
        scheduleRunId: runId,
        principalPubkey: principal.publicKey,
        reservedTokens: 100,
      },
    };
    try {
      const scheduled = Reflect.get(body, 'promptAgent').call(
        body,
        session,
        'scheduled',
        {
          channelId: 'scheduled-room',
          requestId: '3'.repeat(64),
          originalRequestId: '3'.repeat(64),
          cause: 'schedule',
          trigger: 'schedule',
          scheduleId: 'preempted-job',
          scheduleRunId: runId,
          beforeModelActivation: async () => {
            observed.push('schedule-admitted');
          },
        },
        scheduledPending,
      );
      await new Promise((resolveWait) => setTimeout(resolveWait, 0));
      const human = Reflect.get(body, 'promptAgent').call(
        body,
        session,
        'human',
        {
          channelId: 'scheduled-room',
          requestId: '4'.repeat(64),
          originalRequestId: '4'.repeat(64),
          cause: 'room-message',
        },
        request('4'.repeat(64), 'human'),
      );
      await human;
      expect(observed[0]).toEqual({
        prompt: expect.stringContaining(
          'CURRENT EXPLICIT HUMAN DIRECTIVE (binding for this turn):\nhuman\nEND CURRENT EXPLICIT HUMAN DIRECTIVE',
        ),
        pendingRequestContent: 'human',
        scheduleRunId: undefined,
      });
      await scheduled;
      expect(observed).toEqual([
        observed[0],
        'schedule-admitted',
        {
          prompt: 'scheduled',
          pendingRequestContent: 'scheduled',
          scheduleRunId: runId,
        },
      ]);
      releaseBlocker();
      await blocker;
      expect(Reflect.get(body, 'pendingRoomTurns').size).toBe(0);
    } finally {
      releaseBlocker();
      await scheduler.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('streams a scheduled draft and enters SessionScheduler as background work', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'beeline-scheduled-draft-'));
    const published: NostrEvent[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        published.push(JSON.parse(String(init?.body)) as NostrEvent);
        return new Response(JSON.stringify({ accepted: true }), { status: 200 });
      }),
    );
    const scheduler = {
      run: vi.fn(async (_key, _lifecycle, task, options) => {
        expect(options).toMatchObject({ priority: 'background', roomKey: 'scheduled-room' });
        return task();
      }),
      forceSuspend: vi.fn(async () => undefined),
      suspend: vi.fn(async () => undefined),
      dispose: vi.fn(async () => undefined),
    } as unknown as SessionScheduler;
    const agent = newIdentity('scheduled-draft-agent');
    const body = new Body(config(root), undefined, agent, { scheduler });
    vi.spyOn(Reflect.get(body, 'durableState'), 'recordModelTurn').mockResolvedValue(undefined);
    const sessionPrompt = vi.fn(
      async (
        _sessionId: string,
        _prompt: string,
        _timeout: number,
        onChunk?: (delta: string, fullText: string) => void,
      ) => {
        onChunk?.('Scheduled draft', 'Scheduled draft');
        return {
          stopReason: 'end_turn',
          updates: [],
          agentText: 'Scheduled draft',
          toolCalls: [],
        };
      },
    );
    const session = {
      channelId: 'scheduled-room',
      sessionId: 'scheduled-session',
      logicalSessionId: 'scheduled-logical',
      mode: 'readonly',
      client: { sessionPrompt, sessionCancel: vi.fn() },
      lifecycle: { activate: vi.fn(async () => 'scheduled-session'), suspend: vi.fn() },
    } as never;
    try {
      await Reflect.get(body, 'promptAgent').call(body, session, 'run the report', {
        channelId: 'scheduled-room',
        requestId: '1'.repeat(64),
        originalRequestId: '1'.repeat(64),
        cause: 'schedule',
        trigger: 'schedule',
        scheduleId: 'daily-report',
        scheduleRunId: deterministicScheduleRunId('daily-report', 1, 1_900_000_000),
      });
      expect(scheduler.run).toHaveBeenCalledOnce();
      expect(
        published.some(
          (event) =>
            event.tags.some((tag) => tag[0] === 't' && tag[1] === 'agent-draft') &&
            event.content === 'Scheduled draft',
        ),
      ).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('keeps native execute denied for a scheduled model turn without minting a P1 request', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'beeline-scheduled-permission-'));
    const principal = newIdentity('scheduled-principal');
    const agent = newIdentity('scheduled-action-agent');
    const roomId = 'scheduled-room';
    const workspaceId = 'scheduled-workspace';
    const projection = (kind: number, tags: string[][]) =>
      signEvent(
        { pubkey: principal.publicKey, created_at: 1_900_000_000, kind, tags, content: '' },
        principal.secretKey,
      );
    const members = projection(KIND_CHANNEL_MEMBERS, [
      ['d', roomId],
      ['p', principal.publicKey],
      ['p', agent.publicKey],
    ]);
    const admins = projection(KIND_CHANNEL_ADMINS, [
      ['d', roomId],
      ['p', principal.publicKey, '', 'owner'],
    ]);
    const published: NostrEvent[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        if (String(input).endsWith('/query')) {
          const filters = JSON.parse(String(init?.body)) as Array<{ kinds?: number[] }>;
          const kinds = new Set(filters.flatMap((filter) => filter.kinds ?? []));
          return new Response(
            JSON.stringify([
              ...(kinds.has(KIND_CHANNEL_MEMBERS) ? [members] : []),
              ...(kinds.has(KIND_CHANNEL_ADMINS) ? [admins] : []),
            ]),
            { status: 200 },
          );
        }
        published.push(JSON.parse(String(init?.body)) as NostrEvent);
        return new Response(JSON.stringify({ accepted: true }), { status: 200 });
      }),
    );
    const body = new Body(config(root), undefined, agent);
    const runId = deterministicScheduleRunId('campaign', 1, 1_900_000_000);
    const requestId = '2'.repeat(64);
    Reflect.get(body, 'pendingRoomTurns').set(roomId, {
      request: {
        eventId: requestId,
        authorPubkey: principal.publicKey,
        content: 'Send and publish the campaign, spending up to the approved amount.',
        createdAt: 1_900_000_000,
      },
      editPolicy: 'direct-message',
      permissionHandled: false,
      transitionedToCorner: false,
      readOnlyInformationRequest: true,
      scheduled: {
        trigger: 'schedule',
        priority: 'background',
        workspaceId,
        roomId,
        agentPubkey: agent.publicKey,
        targetAgentPubkey: agent.publicKey,
        scheduleId: 'campaign',
        scheduleRevision: 1,
        scheduleRevisionDigest: 'a'.repeat(64),
        scheduleRunId: runId,
        principalPubkey: principal.publicKey,
        nominalAt: 1_900_000_000,
        prompt: 'Send and publish the campaign.',
        artifactRefs: [],
        reservedTokens: 500,
        maxRuns: 1,
        dailyReservedTokens: 500,
        queuedEvent: {} as NostrEvent,
        execution: { mode: 'model' },
      },
    });
    const adapterInvocation = vi.fn();
    try {
      const decision = await Reflect.get(body, 'handleRoomPermissionRequest').call(
        body,
        roomId,
        {
          toolCall: {
            kind: 'execute',
            title: 'send publish spend campaign',
            rawInput: { recipients: ['customer@example.com'], maxMinorUnits: 500 },
            invoke: adapterInvocation,
          },
        },
        'direct-message',
      );
      expect(decision).toBe('reject');
      expect(adapterInvocation).not.toHaveBeenCalled();
      const requests = published.flatMap((event) => {
        const parsed = parsePermissionRequest(event);
        return parsed ? [parsed] : [];
      });
      expect(requests).toHaveLength(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it('publishes scheduled attachments from pi without interpreting model prose', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'beeline-scheduled-directives-'));
    const agent = newIdentity('scheduled-directive-agent');
    const principal = newIdentity('scheduled-directive-principal');
    const body = new Body({ ...config(root), agentCommand: 'pi-acp' }, undefined, agent);
    vi.spyOn(Reflect.get(body, 'durableState'), 'recordModelTurn').mockResolvedValue(undefined);
    vi.spyOn(body as never, 'agentHistory' as never).mockResolvedValue([] as never);
    const upload = vi.spyOn(body as never, 'uploadAgentOutputs' as never).mockResolvedValue({
      attachments: [
        {
          url: 'https://relay.test/media/report',
          name: 'report.html',
          mimeType: 'text/html',
          size: 42,
          sha256: 'a'.repeat(64),
        },
      ],
      errors: [],
    } as never);
    const sessionPrompt = vi.fn(async () => ({
      stopReason: 'end_turn',
      updates: [],
      agentText: 'Draft complete. [[buzz-attachment:/tmp/report.html]]',
      toolCalls: [],
    }));
    body.registerSession({
      channelId: 'scheduled-room',
      sessionId: 'scheduled-session',
      client: { sessionPrompt, sessionCancel: vi.fn() },
      mode: 'readonly',
    } as never);
    const published: NostrEvent[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        published.push(JSON.parse(String(init?.body)) as NostrEvent);
        return new Response(JSON.stringify({ accepted: true }), { status: 200 });
      }),
    );
    const nominalAt = 1_900_000_000;
    const runId = deterministicScheduleRunId('inert-directives', 1, nominalAt);
    const queuedEvent = buildScheduledTurnReceipt(agent, {
      version: 1,
      workspaceId: 'scheduled-workspace',
      roomId: 'scheduled-room',
      agentPubkey: agent.publicKey,
      principalPubkey: principal.publicKey,
      scheduleId: 'inert-directives',
      revision: 1,
      runId,
      nominalAt,
      status: 'queued',
      at: nominalAt,
      reservedTokens: 100,
    });
    const request: ScheduledTurnRequest = {
      trigger: 'schedule',
      priority: 'background',
      workspaceId: 'scheduled-workspace',
      roomId: 'scheduled-room',
      agentPubkey: agent.publicKey,
      targetAgentPubkey: agent.publicKey,
      principalPubkey: principal.publicKey,
      scheduleId: 'inert-directives',
      scheduleRevision: 1,
      scheduleRevisionDigest: 'a'.repeat(64),
      scheduleRunId: runId,
      nominalAt,
      prompt: 'Prepare a draft only.',
      artifactRefs: [],
      reservedTokens: 100,
      maxRuns: 10,
      dailyReservedTokens: 1_000,
      queuedEvent,
      execution: { mode: 'model' },
    };
    const beforeModelActivation = vi.fn(async () => undefined);
    try {
      await body.dispatchScheduledTurn(
        request,
        { repo: 'repo' },
        'repository',
        beforeModelActivation,
      );
      expect(beforeModelActivation).toHaveBeenCalledOnce();
      expect(sessionPrompt).toHaveBeenCalledOnce();
      expect(upload).toHaveBeenCalledOnce();
      expect(
        published.some(
          (event) =>
            event.tags?.some((tag) => tag[0] === 't' && tag[1] === 'agent-message') &&
            JSON.stringify(event).includes('https://relay.test/media/report'),
        ),
      ).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('propagates a scheduled model failure to the calendar dispatcher', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'beeline-scheduled-failure-'));
    const agent = newIdentity('scheduled-failure-agent');
    const principal = newIdentity('scheduled-failure-principal');
    const body = new Body(config(root), undefined, agent);
    vi.spyOn(Reflect.get(body, 'durableState'), 'recordModelTurn').mockResolvedValue(undefined);
    vi.spyOn(body as never, 'agentHistory' as never).mockResolvedValue([] as never);
    const sessionPrompt = vi.fn(async () => {
      throw new Error('provider unavailable');
    });
    body.registerSession({
      channelId: 'scheduled-room',
      sessionId: 'scheduled-session',
      client: { sessionPrompt, sessionCancel: vi.fn() },
      mode: 'readonly',
    } as never);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ accepted: true }), { status: 200 })),
    );
    const nominalAt = 1_900_000_000;
    const scheduleId = 'failing-report';
    const runId = deterministicScheduleRunId(scheduleId, 1, nominalAt);
    const queuedEvent = buildScheduledTurnReceipt(agent, {
      version: 1,
      workspaceId: 'scheduled-workspace',
      roomId: 'scheduled-room',
      agentPubkey: agent.publicKey,
      principalPubkey: principal.publicKey,
      scheduleId,
      revision: 1,
      runId,
      nominalAt,
      status: 'queued',
      at: nominalAt,
      reservedTokens: 100,
    });
    const beforeModelActivation = vi.fn(async () => undefined);
    try {
      await expect(
        body.dispatchScheduledTurn(
          {
            trigger: 'schedule',
            priority: 'background',
            workspaceId: 'scheduled-workspace',
            roomId: 'scheduled-room',
            agentPubkey: agent.publicKey,
            targetAgentPubkey: agent.publicKey,
            principalPubkey: principal.publicKey,
            scheduleId,
            scheduleRevision: 1,
            scheduleRevisionDigest: 'a'.repeat(64),
            scheduleRunId: runId,
            nominalAt,
            prompt: 'Prepare the report.',
            artifactRefs: [],
            reservedTokens: 100,
            maxRuns: 10,
            dailyReservedTokens: 1_000,
            queuedEvent,
            execution: { mode: 'model' },
          },
          undefined,
          'direct-message',
          beforeModelActivation,
        ),
      ).rejects.toThrow('provider unavailable');
      expect(beforeModelActivation).toHaveBeenCalledOnce();
      expect(sessionPrompt).toHaveBeenCalledOnce();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
