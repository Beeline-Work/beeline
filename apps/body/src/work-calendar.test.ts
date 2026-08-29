import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createIdentity, type Identity } from '@beeline/buzz-client';
import type { NostrEvent } from '@beeline/nostr';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DurableWorkCalendarState,
  SCHEDULED_TURN_TAG,
  WORK_SCHEDULE_PAUSED_TAG,
  WORK_SCHEDULE_RUNTIME_TAG,
  WorkCalendar,
  buildWorkSchedule,
  buildWorkScheduleProjection,
  buildScheduledTurnReceipt,
  deterministicScheduleRunId,
  nextWorkOccurrence,
  parseScheduledTurnReceipt,
  previousWorkOccurrence,
  type ScheduleAuthorityResult,
  type WorkCalendarDependencies,
  type WorkCalendarStore,
  type WorkScheduleRuntimeState,
  type WorkScheduleV1,
} from './work-calendar.js';

const roots: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function durableState(): Promise<{ store: DurableWorkCalendarState; path: string }> {
  const root = await mkdtemp(resolve(tmpdir(), 'beeline-work-calendar-'));
  roots.push(root);
  const path = resolve(root, 'calendar.json');
  return { store: new DurableWorkCalendarState(path), path };
}

class MemoryStore implements WorkCalendarStore {
  readonly values = new Map<string, WorkScheduleRuntimeState>();
  readonly receipts = new Map<string, NostrEvent>();
  failNextPut = false;

  async load(): Promise<void> {}
  async states(): Promise<WorkScheduleRuntimeState[]> {
    return [...this.values.values()].map((value) => structuredClone(value));
  }
  async put(value: WorkScheduleRuntimeState): Promise<void> {
    if (this.failNextPut) {
      this.failNextPut = false;
      throw new Error('simulated durable write crash');
    }
    this.values.set(value.scheduleId, structuredClone(value));
  }
  async putWithReceipt(value: WorkScheduleRuntimeState, event: NostrEvent): Promise<void> {
    if (this.failNextPut) {
      this.failNextPut = false;
      throw new Error('simulated durable write crash');
    }
    this.values.set(value.scheduleId, structuredClone(value));
    this.receipts.set(event.id, event);
  }
  async reserveReceipt(event: NostrEvent): Promise<void> {
    this.receipts.set(event.id, event);
  }
  async pendingReceipts(): Promise<NostrEvent[]> {
    return [...this.receipts.values()];
  }
  async markReceiptDelivered(eventId: string): Promise<void> {
    this.receipts.delete(eventId);
  }
}

function scheduleFixture(
  agent: Identity,
  principal: Identity,
  overrides: Partial<WorkScheduleV1> = {},
): WorkScheduleV1 {
  return {
    version: 1,
    scheduleId: randomUUID(),
    revision: 1,
    workspaceId: 'workspace-one',
    roomId: randomUUID(),
    agentPubkey: agent.publicKey,
    principalPubkey: principal.publicKey,
    prompt: 'Prepare the scheduled research draft.',
    cadence: { type: 'interval', everySeconds: 60, anchorAt: 1_900_000_000 },
    startsAt: 1_900_000_000,
    expiresAt: 1_900_100_000,
    maxRuns: 20,
    perRunReservedTokens: 100,
    dailyReservedTokens: 10_000,
    catchUp: 'latest-one',
    maxConsecutiveFailures: 3,
    status: 'active',
    ...overrides,
  };
}

async function calendarFixture(
  options: {
    schedule?: WorkScheduleV1;
    agent?: Identity;
    principal?: Identity;
    scheduleEvents?: NostrEvent[];
    now?: number;
    store?: WorkCalendarStore;
    authority?: ScheduleAuthorityResult | (() => Promise<ScheduleAuthorityResult>);
    validateArtifacts?: WorkCalendarDependencies['validateArtifacts'];
    missionAction?: WorkCalendarDependencies['missionAction'];
    publish?: (event: NostrEvent) => Promise<void>;
    dispatch?: WorkCalendarDependencies['dispatch'];
  } = {},
) {
  const agent = options.agent ?? createIdentity();
  const principal = options.principal ?? createIdentity();
  let now = options.now ?? 1_900_000_000;
  const schedule = options.schedule ?? scheduleFixture(agent, principal);
  const scheduleEvents = options.scheduleEvents ?? [
    buildWorkSchedule(principal, schedule, { createdAt: schedule.startsAt - 10 }),
  ];
  const published: NostrEvent[] = [];
  const dispatch =
    options.dispatch ??
    vi.fn(async (_request, beforeModelActivation) => {
      await beforeModelActivation();
    });
  const store = options.store ?? new MemoryStore();
  const calendar = new WorkCalendar({
    identity: agent,
    workspaceId: schedule.workspaceId,
    store,
    readSchedules: async () => scheduleEvents,
    authorize: async () =>
      typeof options.authority === 'function'
        ? options.authority()
        : (options.authority ?? { authorized: true }),
    ...(options.validateArtifacts ? { validateArtifacts: options.validateArtifacts } : {}),
    ...(options.missionAction ? { missionAction: options.missionAction } : {}),
    publish: options.publish ?? (async (event) => published.push(event)),
    dispatch,
    now: () => now,
    resyncSeconds: 3_600,
    retrySeconds: 5,
  });
  return {
    agent,
    principal,
    schedule,
    scheduleEvents,
    published,
    dispatch,
    store,
    calendar,
    setNow(value: number) {
      now = value;
    },
  };
}

describe('work schedule occurrence math', () => {
  const agent = createIdentity();
  const principal = createIdentity();
  const base = scheduleFixture(agent, principal, { startsAt: 0, expiresAt: 2_000_000_000 });

  it('computes interval, cron, daily, and leap-day occurrences', () => {
    const interval = {
      ...base,
      cadence: { type: 'interval' as const, everySeconds: 900, anchorAt: 100 },
    };
    expect(nextWorkOccurrence(interval, 999)).toBe(1_000);
    expect(previousWorkOccurrence(interval, 1_001)).toBe(1_000);

    const daily = {
      ...base,
      cadence: { type: 'daily' as const, localTime: '09:15', timezone: 'Europe/London' },
    };
    expect(
      new Date(nextWorkOccurrence(daily, Date.parse('2026-01-01T09:15:00Z') / 1_000)! * 1_000),
    ).toEqual(new Date('2026-01-02T09:15:00Z'));

    const leap = {
      ...base,
      cadence: { type: 'cron' as const, expression: '0 0 29 2 *', timezone: 'UTC' },
    };
    expect(
      new Date(nextWorkOccurrence(leap, Date.parse('2023-03-01T00:00:00Z') / 1_000)! * 1_000),
    ).toEqual(new Date('2024-02-29T00:00:00Z'));
  });

  it('runs a missing spring-forward wall time at the next valid instant', () => {
    const daily = {
      ...base,
      cadence: { type: 'daily' as const, localTime: '02:30', timezone: 'America/New_York' },
    };
    expect(
      new Date(nextWorkOccurrence(daily, Date.parse('2024-03-09T08:00:00Z') / 1_000)! * 1_000),
    ).toEqual(new Date('2024-03-10T07:00:00Z'));
  });

  it('runs a repeated fall-back wall time once at its first occurrence', () => {
    const daily = {
      ...base,
      cadence: { type: 'daily' as const, localTime: '01:30', timezone: 'America/New_York' },
    };
    const first = nextWorkOccurrence(daily, Date.parse('2024-11-03T04:00:00Z') / 1_000)!;
    expect(new Date(first * 1_000)).toEqual(new Date('2024-11-03T05:30:00Z'));
    expect(new Date(nextWorkOccurrence(daily, first)! * 1_000)).toEqual(
      new Date('2024-11-04T06:30:00Z'),
    );
    expect(
      new Date(previousWorkOccurrence(daily, Date.parse('2024-11-03T06:45:00Z') / 1_000)! * 1_000),
    ).toEqual(new Date('2024-11-03T05:30:00Z'));
  });

  it('rejects invalid expressions and IANA zones through the maintained parser', () => {
    expect(() =>
      buildWorkSchedule(principal, {
        ...base,
        cadence: { type: 'cron', expression: 'not cron', timezone: 'UTC' },
      }),
    ).toThrow('invalid work schedule');
    expect(() =>
      buildWorkSchedule(principal, {
        ...base,
        cadence: { type: 'daily', localTime: '09:00', timezone: 'Mars/Olympus' },
      }),
    ).toThrow('invalid work schedule');
  });

  it('enforces 15-minute model and 1-minute default-script cadence floors', () => {
    const script = 'printf \'{"version":1,"status":"complete"}\\n\'';
    const mission = {
      missionId: 'mission-one',
      grantEventId: 'a'.repeat(64),
      controllerAgentPubkey: agent.publicKey,
      repository: { key: 'github:123', targetBranch: 'refs/heads/main' },
    };
    const common = {
      ...base,
      targetAgentPubkey: agent.publicKey,
      mission,
    };
    expect(() =>
      buildWorkSchedule(principal, {
        ...common,
        execution: { mode: 'model' },
        cadence: { type: 'interval', everySeconds: 899, anchorAt: 100 },
      }),
    ).toThrow('invalid work schedule');
    expect(() =>
      buildWorkSchedule(principal, {
        ...common,
        execution: {
          script,
          scriptSha256: createHash('sha256').update(script).digest('hex'),
          timeoutSeconds: 30,
        },
        cadence: { type: 'interval', everySeconds: 59, anchorAt: 100 },
      }),
    ).toThrow('invalid work schedule');
    const event = buildWorkSchedule(principal, {
      ...common,
      execution: {
        script,
        scriptSha256: createHash('sha256').update(script).digest('hex'),
        timeoutSeconds: 30,
      },
      cadence: { type: 'interval', everySeconds: 60, anchorAt: 100 },
    });
    expect(JSON.parse(event.content).execution.mode).toBe('script');
  });

  it('keeps runtime projection replacement separate from desired configuration', () => {
    const schedule = scheduleFixture(agent, principal);
    const desired = buildWorkSchedule(principal, schedule, { createdAt: schedule.startsAt - 1 });
    const runtime = buildWorkScheduleProjection(agent, {
      version: 1,
      type: 'runtime',
      workspaceId: schedule.workspaceId,
      roomId: schedule.roomId,
      agentPubkey: schedule.agentPubkey,
      principalPubkey: schedule.principalPubkey,
      scheduleId: schedule.scheduleId,
      revision: 1,
      status: 'active',
      nextAt: schedule.startsAt,
      runCount: 0,
      dailyReservedTokens: 0,
      consecutiveFailures: 0,
      updatedAt: schedule.startsAt - 1,
    });
    expect(runtime.tags.find((tag) => tag[0] === 'd')?.[1]).not.toBe(
      desired.tags.find((tag) => tag[0] === 'd')?.[1],
    );
    expect(runtime.tags).toContainEqual(['t', WORK_SCHEDULE_RUNTIME_TAG]);
  });
});

describe('WorkCalendar best-effort durable execution', () => {
  it('run_now re-authorizes the underlying operation immediately before activation', async () => {
    vi.useFakeTimers();
    const authorize = vi.fn(async () => ({ authorized: true as const }));
    const fixture = await calendarFixture({ authority: authorize });
    await fixture.calendar.start();
    const result = await fixture.calendar.runNow(fixture.schedule.scheduleId);
    // Refresh, pre-dispatch, and the activation callback each verify current
    // authority; the last check is immediately adjacent to model activation.
    expect(authorize).toHaveBeenCalledTimes(4);
    expect(fixture.dispatch).toHaveBeenCalledOnce();
    expect(result).toEqual({
      runId: deterministicScheduleRunId(
        fixture.schedule.scheduleId,
        fixture.schedule.revision,
        1_900_000_000,
      ),
      eventId: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    await fixture.calendar.dispose();
  });

  it('dispatches a mission occurrence to the exact named target agent', async () => {
    vi.useFakeTimers();
    const controller = createIdentity();
    const target = createIdentity();
    const captain = createIdentity();
    const script = 'printf \'{"version":1,"status":"complete"}\\n\'';
    const schedule = scheduleFixture(controller, captain, {
      targetAgentPubkey: target.publicKey,
      execution: {
        script,
        scriptSha256: createHash('sha256').update(script).digest('hex'),
        timeoutSeconds: 30,
      },
      mission: {
        missionId: 'mission-one',
        grantEventId: 'a'.repeat(64),
        controllerAgentPubkey: controller.publicKey,
        repository: { key: 'github:123', targetBranch: 'refs/heads/main' },
      },
    });
    const dispatch = vi.fn(async (_request, beforeModelActivation) => {
      await beforeModelActivation();
    });
    const fixture = await calendarFixture({
      agent: controller,
      principal: captain,
      schedule,
      scheduleEvents: [
        buildWorkSchedule(controller, schedule, { createdAt: schedule.startsAt - 1 }),
      ],
      missionAction: async () => ({ permissionId: 'mission-action' }) as never,
      dispatch,
    });
    await fixture.calendar.start();
    await fixture.calendar.wakeNow();
    expect(dispatch).toHaveBeenCalledOnce();
    expect(dispatch.mock.calls[0]?.[0]).toMatchObject({
      agentPubkey: controller.publicKey,
      targetAgentPubkey: target.publicKey,
      execution: { mode: 'script' },
    });
    await fixture.calendar.dispose();
  });

  it('recovers its serialized durable save queue after a write failure', async () => {
    const durable = await durableState();
    await durable.store.load();
    await mkdir(durable.path);
    const principal = createIdentity();
    const first: WorkScheduleRuntimeState = {
      scheduleId: 'recover-save-queue',
      principalPubkey: principal.publicKey,
      revision: 1,
      runCount: 0,
      dailyReservedTokens: 0,
      consecutiveFailures: 0,
      status: 'active',
    };
    await expect(durable.store.put(first)).rejects.toThrow();
    await rm(durable.path, { recursive: true });
    await durable.store.put({ ...first, runCount: 1, lastExecutionAt: 1_900_000_000 });
    expect(JSON.parse(await readFile(durable.path, 'utf8'))).toMatchObject({
      schedules: {
        'recover-save-queue': { runCount: 1, lastExecutionAt: 1_900_000_000 },
      },
    });
  });

  it('commits terminal occurrence state and its receipt in one durable snapshot', async () => {
    const durable = await durableState();
    const agent = createIdentity();
    const principal = createIdentity();
    const schedule = scheduleFixture(agent, principal, { scheduleId: 'atomic-terminal' });
    const state: WorkScheduleRuntimeState = {
      scheduleId: schedule.scheduleId,
      principalPubkey: principal.publicKey,
      revision: 1,
      lastExecutionAt: schedule.startsAt,
      runCount: 1,
      dailyReservedTokens: schedule.perRunReservedTokens,
      consecutiveFailures: 1,
      status: 'paused',
      pauseReason: 'max-consecutive-failures',
    };
    const runId = deterministicScheduleRunId(schedule.scheduleId, 1, schedule.startsAt);
    const receipt = buildScheduledTurnReceipt(agent, {
      version: 1,
      workspaceId: schedule.workspaceId,
      roomId: schedule.roomId,
      agentPubkey: schedule.agentPubkey,
      principalPubkey: schedule.principalPubkey,
      scheduleId: schedule.scheduleId,
      revision: 1,
      runId,
      nominalAt: schedule.startsAt,
      status: 'failed',
      at: schedule.startsAt,
      reservedTokens: schedule.perRunReservedTokens,
      reason: 'provider-down',
    });

    await durable.store.putWithReceipt(state, receipt);

    expect(JSON.parse(await readFile(durable.path, 'utf8'))).toMatchObject({
      schedules: { 'atomic-terminal': state },
      pendingReceipts: { [receipt.id]: { id: receipt.id } },
    });
  });

  it('uses one heap timer and submits independently due schedules without serializing them', async () => {
    vi.useFakeTimers();
    const agent = createIdentity();
    const principal = createIdentity();
    const first = scheduleFixture(agent, principal, { scheduleId: 'first' });
    const second = scheduleFixture(agent, principal, { scheduleId: 'second' });
    const starts: string[] = [];
    const releases = new Map<string, () => void>();
    const calendar = new WorkCalendar({
      identity: agent,
      workspaceId: first.workspaceId,
      store: new MemoryStore(),
      readSchedules: async () => [
        buildWorkSchedule(principal, first, { createdAt: first.startsAt - 1 }),
        buildWorkSchedule(principal, second, { createdAt: second.startsAt - 1 }),
      ],
      authorize: async () => ({ authorized: true }),
      publish: async () => undefined,
      dispatch: async (request, beforeModelActivation) => {
        await beforeModelActivation();
        starts.push(request.scheduleId);
        await new Promise<void>((resolveRelease) =>
          releases.set(request.scheduleId, resolveRelease),
        );
      },
      now: () => first.startsAt,
      resyncSeconds: 3_600,
    });
    await calendar.start();
    expect(calendar.snapshot()).toMatchObject({ schedules: 2, queued: 2, timerArmed: true });
    expect(vi.getTimerCount()).toBe(1);
    const wake = calendar.wakeNow();
    await vi.waitFor(() => expect(starts.sort()).toEqual(['first', 'second']));
    releases.get('first')!();
    releases.get('second')!();
    await wake;
    await calendar.dispose();
  });

  it('persists only bounded schedule progress and does not repeat an updated occurrence', async () => {
    vi.useFakeTimers();
    const durable = await durableState();
    const first = await calendarFixture({ store: durable.store });
    await first.calendar.start();
    await first.calendar.wakeNow();
    expect(first.dispatch).toHaveBeenCalledOnce();
    await first.calendar.dispose();

    const persisted = JSON.parse(await readFile(durable.path, 'utf8')) as Record<string, unknown>;
    expect(persisted).toMatchObject({ version: 3 });
    expect(persisted).toHaveProperty(
      `schedules.${first.schedule.scheduleId}.lastExecutionAt`,
      first.schedule.startsAt,
    );
    expect(persisted).not.toHaveProperty('runs');
    expect(persisted).not.toHaveProperty('outputs');

    const secondDispatch = vi.fn(async (_request, beforeModelActivation) => {
      await beforeModelActivation();
    });
    const restarted = new WorkCalendar({
      identity: first.agent,
      workspaceId: first.schedule.workspaceId,
      store: new DurableWorkCalendarState(durable.path),
      readSchedules: async () => first.scheduleEvents,
      authorize: async () => ({ authorized: true }),
      publish: async () => undefined,
      dispatch: secondDispatch,
      now: () => first.schedule.startsAt,
      resyncSeconds: 3_600,
    });
    await restarted.start();
    await restarted.wakeNow();
    expect(secondDispatch).not.toHaveBeenCalled();
    await restarted.dispose();
  });

  it('retries a persisted terminal receipt after restart', async () => {
    const durable = await durableState();
    const agent = createIdentity();
    const principal = createIdentity();
    const schedule = scheduleFixture(agent, principal);
    const receipt = buildScheduledTurnReceipt(agent, {
      version: 1,
      workspaceId: schedule.workspaceId,
      roomId: schedule.roomId,
      agentPubkey: agent.publicKey,
      principalPubkey: principal.publicKey,
      scheduleId: schedule.scheduleId,
      revision: 1,
      runId: deterministicScheduleRunId(schedule.scheduleId, 1, schedule.startsAt),
      nominalAt: schedule.startsAt,
      status: 'failed',
      at: schedule.startsAt,
      reservedTokens: schedule.perRunReservedTokens,
      reason: 'mission-script-fired:exit-1',
    });
    await durable.store.reserveReceipt(receipt);

    const delivered: NostrEvent[] = [];
    const restarted = new WorkCalendar({
      identity: agent,
      workspaceId: schedule.workspaceId,
      store: new DurableWorkCalendarState(durable.path),
      readSchedules: async () => [],
      authorize: async () => ({ authorized: true }),
      publish: async (event) => delivered.push(event),
      dispatch: async () => undefined,
      now: () => schedule.startsAt,
    });
    await restarted.start();
    expect(delivered.map((event) => event.id)).toEqual([receipt.id]);
    expect(await new DurableWorkCalendarState(durable.path).pendingReceipts()).toEqual([]);
    await restarted.dispose();
  });

  it('retries a failed terminal receipt on the next calendar wake', async () => {
    const store = new MemoryStore();
    let rejectTerminal = true;
    const delivered: NostrEvent[] = [];
    const fixture = await calendarFixture({
      store,
      publish: async (event) => {
        const receipt = parseScheduledTurnReceipt(event);
        if (receipt?.value.status === 'complete' && rejectTerminal) {
          rejectTerminal = false;
          throw new Error('relay unavailable');
        }
        delivered.push(event);
      },
    });
    await fixture.calendar.start();
    await fixture.calendar.wakeNow();
    expect(store.receipts.size).toBe(1);
    await fixture.calendar.wakeNow();
    expect(store.receipts.size).toBe(0);
    expect(
      delivered.filter((event) => parseScheduledTurnReceipt(event)?.value.status === 'complete'),
    ).toHaveLength(1);
    await fixture.calendar.dispose();
  });

  it('retries after timestamp persistence fails without stalling its sole timer', async () => {
    vi.useFakeTimers();
    const store = new MemoryStore();
    const first = await calendarFixture({ store });
    await first.calendar.start();
    store.failNextPut = true;
    await expect(first.calendar.wakeNow()).resolves.toBeUndefined();
    expect(first.dispatch).toHaveBeenCalledOnce();
    expect(store.values.get(first.schedule.scheduleId)?.lastExecutionAt).toBeUndefined();
    expect(first.calendar.snapshot()).toMatchObject({ queued: 1, timerArmed: true });
    expect(vi.getTimerCount()).toBe(1);

    first.setNow(first.schedule.startsAt + 5);
    await first.calendar.wakeNow();
    expect(first.dispatch).toHaveBeenCalledTimes(2);
    expect(store.values.get(first.schedule.scheduleId)?.lastExecutionAt).toBe(
      first.schedule.startsAt,
    );
    await first.calendar.dispose();
  });

  it('does not gate or replay execution when relay receipt publication fails', async () => {
    vi.useFakeTimers();
    const publish = vi.fn(async (event: NostrEvent) => {
      if (event.tags.some((tag) => tag[0] === 't' && tag[1] === SCHEDULED_TURN_TAG)) {
        throw new Error('relay unavailable');
      }
    });
    const fixture = await calendarFixture({ publish });
    await fixture.calendar.start();
    await fixture.calendar.wakeNow();
    expect(fixture.dispatch).toHaveBeenCalledOnce();
    expect((await fixture.store.states())[0]?.lastExecutionAt).toBe(fixture.schedule.startsAt);
    await fixture.calendar.dispose();

    const restarted = await calendarFixture({
      agent: fixture.agent,
      principal: fixture.principal,
      schedule: fixture.schedule,
      scheduleEvents: fixture.scheduleEvents,
      store: fixture.store,
      publish,
    });
    await restarted.calendar.start();
    await restarted.calendar.wakeNow();
    expect(restarted.dispatch).not.toHaveBeenCalled();
    await restarted.calendar.dispose();
  });

  it.each([
    'principal-removed',
    'agent-removed',
    'room-archived',
    'schedule-principal-role-lost',
    'schedule-change-grant-invalid',
  ])('durably pauses without a model call when fresh authority says %s', async (reason) => {
    vi.useFakeTimers();
    let checks = 0;
    const fixture = await calendarFixture({
      authority: async () =>
        ++checks === 1 ? { authorized: true } : { authorized: false, terminal: true, reason },
    });
    await fixture.calendar.start();
    await fixture.calendar.wakeNow();
    expect(fixture.dispatch).not.toHaveBeenCalled();
    expect((await fixture.store.states())[0]).toMatchObject({
      status: 'paused',
      pauseReason: reason,
    });
    const pause = fixture.published.find((event) =>
      event.tags.some((tag) => tag[0] === 't' && tag[1] === WORK_SCHEDULE_PAUSED_TAG),
    );
    expect(pause?.tags).toContainEqual(['reason', reason]);
    await fixture.calendar.dispose();
  });

  it('rechecks authority and pinned artifacts after scheduler admission', async () => {
    vi.useFakeTimers();
    let authorityChecks = 0;
    let artifactChecks = 0;
    const modelCall = vi.fn();
    const fixture = await calendarFixture({
      authority: async () =>
        ++authorityChecks < 3
          ? { authorized: true }
          : { authorized: false, terminal: true, reason: 'principal-removed' },
      validateArtifacts: async () => {
        artifactChecks += 1;
        return { authorized: true };
      },
      dispatch: vi.fn(async (_request, beforeModelActivation) => {
        await beforeModelActivation();
        modelCall();
      }),
    });
    await fixture.calendar.start();
    await fixture.calendar.wakeNow();
    expect(fixture.dispatch).toHaveBeenCalledOnce();
    expect(modelCall).not.toHaveBeenCalled();
    expect(artifactChecks).toBeGreaterThanOrEqual(2);
    expect((await fixture.store.states())[0]).toMatchObject({
      status: 'paused',
      pauseReason: 'principal-removed',
    });
    await fixture.calendar.dispose();
  });

  it('pauses when an artifact revision changes while queued', async () => {
    vi.useFakeTimers();
    let artifactChecks = 0;
    const modelCall = vi.fn();
    const fixture = await calendarFixture({
      validateArtifacts: async () =>
        ++artifactChecks < 3
          ? { authorized: true }
          : { authorized: false, terminal: true, reason: 'artifact-digest-mismatch' },
      dispatch: vi.fn(async (_request, beforeModelActivation) => {
        await beforeModelActivation();
        modelCall();
      }),
    });
    await fixture.calendar.start();
    await fixture.calendar.wakeNow();
    expect(fixture.dispatch).toHaveBeenCalledOnce();
    expect(modelCall).not.toHaveBeenCalled();
    expect((await fixture.store.states())[0]).toMatchObject({
      status: 'paused',
      pauseReason: 'artifact-digest-mismatch',
    });
    await fixture.calendar.dispose();
  });

  it('refuses an occurrence that expires while waiting in SessionScheduler', async () => {
    vi.useFakeTimers();
    const agent = createIdentity();
    const principal = createIdentity();
    const schedule = scheduleFixture(agent, principal, { expiresAt: 1_900_000_001 });
    const modelCall = vi.fn();
    const fixture = await calendarFixture({
      agent,
      principal,
      schedule,
      dispatch: vi.fn(async (_request, beforeModelActivation) => {
        fixture.setNow(schedule.expiresAt + 1);
        await beforeModelActivation();
        modelCall();
      }),
    });
    await fixture.calendar.start();
    await fixture.calendar.wakeNow();
    expect(modelCall).not.toHaveBeenCalled();
    expect((await fixture.store.states())[0]).toMatchObject({
      status: 'active',
      lastExecutionAt: schedule.startsAt,
    });
    expect(
      fixture.published.some(
        (event) => parseScheduledTurnReceipt(event)?.value.reason === 'schedule-expired',
      ),
    ).toBe(true);
    await fixture.calendar.dispose();
  });

  it('enforces durable max-run and daily reserved-token counters', async () => {
    vi.useFakeTimers();
    const agent = createIdentity();
    const principal = createIdentity();
    const schedule = scheduleFixture(agent, principal, { dailyReservedTokens: 100 });
    const store = new MemoryStore();
    store.values.set(schedule.scheduleId, {
      scheduleId: schedule.scheduleId,
      principalPubkey: principal.publicKey,
      revision: 1,
      lastExecutionAt: schedule.startsAt - 60,
      runCount: 1,
      budgetDay: new Date(schedule.startsAt * 1_000).toISOString().slice(0, 10),
      dailyReservedTokens: 100,
      consecutiveFailures: 0,
      status: 'active',
    });
    const fixture = await calendarFixture({ agent, principal, schedule, store });
    await fixture.calendar.start();
    await fixture.calendar.wakeNow();
    expect(fixture.dispatch).not.toHaveBeenCalled();
    expect((await store.states())[0]?.lastExecutionAt).toBe(schedule.startsAt);
    await fixture.calendar.dispose();

    const exhausted = { ...schedule, scheduleId: 'maxed', maxRuns: 1 };
    store.values.set(exhausted.scheduleId, {
      scheduleId: exhausted.scheduleId,
      principalPubkey: principal.publicKey,
      revision: 1,
      runCount: 1,
      dailyReservedTokens: 0,
      consecutiveFailures: 0,
      status: 'active',
    });
    const maxed = await calendarFixture({ agent, principal, schedule: exhausted, store });
    await maxed.calendar.start();
    await maxed.calendar.wakeNow();
    expect(maxed.dispatch).not.toHaveBeenCalled();
    await maxed.calendar.dispose();
  });

  it('bounds long-outage catch-up to zero or one model calls', async () => {
    vi.useFakeTimers();
    const latest = await calendarFixture({ now: 1_900_086_400 });
    await latest.calendar.start();
    await latest.calendar.wakeNow();
    expect(latest.dispatch).toHaveBeenCalledOnce();
    expect((await latest.store.states())[0]?.lastExecutionAt).toBe(1_900_086_400);
    await latest.calendar.dispose();

    const agent = createIdentity();
    const principal = createIdentity();
    const schedule = scheduleFixture(agent, principal, { catchUp: 'skip' });
    const skipped = await calendarFixture({ agent, principal, schedule, now: 1_900_086_400 });
    await skipped.calendar.start();
    await skipped.calendar.wakeNow();
    expect(skipped.dispatch).not.toHaveBeenCalled();
    expect((await skipped.store.states())[0]?.lastExecutionAt).toBe(1_900_086_400);
    await skipped.calendar.dispose();
  });

  it('persists failure pause before its card and requires a newer human active revision', async () => {
    vi.useFakeTimers();
    const agent = createIdentity();
    const principal = createIdentity();
    const first = scheduleFixture(agent, principal, { maxConsecutiveFailures: 1 });
    const schedules = [buildWorkSchedule(principal, first, { createdAt: first.startsAt - 10 })];
    const store = new MemoryStore();
    let pauseStateAtPublish: WorkScheduleRuntimeState | undefined;
    let calls = 0;
    const dispatch = vi.fn(async (_request, beforeModelActivation) => {
      await beforeModelActivation();
      calls += 1;
      if (calls === 1) throw new Error('provider down');
    });
    const fixture = await calendarFixture({
      agent,
      principal,
      schedule: first,
      scheduleEvents: schedules,
      store,
      dispatch,
      publish: async (event) => {
        if (event.tags.some((tag) => tag[0] === 't' && tag[1] === WORK_SCHEDULE_PAUSED_TAG)) {
          pauseStateAtPublish = (await store.states())[0];
        }
        fixture.published.push(event);
      },
    });
    await fixture.calendar.start();
    await fixture.calendar.wakeNow();
    expect(pauseStateAtPublish).toMatchObject({ status: 'paused', consecutiveFailures: 1 });

    const agentRevision = { ...first, revision: 2, status: 'active' as const };
    schedules.push(buildWorkSchedule(agent, agentRevision, { createdAt: first.startsAt + 1 }));
    fixture.setNow(first.startsAt + 60);
    await fixture.calendar.refreshNow();
    await fixture.calendar.wakeNow();
    expect(dispatch).toHaveBeenCalledOnce();

    const humanRevision = { ...first, revision: 3, status: 'active' as const };
    schedules.push(buildWorkSchedule(principal, humanRevision, { createdAt: first.startsAt + 2 }));
    await fixture.calendar.refreshNow();
    await fixture.calendar.wakeNow();
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(dispatch.mock.calls[1]![0].scheduleRunId).toBe(
      deterministicScheduleRunId(first.scheduleId, 3, first.startsAt + 60),
    );
    await fixture.calendar.dispose();
  });

  it('resumes a failure-paused mission from a freshly authorized controller revision', async () => {
    vi.useFakeTimers();
    const controller = createIdentity();
    const captain = createIdentity();
    const script = 'printf \'{"version":1,"status":"complete"}\\n\'';
    const first = scheduleFixture(controller, captain, {
      maxConsecutiveFailures: 1,
      targetAgentPubkey: controller.publicKey,
      execution: {
        mode: 'script',
        script,
        scriptSha256: createHash('sha256').update(script).digest('hex'),
        timeoutSeconds: 30,
      },
      mission: {
        missionId: 'mission-resume',
        grantEventId: 'b'.repeat(64),
        controllerAgentPubkey: controller.publicKey,
        repository: { key: 'github:resume', targetBranch: 'refs/heads/main' },
      },
    });
    const schedules = [buildWorkSchedule(controller, first, { createdAt: first.startsAt - 10 })];
    let calls = 0;
    const dispatch = vi.fn(async (_request, beforeModelActivation) => {
      await beforeModelActivation();
      calls += 1;
      if (calls === 1) throw new Error('provider down');
    });
    const fixture = await calendarFixture({
      agent: controller,
      principal: captain,
      schedule: first,
      scheduleEvents: schedules,
      dispatch,
      missionAction: async () => ({ permissionId: 'mission-action' }) as never,
    });
    await fixture.calendar.start();
    await fixture.calendar.wakeNow();
    expect((await fixture.store.states())[0]).toMatchObject({ status: 'paused' });

    const resumed = { ...first, revision: 2, status: 'active' as const };
    schedules.push(buildWorkSchedule(controller, resumed, { createdAt: first.startsAt + 1 }));
    fixture.setNow(first.startsAt + 60);
    await fixture.calendar.refreshNow();
    await fixture.calendar.wakeNow();

    expect(dispatch).toHaveBeenCalledTimes(2);
    expect((await fixture.store.states())[0]).toMatchObject({
      revision: 2,
      status: 'active',
      consecutiveFailures: 0,
    });
    await fixture.calendar.dispose();
  });

  it('never rolls durable state backward when a relay read omits the current revision', async () => {
    vi.useFakeTimers();
    const agent = createIdentity();
    const principal = createIdentity();
    const schedule = scheduleFixture(agent, principal);
    const store = new MemoryStore();
    store.values.set(schedule.scheduleId, {
      scheduleId: schedule.scheduleId,
      principalPubkey: principal.publicKey,
      revision: 2,
      lastExecutionAt: schedule.startsAt - 60,
      runCount: 1,
      dailyReservedTokens: schedule.perRunReservedTokens,
      consecutiveFailures: 0,
      status: 'active',
    });
    const dispatch = vi.fn(async (_request, beforeModelActivation) => beforeModelActivation());
    const calendar = new WorkCalendar({
      identity: agent,
      workspaceId: schedule.workspaceId,
      store,
      readSchedules: async () => [
        buildWorkSchedule(principal, schedule, { createdAt: schedule.startsAt - 10 }),
      ],
      authorize: async () => ({ authorized: true }),
      publish: async () => undefined,
      dispatch,
      now: () => schedule.startsAt,
      resyncSeconds: 3_600,
    });

    await calendar.start();
    await calendar.wakeNow();

    expect(dispatch).not.toHaveBeenCalled();
    expect((await store.states())[0]).toMatchObject({ revision: 2, runCount: 1 });
    await calendar.dispose();
  });

  it('pins authority to the creation principal and never falls back cross-author', async () => {
    vi.useFakeTimers();
    const agent = createIdentity();
    const principal = createIdentity();
    const other = createIdentity();
    const schedule = scheduleFixture(agent, principal);
    const store = new MemoryStore();
    store.values.set(schedule.scheduleId, {
      scheduleId: schedule.scheduleId,
      principalPubkey: principal.publicKey,
      revision: 1,
      runCount: 0,
      dailyReservedTokens: 0,
      consecutiveFailures: 0,
      status: 'active',
    });
    const otherSchedule = { ...schedule, principalPubkey: other.publicKey, revision: 999 };
    const dispatch = vi.fn(async (_request, beforeModelActivation) => beforeModelActivation());
    const calendar = new WorkCalendar({
      identity: agent,
      workspaceId: schedule.workspaceId,
      store,
      readSchedules: async () => [
        buildWorkSchedule(principal, schedule, { createdAt: schedule.startsAt - 10 }),
        buildWorkSchedule(other, otherSchedule, { createdAt: schedule.startsAt - 1 }),
      ],
      authorize: async (candidate) =>
        candidate.value.principalPubkey === principal.publicKey
          ? { authorized: false, terminal: true, reason: 'principal-removed' }
          : { authorized: true },
      publish: async () => undefined,
      dispatch,
      now: () => schedule.startsAt,
      resyncSeconds: 3_600,
    });
    await calendar.start();
    await calendar.wakeNow();
    expect(dispatch).not.toHaveBeenCalled();
    expect((await store.states())[0]).toMatchObject({
      principalPubkey: principal.publicKey,
      status: 'paused',
      pauseReason: 'principal-removed',
    });
    await calendar.dispose();
  });

  it('publishes best-effort queued, working, and complete lifecycle receipts', async () => {
    vi.useFakeTimers();
    const fixture = await calendarFixture();
    await fixture.calendar.start();
    await fixture.calendar.wakeNow();
    expect(
      fixture.published.flatMap((event) => {
        const receipt = parseScheduledTurnReceipt(event);
        return receipt ? [receipt.value.status] : [];
      }),
    ).toEqual(['queued', 'working', 'complete']);
    await fixture.calendar.dispose();
  });
});
