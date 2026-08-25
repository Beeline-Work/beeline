import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createIdentity, type Identity } from '@beeline/buzz-client';
import { signEvent, type NostrEvent } from '@beeline/nostr';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DurableWorkCalendarState,
  MAX_CALENDAR_IN_FLIGHT_RUNS,
  SCHEDULED_TURN_TAG,
  WORK_SCHEDULE_PAUSED_TAG,
  WORK_SCHEDULE_RUNTIME_TAG,
  WorkCalendar,
  buildScheduledTurnReceipt,
  buildWorkSchedule,
  buildWorkScheduleProjection,
  deterministicScheduleRunId,
  nextWorkOccurrence,
  parseScheduledTurnReceipt,
  parseWorkSchedule,
  parseWorkScheduleCheckpoint,
  previousWorkOccurrence,
  type CalendarRunReservation,
  type ParsedWorkSchedule,
  type ScheduleAuthorityResult,
  type ScheduledTurnReceiptV1,
  type WorkCalendarDependencies,
  type WorkScheduleV1,
} from './work-calendar.js';

const roots: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function state(): Promise<DurableWorkCalendarState> {
  const root = await mkdtemp(resolve(tmpdir(), 'beeline-work-calendar-'));
  roots.push(root);
  return new DurableWorkCalendarState(resolve(root, 'calendar.json'));
}

function dayUtcForTest(at: number): string {
  return new Date(at * 1_000).toISOString().slice(0, 10);
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
    receiptEvents?: NostrEvent[];
    now?: number;
    store?: DurableWorkCalendarState;
    authority?:
      | ScheduleAuthorityResult
      | ((schedule: ParsedWorkSchedule) => Promise<ScheduleAuthorityResult>);
    validateScheduleCreation?: WorkCalendarDependencies['validateScheduleCreation'];
    validateArtifacts?: WorkCalendarDependencies['validateArtifacts'];
    publish?: (event: NostrEvent) => Promise<void>;
    dispatch?: WorkCalendarDependencies['dispatch'];
  } = {},
) {
  const agent = options.agent ?? createIdentity();
  const principal = options.principal ?? createIdentity();
  let now = options.now ?? 1_900_000_000;
  const schedule = options.schedule ?? scheduleFixture(agent, principal);
  const scheduleEvents = options.scheduleEvents ?? [
    buildWorkSchedule(principal, schedule, { createdAt: now - 10 }),
  ];
  const receiptEvents = options.receiptEvents ?? [];
  const published: NostrEvent[] = [];
  const dispatch =
    options.dispatch ??
    vi.fn(async (_request, beforeModelActivation) => {
      await beforeModelActivation();
    });
  const durable = options.store ?? (await state());
  const calendar = new WorkCalendar({
    identity: agent,
    workspaceId: schedule.workspaceId,
    store: durable,
    readSchedules: async () => scheduleEvents,
    readReceipts: async () => receiptEvents,
    authorize: async (candidate) =>
      typeof options.authority === 'function'
        ? options.authority(candidate)
        : (options.authority ?? { authorized: true }),
    ...(options.validateScheduleCreation
      ? { validateScheduleCreation: options.validateScheduleCreation }
      : {}),
    ...(options.validateArtifacts ? { validateArtifacts: options.validateArtifacts } : {}),
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
    receiptEvents,
    published,
    dispatch,
    durable,
    calendar,
    setNow(value: number) {
      now = value;
    },
  };
}

function checkpointFixture(
  schedule: WorkScheduleV1,
  updatedAt = schedule.startsAt - 1,
) {
  return {
    version: 1 as const,
    type: 'runtime' as const,
    checkpointVersion: 1 as const,
    workspaceId: schedule.workspaceId,
    roomId: schedule.roomId,
    agentPubkey: schedule.agentPubkey,
    principalPubkey: schedule.principalPubkey,
    scheduleId: schedule.scheduleId,
    revision: schedule.revision,
    status: 'active' as const,
    consecutiveFailures: 0,
    updatedAt,
    runCount: 0,
    budgetDay: dayUtcForTest(schedule.startsAt),
    dailyReservedTokens: 0,
    receiptCursorAt: schedule.startsAt - 1,
  };
}

describe('durable terminal watermark', () => {
  it('retains more than the old compaction threshold and backpressures at the bound', async () => {
    const agent = createIdentity();
    const principal = createIdentity();
    const schedule = scheduleFixture(agent, principal, { maxRuns: 1_000_000 });
    const durable = await state();
    const checkpoint = checkpointFixture(schedule);
    for (let index = 0; index < MAX_CALENDAR_IN_FLIGHT_RUNS; index += 1) {
      const nominalAt = schedule.startsAt + index * 60;
      const runId = deterministicScheduleRunId(schedule.scheduleId, schedule.revision, nominalAt);
      const reserved = await durable.reserveRun({
        runId,
        scheduleId: schedule.scheduleId,
        revision: schedule.revision,
        workspaceId: schedule.workspaceId,
        roomId: schedule.roomId,
        agentPubkey: schedule.agentPubkey,
        principalPubkey: schedule.principalPubkey,
        nominalAt,
        reservedTokens: schedule.perRunReservedTokens,
        reservedAt: nominalAt,
      });
      expect(reserved.state).toBe('reserved');
      const terminal = buildScheduledTurnReceipt(agent, {
        version: 1,
        workspaceId: schedule.workspaceId,
        roomId: schedule.roomId,
        agentPubkey: schedule.agentPubkey,
        principalPubkey: schedule.principalPubkey,
        scheduleId: schedule.scheduleId,
        revision: schedule.revision,
        runId,
        nominalAt,
        status: 'failed',
        at: nominalAt,
        reservedTokens: schedule.perRunReservedTokens,
        reason: 'relay unavailable',
      });
      await durable.stageCompletion(runId, 'failed', terminal, [], {
        ...checkpoint,
        updatedAt: nominalAt,
        latestNominalAt: nominalAt,
        latestRunId: runId,
        latestRunStatus: 'failed',
      });
    }
    expect(await durable.runs()).toHaveLength(MAX_CALENDAR_IN_FLIGHT_RUNS);
    expect((await durable.pendingReceipts()).filter(({ status }) => status === 'failed')).toHaveLength(
      MAX_CALENDAR_IN_FLIGHT_RUNS,
    );
    const nominalAt = schedule.startsAt + MAX_CALENDAR_IN_FLIGHT_RUNS * 60;
    await expect(
      durable.reserveRun({
        runId: deterministicScheduleRunId(schedule.scheduleId, schedule.revision, nominalAt),
        scheduleId: schedule.scheduleId,
        revision: schedule.revision,
        workspaceId: schedule.workspaceId,
        roomId: schedule.roomId,
        agentPubkey: schedule.agentPubkey,
        principalPubkey: schedule.principalPubkey,
        nominalAt,
        reservedTokens: schedule.perRunReservedTokens,
        reservedAt: nominalAt,
      }),
    ).resolves.toEqual({ state: 'backpressure' });
  });

  it('advances only across a contiguous terminal-published prefix', async () => {
    const agent = createIdentity();
    const principal = createIdentity();
    const schedule = scheduleFixture(agent, principal);
    const durable = await state();
    const checkpoint = checkpointFixture(schedule);
    const receipts: Array<{ runId: string; nominalAt: number; event: NostrEvent }> = [];
    for (let index = 0; index < 3; index += 1) {
      const nominalAt = schedule.startsAt + index * 60;
      const runId = deterministicScheduleRunId(schedule.scheduleId, schedule.revision, nominalAt);
      await durable.reserveRun({
        runId,
        scheduleId: schedule.scheduleId,
        revision: schedule.revision,
        workspaceId: schedule.workspaceId,
        roomId: schedule.roomId,
        agentPubkey: schedule.agentPubkey,
        principalPubkey: schedule.principalPubkey,
        nominalAt,
        reservedTokens: schedule.perRunReservedTokens,
        reservedAt: nominalAt,
      });
      const event = buildScheduledTurnReceipt(agent, {
        version: 1,
        workspaceId: schedule.workspaceId,
        roomId: schedule.roomId,
        agentPubkey: schedule.agentPubkey,
        principalPubkey: schedule.principalPubkey,
        scheduleId: schedule.scheduleId,
        revision: schedule.revision,
        runId,
        nominalAt,
        status: 'complete',
        at: nominalAt,
        reservedTokens: schedule.perRunReservedTokens,
      });
      await durable.stageCompletion(runId, 'complete', event, [], {
        ...checkpoint,
        updatedAt: nominalAt,
        latestNominalAt: nominalAt,
        latestRunId: runId,
        latestRunStatus: 'complete',
      });
      receipts.push({ runId, nominalAt, event });
    }
    await durable.markReceiptPublished(receipts[1]!.runId, 'complete', receipts[1]!.event.id);
    expect((await durable.checkpoints())[0]?.watermarkNominalAt).toBeUndefined();
    await durable.markReceiptPublished(receipts[0]!.runId, 'complete', receipts[0]!.event.id);
    expect((await durable.checkpoints())[0]).toEqual(
      expect.objectContaining({
        watermarkNominalAt: receipts[1]!.nominalAt,
        watermarkRunId: receipts[1]!.runId,
      }),
    );
    expect((await durable.runs()).map((run) => run.runId)).toEqual([receipts[2]!.runId]);
  });
});

describe('scheduled artifact activation boundary', () => {
  it('pauses before model activation when a fresh artifact revision check fails', async () => {
    vi.useFakeTimers();
    const agent = createIdentity();
    const principal = createIdentity();
    const schedule = scheduleFixture(agent, principal, {
      artifactRefs: [
        {
          artifactId: 'artifact-one',
          revision: 1,
          eventId: 'a'.repeat(64),
          sha256: 'b'.repeat(64),
        },
      ],
    });
    let activated = false;
    const fixture = await calendarFixture({
      agent,
      principal,
      schedule,
      validateArtifacts: async () => ({
        authorized: false,
        terminal: true,
        reason: 'artifact-digest-mismatch',
      }),
      dispatch: vi.fn(async (_request, beforeModelActivation) => {
        await beforeModelActivation();
        activated = true;
      }),
    });
    await fixture.calendar.start();
    await fixture.calendar.wakeNow();
    expect(activated).toBe(false);
    expect(await fixture.durable.checkpoints()).toContainEqual(
      expect.objectContaining({
        status: 'paused',
        pauseReason: 'artifact-digest-mismatch',
      }),
    );
    expect(
      fixture.published.some((event) =>
        event.tags.some((tag) => tag[0] === 't' && tag[1] === WORK_SCHEDULE_PAUSED_TAG),
      ),
    ).toBe(true);
    await fixture.calendar.dispose();
  });
});

describe('work schedule occurrence math', () => {
  const agent = createIdentity();
  const principal = createIdentity();
  const base = scheduleFixture(agent, principal, {
    startsAt: 0,
    expiresAt: 2_000_000_000,
  });

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
      new Date(
        nextWorkOccurrence(daily, Date.parse('2026-01-01T09:15:00Z') / 1_000)! * 1_000,
      ).toISOString(),
    ).toBe('2026-01-02T09:15:00.000Z');

    const leap = {
      ...base,
      cadence: { type: 'cron' as const, expression: '0 0 29 2 *', timezone: 'UTC' },
    };
    expect(
      new Date(
        nextWorkOccurrence(leap, Date.parse('2023-03-01T00:00:00Z') / 1_000)! * 1_000,
      ).toISOString(),
    ).toBe('2024-02-29T00:00:00.000Z');
  });

  it('runs a missing spring-forward wall time at the next valid instant', () => {
    const daily = {
      ...base,
      cadence: { type: 'daily' as const, localTime: '02:30', timezone: 'America/New_York' },
    };
    expect(
      new Date(
        nextWorkOccurrence(daily, Date.parse('2024-03-09T08:00:00Z') / 1_000)! * 1_000,
      ).toISOString(),
    ).toBe('2024-03-10T07:00:00.000Z');

    const overlappingCron = {
      ...base,
      cadence: {
        type: 'cron' as const,
        expression: '30 2,3 * * *',
        timezone: 'America/New_York',
      },
    };
    const shifted = nextWorkOccurrence(
      overlappingCron,
      Date.parse('2024-03-10T05:00:00Z') / 1_000,
    )!;
    expect(new Date(shifted * 1_000).toISOString()).toBe('2024-03-10T07:00:00.000Z');
    expect(new Date(nextWorkOccurrence(overlappingCron, shifted)! * 1_000).toISOString()).toBe(
      '2024-03-10T07:30:00.000Z',
    );
    expect(
      new Date(
        previousWorkOccurrence(overlappingCron, Date.parse('2024-03-10T07:15:00Z') / 1_000)! *
          1_000,
      ).toISOString(),
    ).toBe('2024-03-10T07:00:00.000Z');
  });

  it('runs a repeated fall-back wall time once at its first occurrence', () => {
    const daily = {
      ...base,
      cadence: { type: 'daily' as const, localTime: '01:30', timezone: 'America/New_York' },
    };
    const first = nextWorkOccurrence(daily, Date.parse('2024-11-03T04:00:00Z') / 1_000)!;
    expect(new Date(first * 1_000).toISOString()).toBe('2024-11-03T05:30:00.000Z');
    expect(new Date(nextWorkOccurrence(daily, first)! * 1_000).toISOString()).toBe(
      '2024-11-04T06:30:00.000Z',
    );
    expect(
      new Date(
        previousWorkOccurrence(daily, Date.parse('2024-11-03T06:45:00Z') / 1_000)! * 1_000,
      ).toISOString(),
    ).toBe('2024-11-03T05:30:00.000Z');
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

  it('keeps daemon runtime projection replacement separate from desired configuration', () => {
    const schedule = scheduleFixture(agent, principal);
    const desired = buildWorkSchedule(agent, {
      ...schedule,
      permissionGrantEventId: 'a'.repeat(64),
    });
    const runtime = buildWorkScheduleProjection(agent, {
      version: 1,
      type: 'runtime',
      workspaceId: schedule.workspaceId,
      roomId: schedule.roomId,
      agentPubkey: schedule.agentPubkey,
      principalPubkey: schedule.principalPubkey,
      scheduleId: schedule.scheduleId,
      revision: schedule.revision,
      status: 'active',
      nextAt: schedule.startsAt,
      consecutiveFailures: 0,
      updatedAt: schedule.startsAt,
    });
    expect(desired.tags.find((tag) => tag[0] === 'd')?.[1]).not.toBe(
      runtime.tags.find((tag) => tag[0] === 'd')?.[1],
    );
    expect(runtime.tags).toContainEqual(['t', WORK_SCHEDULE_RUNTIME_TAG]);
    expect(parseWorkSchedule(runtime)).toBeUndefined();
  });
});

describe('WorkCalendar durable execution', () => {
  it('arms one next-due timer for many schedules rather than one interval per job', async () => {
    vi.useFakeTimers();
    const agent = createIdentity();
    const principal = createIdentity();
    const first = scheduleFixture(agent, principal, {
      scheduleId: 'first-job',
      startsAt: 1_900_000_060,
    });
    const second = scheduleFixture(agent, principal, {
      scheduleId: 'second-job',
      startsAt: 1_900_000_120,
    });
    const calendar = new WorkCalendar({
      identity: agent,
      workspaceId: first.workspaceId,
      store: await state(),
      readSchedules: async () => [
        buildWorkSchedule(principal, first, { createdAt: 1_900_000_000 }),
        buildWorkSchedule(principal, second, { createdAt: 1_900_000_000 }),
      ],
      readReceipts: async () => [],
      authorize: async () => ({ authorized: true }),
      publish: async () => undefined,
      dispatch: async () => undefined,
      now: () => 1_900_000_000,
      resyncSeconds: 3_600,
    });
    await calendar.start();
    expect(calendar.snapshot()).toMatchObject({ schedules: 2, queued: 2, timerArmed: true });
    expect(vi.getTimerCount()).toBe(1);
    await calendar.dispose();
  });

  it('uses the same run id after restart and never repeats a completed model call', async () => {
    vi.useFakeTimers();
    const first = await calendarFixture();
    await first.calendar.start();
    await first.calendar.wakeNow();
    expect(first.dispatch).toHaveBeenCalledOnce();
    const runId = (first.dispatch as ReturnType<typeof vi.fn>).mock.calls[0]![0].scheduleRunId;
    expect(runId).toBe(
      deterministicScheduleRunId(first.schedule.scheduleId, 1, first.schedule.startsAt),
    );
    await first.calendar.dispose();

    const secondDispatch = vi.fn(async (_request, beforeModelActivation) => {
      await beforeModelActivation();
    });
    const second = new WorkCalendar({
      identity: first.agent,
      workspaceId: first.schedule.workspaceId,
      store: first.durable,
      readSchedules: async () => first.scheduleEvents,
      readReceipts: async () => first.published,
      authorize: async () => ({ authorized: true }),
      publish: async (event) => first.published.push(event),
      dispatch: secondDispatch,
      now: () => first.schedule.startsAt,
      resyncSeconds: 3_600,
    });
    await second.start();
    await second.wakeNow();
    expect(secondDispatch).not.toHaveBeenCalled();
    await second.dispose();
  });

  it('resumes a crash-after-reservation but refuses an ambiguous crash-after-working', async () => {
    vi.useFakeTimers();
    const resumable = await calendarFixture();
    const runId = deterministicScheduleRunId(
      resumable.schedule.scheduleId,
      1,
      resumable.schedule.startsAt,
    );
    const reservation: CalendarRunReservation = {
      runId,
      scheduleId: resumable.schedule.scheduleId,
      revision: 1,
      workspaceId: resumable.schedule.workspaceId,
      roomId: resumable.schedule.roomId,
      agentPubkey: resumable.agent.publicKey,
      principalPubkey: resumable.principal.publicKey,
      nominalAt: resumable.schedule.startsAt,
      reservedTokens: 100,
      reservedAt: resumable.schedule.startsAt,
    };
    await resumable.durable.reserveRun(reservation);
    await resumable.calendar.start();
    await resumable.calendar.wakeNow();
    expect(resumable.dispatch).toHaveBeenCalledOnce();
    await resumable.calendar.dispose();

    const ambiguous = await calendarFixture();
    const ambiguousId = deterministicScheduleRunId(
      ambiguous.schedule.scheduleId,
      1,
      ambiguous.schedule.startsAt,
    );
    await ambiguous.durable.reserveRun({
      ...reservation,
      runId: ambiguousId,
      scheduleId: ambiguous.schedule.scheduleId,
      roomId: ambiguous.schedule.roomId,
      agentPubkey: ambiguous.agent.publicKey,
      principalPubkey: ambiguous.principal.publicKey,
    });
    const working = buildScheduledTurnReceipt(ambiguous.agent, {
      version: 1,
      workspaceId: ambiguous.schedule.workspaceId,
      roomId: ambiguous.schedule.roomId,
      agentPubkey: ambiguous.agent.publicKey,
      principalPubkey: ambiguous.principal.publicKey,
      scheduleId: ambiguous.schedule.scheduleId,
      revision: 1,
      runId: ambiguousId,
      nominalAt: ambiguous.schedule.startsAt,
      status: 'working',
      at: ambiguous.schedule.startsAt,
      reservedTokens: 100,
    });
    await ambiguous.durable.stageReceipt(ambiguousId, 'working', working);
    await ambiguous.durable.markReceiptPublished(ambiguousId, 'working', working.id);
    await ambiguous.calendar.start();
    await ambiguous.calendar.wakeNow();
    expect(ambiguous.dispatch).not.toHaveBeenCalled();
    expect(
      ambiguous.published.some(
        (event) =>
          parseScheduledTurnReceipt(event)?.value.reason === 'outcome-unknown-after-restart',
      ),
    ).toBe(true);
    await ambiguous.calendar.dispose();
  });

  it('folds relay-only terminal receipts over earlier working state', async () => {
    vi.useFakeTimers();
    const agent = createIdentity();
    const principal = createIdentity();
    const schedule = scheduleFixture(agent, principal);
    const runId = deterministicScheduleRunId(schedule.scheduleId, 1, schedule.startsAt);
    const receipt = (status: 'working' | 'complete') =>
      buildScheduledTurnReceipt(agent, {
        version: 1,
        workspaceId: schedule.workspaceId,
        roomId: schedule.roomId,
        agentPubkey: agent.publicKey,
        principalPubkey: principal.publicKey,
        scheduleId: schedule.scheduleId,
        revision: 1,
        runId,
        nominalAt: schedule.startsAt,
        status,
        at: schedule.startsAt + (status === 'complete' ? 1 : 0),
        reservedTokens: 100,
      });
    const fixture = await calendarFixture({
      agent,
      principal,
      schedule,
      receiptEvents: [receipt('working'), receipt('complete')],
    });
    await fixture.calendar.start();
    await fixture.calendar.wakeNow();
    expect(fixture.dispatch).not.toHaveBeenCalled();
    expect(
      fixture.published.some(
        (event) =>
          parseScheduledTurnReceipt(event)?.value.reason === 'outcome-unknown-after-restart',
      ),
    ).toBe(false);
    await fixture.calendar.dispose();
  });

  it('resumes a relay-only queued run without republishing its queued receipt', async () => {
    vi.useFakeTimers();
    const agent = createIdentity();
    const principal = createIdentity();
    const schedule = scheduleFixture(agent, principal);
    const runId = deterministicScheduleRunId(schedule.scheduleId, 1, schedule.startsAt);
    const queued = buildScheduledTurnReceipt(agent, {
      version: 1,
      workspaceId: schedule.workspaceId,
      roomId: schedule.roomId,
      agentPubkey: agent.publicKey,
      principalPubkey: principal.publicKey,
      scheduleId: schedule.scheduleId,
      revision: 1,
      runId,
      nominalAt: schedule.startsAt,
      status: 'queued',
      at: schedule.startsAt,
      reservedTokens: 100,
    });
    const fixture = await calendarFixture({
      agent,
      principal,
      schedule,
      receiptEvents: [queued],
    });
    await fixture.calendar.start();
    await fixture.calendar.wakeNow();
    expect(fixture.dispatch).toHaveBeenCalledOnce();
    expect(fixture.dispatch.mock.calls[0]![0].queuedEvent.id).toBe(queued.id);
    expect(
      fixture.published.filter(
        (event) => parseScheduledTurnReceipt(event)?.value.status === 'queued',
      ),
    ).toHaveLength(0);
    await fixture.calendar.dispose();
  });

  it('does not activate until a failed queued receipt is durably retried', async () => {
    vi.useFakeTimers();
    let fail = true;
    const fixture = await calendarFixture({
      publish: async (event) => {
        if (parseScheduledTurnReceipt(event)?.value.status === 'queued' && fail) {
          fail = false;
          throw new Error('relay unavailable');
        }
        fixture.published.push(event);
      },
    });
    await fixture.calendar.start();
    await fixture.calendar.wakeNow();
    expect(fixture.dispatch).not.toHaveBeenCalled();
    fixture.setNow(fixture.schedule.startsAt + 5);
    await fixture.calendar.wakeNow();
    expect(fixture.dispatch).toHaveBeenCalledOnce();
    expect(
      fixture.published.filter(
        (event) => parseScheduledTurnReceipt(event)?.value.status === 'queued',
      ),
    ).toHaveLength(1);
    await fixture.calendar.dispose();
  });

  it('retries working publication without activating or failing the run', async () => {
    vi.useFakeTimers();
    let rejectWorking = true;
    const modelCall = vi.fn();
    const fixture = await calendarFixture({
      publish: async (event) => {
        if (
          parseScheduledTurnReceipt(event)?.value.status === 'working' &&
          rejectWorking
        ) {
          rejectWorking = false;
          throw new Error('relay unavailable');
        }
        fixture.published.push(event);
      },
      dispatch: vi.fn(async (_request, beforeModelActivation) => {
        await beforeModelActivation();
        modelCall();
      }),
    });
    await fixture.calendar.start();
    await fixture.calendar.wakeNow();
    expect(modelCall).not.toHaveBeenCalled();
    expect((await fixture.durable.runs())[0]!.state).toBe('queued');
    expect(
      fixture.published.some(
        (event) => parseScheduledTurnReceipt(event)?.value.status === 'failed',
      ),
    ).toBe(false);

    fixture.setNow(fixture.schedule.startsAt + 5);
    await fixture.calendar.wakeNow();
    expect(modelCall).toHaveBeenCalledOnce();
    expect(await fixture.durable.runs()).toHaveLength(0);
    expect(await fixture.durable.checkpoints()).toContainEqual(
      expect.objectContaining({
        latestRunStatus: 'complete',
        watermarkNominalAt: fixture.schedule.startsAt,
      }),
    );
    await fixture.calendar.dispose();
  });

  it('keeps a transient post-admission refusal queued for retry', async () => {
    vi.useFakeTimers();
    let authorityReads = 0;
    const modelCall = vi.fn();
    const fixture = await calendarFixture({
      authority: async () => {
        authorityReads += 1;
        return authorityReads === 3
          ? { authorized: false, terminal: false, reason: 'authority-unavailable' }
          : { authorized: true };
      },
      dispatch: vi.fn(async (_request, beforeModelActivation) => {
        await beforeModelActivation();
        modelCall();
      }),
    });
    await fixture.calendar.start();
    await fixture.calendar.wakeNow();
    expect(modelCall).not.toHaveBeenCalled();
    expect((await fixture.durable.runs())[0]?.state).toBe('queued');
    expect(
      fixture.published.some(
        (event) => parseScheduledTurnReceipt(event)?.value.status === 'failed',
      ),
    ).toBe(false);

    fixture.setNow(fixture.schedule.startsAt + 5);
    await fixture.calendar.wakeNow();
    expect(modelCall).toHaveBeenCalledOnce();
    expect(await fixture.durable.runs()).toHaveLength(0);
    expect(await fixture.durable.checkpoints()).toContainEqual(
      expect.objectContaining({
        latestRunStatus: 'complete',
        watermarkNominalAt: fixture.schedule.startsAt,
      }),
    );
    await fixture.calendar.dispose();
  });

  it.each([
    'principal-removed',
    'agent-removed',
    'room-archived',
    'schedule-author-role-lost',
    'grant-revoked',
  ])('skips without a model call when fresh authority says %s', async (reason) => {
    vi.useFakeTimers();
    const fixture = await calendarFixture({
      authority: { authorized: false, terminal: true, reason },
    });
    // Configuration selection also uses fresh authority, so simulate loss
    // after the first accepted refresh and before activation.
    let checks = 0;
    Reflect.set(fixture.calendar, 'dependencies', {
      ...Reflect.get(fixture.calendar, 'dependencies'),
      authorize: async () =>
        ++checks === 1 ? { authorized: true } : { authorized: false, terminal: true, reason },
    });
    await fixture.calendar.start();
    await fixture.calendar.wakeNow();
    expect(fixture.dispatch).not.toHaveBeenCalled();
    expect(
      fixture.published.some((event) => parseScheduledTurnReceipt(event)?.value.reason === reason),
    ).toBe(true);
    await fixture.calendar.dispose();
  });

  it('revalidates authority after scheduler admission and before the model call', async () => {
    vi.useFakeTimers();
    let checks = 0;
    const modelCall = vi.fn();
    const fixture = await calendarFixture({
      authority: async () =>
        ++checks < 3
          ? { authorized: true }
          : { authorized: false, terminal: true, reason: 'grant-revoked' },
      dispatch: vi.fn(async (_request, beforeModelActivation) => {
        await beforeModelActivation();
        modelCall();
      }),
    });
    await fixture.calendar.start();
    await fixture.calendar.wakeNow();
    expect(fixture.dispatch).toHaveBeenCalledOnce();
    expect(modelCall).not.toHaveBeenCalled();
    expect(
      fixture.published.some(
        (event) => parseScheduledTurnReceipt(event)?.value.reason === 'grant-revoked',
      ),
    ).toBe(true);
    await fixture.calendar.dispose();
  });

  it('rechecks mandatory expiry after reservation and queued publication', async () => {
    vi.useFakeTimers();
    const agent = createIdentity();
    const principal = createIdentity();
    const schedule = scheduleFixture(agent, principal, { expiresAt: 1_900_000_001 });
    let now = schedule.startsAt;
    let authorityChecks = 0;
    const published: NostrEvent[] = [];
    const dispatch = vi.fn(async (_request, beforeModelActivation) => {
      await beforeModelActivation();
    });
    const calendar = new WorkCalendar({
      identity: agent,
      workspaceId: schedule.workspaceId,
      store: await state(),
      readSchedules: async () => [
        buildWorkSchedule(principal, schedule, { createdAt: schedule.startsAt - 1 }),
      ],
      readReceipts: async () => [],
      authorize: async () => {
        authorityChecks += 1;
        if (authorityChecks === 2) now = schedule.expiresAt + 1;
        return { authorized: true };
      },
      publish: async (event) => published.push(event),
      dispatch,
      now: () => now,
      resyncSeconds: 3_600,
    });
    await calendar.start();
    await calendar.wakeNow();
    expect(dispatch).not.toHaveBeenCalled();
    expect(
      published.some(
        (event) => parseScheduledTurnReceipt(event)?.value.reason === 'schedule-expired',
      ),
    ).toBe(true);
    await calendar.dispose();
  });

  it('enforces max-run and daily reserved-token budgets before activation', async () => {
    vi.useFakeTimers();
    const agent = createIdentity();
    const principal = createIdentity();
    const schedule = scheduleFixture(agent, principal, {
      maxRuns: 5,
      perRunReservedTokens: 100,
      dailyReservedTokens: 100,
    });
    const priorAt = schedule.startsAt - 60;
    const priorId = deterministicScheduleRunId(schedule.scheduleId, 1, priorAt);
    const prior: ScheduledTurnReceiptV1 = {
      version: 1,
      workspaceId: schedule.workspaceId,
      roomId: schedule.roomId,
      agentPubkey: agent.publicKey,
      principalPubkey: principal.publicKey,
      scheduleId: schedule.scheduleId,
      revision: 1,
      runId: priorId,
      nominalAt: priorAt,
      status: 'complete',
      at: priorAt,
      reservedTokens: 100,
    };
    const fixture = await calendarFixture({
      agent,
      principal,
      schedule,
      receiptEvents: [buildScheduledTurnReceipt(agent, prior)],
    });
    await fixture.calendar.start();
    await fixture.calendar.wakeNow();
    expect(fixture.dispatch).not.toHaveBeenCalled();
    expect(
      fixture.published.some(
        (event) => parseScheduledTurnReceipt(event)?.value.reason === 'daily-budget-exhausted',
      ),
    ).toBe(true);
    await fixture.calendar.dispose();
  });

  it('counts prior model activations against maxRuns independently of the daily budget', async () => {
    vi.useFakeTimers();
    const agent = createIdentity();
    const principal = createIdentity();
    const schedule = scheduleFixture(agent, principal, {
      maxRuns: 1,
      perRunReservedTokens: 100,
      dailyReservedTokens: 10_000,
    });
    const priorAt = schedule.startsAt - 86_400;
    const priorId = deterministicScheduleRunId(schedule.scheduleId, 1, priorAt);
    const prior = buildScheduledTurnReceipt(agent, {
      version: 1,
      workspaceId: schedule.workspaceId,
      roomId: schedule.roomId,
      agentPubkey: agent.publicKey,
      principalPubkey: principal.publicKey,
      scheduleId: schedule.scheduleId,
      revision: 1,
      runId: priorId,
      nominalAt: priorAt,
      status: 'complete',
      at: priorAt,
      reservedTokens: 100,
    });
    const fixture = await calendarFixture({ agent, principal, schedule, receiptEvents: [prior] });
    await fixture.calendar.start();
    await fixture.calendar.wakeNow();
    expect(fixture.dispatch).not.toHaveBeenCalled();
    expect(
      fixture.published.some(
        (event) => parseScheduledTurnReceipt(event)?.value.reason === 'max-runs-exhausted',
      ),
    ).toBe(true);
    await fixture.calendar.dispose();
  });

  it('does not fall back to an older revision by an author whose newest record is unauthorized', async () => {
    vi.useFakeTimers();
    const agent = createIdentity();
    const principal = createIdentity();
    const first = scheduleFixture(agent, principal);
    const second = { ...first, revision: 2 };
    const firstEvent = buildWorkSchedule(principal, first, { createdAt: first.startsAt - 20 });
    const secondEvent = buildWorkSchedule(principal, second, { createdAt: first.startsAt - 10 });
    const durable = await state();
    const dispatch = vi.fn(async (_request, beforeModelActivation) => {
      await beforeModelActivation();
    });
    const calendar = new WorkCalendar({
      identity: agent,
      workspaceId: first.workspaceId,
      store: durable,
      readSchedules: async () => [firstEvent, secondEvent],
      readReceipts: async () => [],
      authorize: async (candidate) =>
        candidate.value.revision === 2
          ? { authorized: false, terminal: true, reason: 'grant-revoked' }
          : { authorized: true },
      publish: async () => undefined,
      dispatch,
      now: () => first.startsAt,
      resyncSeconds: 3_600,
    });
    await calendar.start();
    await calendar.wakeNow();
    expect(dispatch).not.toHaveBeenCalled();
    expect(calendar.snapshot().schedules).toBe(0);
    await calendar.dispose();
  });

  it('does not fall back across authors when the canonical author loses authority', async () => {
    vi.useFakeTimers();
    const agent = createIdentity();
    const principal = createIdentity();
    const first = scheduleFixture(agent, principal);
    const second = {
      ...first,
      revision: 2,
      permissionGrantEventId: 'a'.repeat(64),
    };
    const fixture = await calendarFixture({
      agent,
      principal,
      schedule: first,
      scheduleEvents: [
        buildWorkSchedule(principal, first, { createdAt: first.startsAt - 20 }),
        buildWorkSchedule(agent, second, { createdAt: first.startsAt - 10 }),
      ],
      authority: async (candidate) =>
        candidate.value.revision === 2
          ? { authorized: false, terminal: true, reason: 'schedule-change-grant-invalid' }
          : { authorized: true },
    });
    await fixture.calendar.start();
    await fixture.calendar.wakeNow();
    expect(fixture.dispatch).not.toHaveBeenCalled();
    await fixture.calendar.dispose();
  });

  it('pins the creating principal and never falls back after their authority lapses', async () => {
    vi.useFakeTimers();
    const agent = createIdentity();
    const principal = createIdentity();
    const replacement = createIdentity();
    const first = scheduleFixture(agent, principal);
    const schedules = [
      buildWorkSchedule(principal, first, { createdAt: first.startsAt - 20 }),
    ];
    let principalLost = false;
    const fixture = await calendarFixture({
      agent,
      principal,
      schedule: first,
      scheduleEvents: schedules,
      authority: async (candidate) =>
        principalLost && candidate.value.principalPubkey === principal.publicKey
          ? { authorized: false, terminal: true, reason: 'principal-removed' }
          : { authorized: true },
    });
    await fixture.calendar.start();
    expect(await fixture.durable.principalForSchedule(first.scheduleId)).toBe(
      principal.publicKey,
    );

    principalLost = true;
    schedules.push(
      buildWorkSchedule(principal, { ...first, revision: 2 }, { createdAt: first.startsAt - 10 }),
      buildWorkSchedule(
        replacement,
        {
          ...first,
          revision: 999,
          principalPubkey: replacement.publicKey,
        },
        { createdAt: first.startsAt - 5 },
      ),
    );
    await fixture.calendar.refreshNow();
    await fixture.calendar.wakeNow();
    expect(fixture.calendar.snapshot().schedules).toBe(0);
    expect(fixture.dispatch).not.toHaveBeenCalled();
    expect(await fixture.durable.principalForSchedule(first.scheduleId)).toBe(
      principal.publicKey,
    );

    principalLost = false;
    await fixture.calendar.refreshNow();
    expect(fixture.calendar.snapshot().schedules).toBe(0);
    expect(await fixture.durable.checkpoints()).toContainEqual(
      expect.objectContaining({
        revision: 2,
        status: 'paused',
        pauseReason: 'principal-removed',
      }),
    );

    schedules.push(
      buildWorkSchedule(
        agent,
        { ...first, revision: 3, permissionGrantEventId: 'a'.repeat(64) },
        { createdAt: first.startsAt - 4 },
      ),
    );
    await fixture.calendar.refreshNow();
    expect(fixture.calendar.snapshot().schedules).toBe(0);

    schedules.push(
      buildWorkSchedule(principal, { ...first, revision: 4 }, { createdAt: first.startsAt - 3 }),
    );
    await fixture.calendar.refreshNow();
    expect(fixture.calendar.snapshot().schedules).toBe(1);
    await fixture.calendar.dispose();
  });

  it('rejects a tampered daemon checkpoint and fails closed', async () => {
    vi.useFakeTimers();
    const agent = createIdentity();
    const principal = createIdentity();
    const schedule = scheduleFixture(agent, principal);
    const checkpoint = buildWorkScheduleProjection(agent, {
      version: 1,
      type: 'runtime',
      checkpointVersion: 1,
      workspaceId: schedule.workspaceId,
      roomId: schedule.roomId,
      agentPubkey: agent.publicKey,
      principalPubkey: principal.publicKey,
      scheduleId: schedule.scheduleId,
      revision: 1,
      status: 'active',
      consecutiveFailures: 0,
      updatedAt: schedule.startsAt - 1,
      runCount: 10,
      budgetDay: dayUtcForTest(schedule.startsAt),
      dailyReservedTokens: 0,
      receiptCursorAt: schedule.startsAt - 1,
    });
    const tampered = { ...checkpoint, content: checkpoint.content.replace('"runCount":10', '"runCount":11') };
    const fixture = await calendarFixture({ agent, principal, schedule, receiptEvents: [tampered] });
    await fixture.calendar.start();
    await fixture.calendar.wakeNow();
    expect(fixture.calendar.snapshot().schedules).toBe(0);
    expect(fixture.dispatch).not.toHaveBeenCalled();
    await fixture.calendar.dispose();
  });

  it('keeps a newer local million-run checkpoint over a regressing relay projection', async () => {
    vi.useFakeTimers();
    const agent = createIdentity();
    const principal = createIdentity();
    const schedule = scheduleFixture(agent, principal, { maxRuns: 1_000_000 });
    const durable = await state();
    const local = {
      version: 1 as const,
      type: 'runtime' as const,
      checkpointVersion: 1 as const,
      workspaceId: schedule.workspaceId,
      roomId: schedule.roomId,
      agentPubkey: agent.publicKey,
      principalPubkey: principal.publicKey,
      scheduleId: schedule.scheduleId,
      revision: 1,
      status: 'active' as const,
      consecutiveFailures: 0,
      updatedAt: schedule.startsAt,
      runCount: 1_000_000,
      budgetDay: dayUtcForTest(schedule.startsAt),
      dailyReservedTokens: 0,
      receiptCursorAt: schedule.startsAt,
    };
    await durable.stageCheckpoint(local, []);
    const regressing = buildWorkScheduleProjection(agent, {
      ...local,
      updatedAt: schedule.startsAt - 1,
      runCount: 999_999,
      receiptCursorAt: schedule.startsAt - 1,
    });
    expect(parseWorkScheduleCheckpoint(regressing)).toBeDefined();
    const fixture = await calendarFixture({
      agent,
      principal,
      schedule,
      store: durable,
      receiptEvents: [regressing],
    });
    await fixture.calendar.start();
    await fixture.calendar.wakeNow();
    expect(fixture.dispatch).not.toHaveBeenCalled();
    expect((await durable.checkpoints())[0]?.runCount).toBe(1_000_000);
    await fixture.calendar.dispose();
  });

  it('recovers the creation principal before evaluating newer cold-start revisions', async () => {
    vi.useFakeTimers();
    const agent = createIdentity();
    const principal = createIdentity();
    const replacement = createIdentity();
    const first = scheduleFixture(agent, principal);
    const fixture = await calendarFixture({
      agent,
      principal,
      schedule: first,
      scheduleEvents: [
        buildWorkSchedule(principal, first, { createdAt: first.startsAt - 30 }),
        buildWorkSchedule(principal, { ...first, revision: 2 }, { createdAt: first.startsAt - 20 }),
        buildWorkSchedule(
          replacement,
          { ...first, revision: 999, principalPubkey: replacement.publicKey },
          { createdAt: first.startsAt - 10 },
        ),
      ],
      authority: async (candidate) =>
        candidate.value.principalPubkey === principal.publicKey
          ? { authorized: false, terminal: true, reason: 'principal-removed' }
          : { authorized: true },
    });
    await fixture.calendar.start();
    await fixture.calendar.wakeNow();
    expect(await fixture.durable.principalForSchedule(first.scheduleId)).toBe(
      principal.publicKey,
    );
    expect(fixture.calendar.snapshot().schedules).toBe(0);
    expect(fixture.dispatch).not.toHaveBeenCalled();
    await fixture.calendar.dispose();
  });

  it('fails closed when signed creation history names multiple principals', async () => {
    vi.useFakeTimers();
    const agent = createIdentity();
    const principal = createIdentity();
    const replacement = createIdentity();
    const schedule = scheduleFixture(agent, principal);
    const fixture = await calendarFixture({
      agent,
      principal,
      schedule,
      scheduleEvents: [
        buildWorkSchedule(principal, schedule, { createdAt: schedule.startsAt - 20 }),
        buildWorkSchedule(
          replacement,
          { ...schedule, principalPubkey: replacement.publicKey },
          { createdAt: schedule.startsAt - 10 },
        ),
      ],
    });
    await fixture.calendar.start();
    await fixture.calendar.wakeNow();
    expect(await fixture.durable.principalForSchedule(schedule.scheduleId)).toBeUndefined();
    expect(fixture.calendar.snapshot().schedules).toBe(0);
    expect(fixture.dispatch).not.toHaveBeenCalled();
    await fixture.calendar.dispose();
  });

  it('requires an agent-authored creation to have a valid human authorization chain', async () => {
    vi.useFakeTimers();
    const agent = createIdentity();
    const principal = createIdentity();
    const schedule = scheduleFixture(agent, principal, {
      permissionGrantEventId: 'a'.repeat(64),
    });
    const validateScheduleCreation = vi.fn(async () => false);
    const fixture = await calendarFixture({
      agent,
      principal,
      schedule,
      scheduleEvents: [
        buildWorkSchedule(agent, schedule, { createdAt: schedule.startsAt - 10 }),
      ],
      validateScheduleCreation,
    });
    await fixture.calendar.start();
    await fixture.calendar.wakeNow();
    expect(validateScheduleCreation).toHaveBeenCalledOnce();
    expect(await fixture.durable.principalForSchedule(schedule.scheduleId)).toBeUndefined();
    expect(fixture.dispatch).not.toHaveBeenCalled();
    await fixture.calendar.dispose();
  });

  it('ignores forged relay receipts when recovering the creation principal', async () => {
    vi.useFakeTimers();
    const agent = createIdentity();
    const principal = createIdentity();
    const outsider = createIdentity();
    const schedule = scheduleFixture(agent, principal);
    const forgedRunId = deterministicScheduleRunId(schedule.scheduleId, 1, schedule.startsAt - 60);
    const receiptValue = {
      version: 1,
      workspaceId: schedule.workspaceId,
      roomId: schedule.roomId,
      agentPubkey: agent.publicKey,
      principalPubkey: outsider.publicKey,
      scheduleId: schedule.scheduleId,
      revision: 1,
      runId: forgedRunId,
      nominalAt: schedule.startsAt - 60,
      status: 'complete',
      at: schedule.startsAt - 60,
      reservedTokens: 100,
    } as const;
    const receiptShape = buildScheduledTurnReceipt(agent, receiptValue);
    const forgedReceipt = signEvent(
      {
        pubkey: outsider.publicKey,
        created_at: receiptShape.created_at,
        kind: receiptShape.kind,
        tags: receiptShape.tags,
        content: receiptShape.content,
      },
      outsider.secretKey,
    );
    const fixture = await calendarFixture({
      agent,
      principal,
      schedule,
      receiptEvents: [forgedReceipt],
    });
    await fixture.calendar.start();
    await fixture.calendar.wakeNow();
    expect(await fixture.durable.principalForSchedule(schedule.scheduleId)).toBe(
      principal.publicKey,
    );
    expect(fixture.dispatch).toHaveBeenCalledOnce();
    await fixture.calendar.dispose();
  });

  it('accepts an authorized delete tombstone without dispatching work', async () => {
    vi.useFakeTimers();
    const agent = createIdentity();
    const principal = createIdentity();
    const deleted = scheduleFixture(agent, principal, { revision: 2, status: 'deleted' });
    const fixture = await calendarFixture({
      agent,
      principal,
      schedule: deleted,
      scheduleEvents: [
        buildWorkSchedule(principal, { ...deleted, revision: 1, status: 'active' }, {
          createdAt: deleted.startsAt - 20,
        }),
        buildWorkSchedule(principal, deleted, { createdAt: deleted.startsAt - 10 }),
      ],
    });
    await fixture.calendar.start();
    await fixture.calendar.wakeNow();
    expect(fixture.calendar.snapshot().schedules).toBe(1);
    expect(fixture.dispatch).not.toHaveBeenCalled();
    await fixture.calendar.dispose();
  });

  it('ignores a high-revision record by an unauthorized outside author', async () => {
    vi.useFakeTimers();
    const agent = createIdentity();
    const principal = createIdentity();
    const outsider = createIdentity();
    const schedule = scheduleFixture(agent, principal);
    const legitimate = buildWorkSchedule(principal, schedule, {
      createdAt: schedule.startsAt - 20,
    });
    const forgedValue = { ...schedule, revision: 999, principalPubkey: outsider.publicKey };
    const forged = buildWorkSchedule(outsider, forgedValue, { createdAt: schedule.startsAt - 10 });
    const dispatch = vi.fn(async (_request, beforeModelActivation) => {
      await beforeModelActivation();
    });
    const calendar = new WorkCalendar({
      identity: agent,
      workspaceId: schedule.workspaceId,
      store: await state(),
      readSchedules: async () => [legitimate, forged],
      readReceipts: async () => [],
      authorize: async (candidate) =>
        candidate.event.pubkey === outsider.publicKey
          ? { authorized: false, terminal: true, reason: 'principal-removed' }
          : { authorized: true },
      publish: async () => undefined,
      dispatch,
      now: () => schedule.startsAt,
      resyncSeconds: 3_600,
    });
    await calendar.start();
    await calendar.wakeNow();
    expect(dispatch).toHaveBeenCalledOnce();
    await calendar.dispose();
  });

  it('bounds long-outage catch-up to zero or one model calls', async () => {
    vi.useFakeTimers();
    const latest = await calendarFixture({ now: 1_900_086_400 });
    await latest.calendar.start();
    await latest.calendar.wakeNow();
    expect(latest.dispatch).toHaveBeenCalledOnce();
    await latest.calendar.dispose();

    const skipAgent = createIdentity();
    const skipPrincipal = createIdentity();
    const skipSchedule = scheduleFixture(skipAgent, skipPrincipal, { catchUp: 'skip' });
    const skip = await calendarFixture({
      agent: skipAgent,
      principal: skipPrincipal,
      schedule: skipSchedule,
      now: 1_900_086_400,
    });
    await skip.calendar.start();
    await skip.calendar.wakeNow();
    expect(skip.dispatch).not.toHaveBeenCalled();
    const skipped = skip.published.filter(
      (event) => parseScheduledTurnReceipt(event)?.value.status === 'skipped',
    );
    expect(skipped).toHaveLength(1);
    await skip.calendar.dispose();
  });

  it('pauses after consecutive failure and a new revision resumes with a new run id', async () => {
    vi.useFakeTimers();
    const agent = createIdentity();
    const principal = createIdentity();
    const firstSchedule = scheduleFixture(agent, principal, { maxConsecutiveFailures: 1 });
    const schedules = [
      buildWorkSchedule(principal, firstSchedule, { createdAt: firstSchedule.startsAt - 10 }),
    ];
    let dispatchCalls = 0;
    const dispatch = vi.fn(async (_request, beforeModelActivation) => {
      await beforeModelActivation();
      dispatchCalls += 1;
      if (dispatchCalls === 1) throw new Error('provider down');
    });
    const fixture = await calendarFixture({
      agent,
      principal,
      schedule: firstSchedule,
      scheduleEvents: schedules,
      dispatch,
    });
    await fixture.calendar.start();
    await fixture.calendar.wakeNow();
    expect(dispatch).toHaveBeenCalledOnce();
    expect(
      fixture.published.some((event) =>
        event.tags.some((tag) => tag[0] === 't' && tag[1] === WORK_SCHEDULE_PAUSED_TAG),
      ),
    ).toBe(true);
    const firstRun = dispatch.mock.calls[0]![0].scheduleRunId;

    const revision = { ...firstSchedule, revision: 2, status: 'active' as const };
    schedules.push(
      buildWorkSchedule(principal, revision, { createdAt: firstSchedule.startsAt + 1 }),
    );
    await fixture.calendar.refreshNow();
    await fixture.calendar.wakeNow();
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(dispatch.mock.calls[1]![0].scheduleRunId).not.toBe(firstRun);
    await fixture.calendar.dispose();
  });

  it('retries the one actionable failure-pause card from the durable outbox', async () => {
    vi.useFakeTimers();
    let refusePause = true;
    const fixture = await calendarFixture({
      schedule: undefined,
      dispatch: vi.fn(async (_request, beforeModelActivation) => {
        await beforeModelActivation();
        throw new Error('provider unavailable');
      }),
      publish: async (event) => {
        const pause = event.tags.some(
          (tag) => tag[0] === 't' && tag[1] === WORK_SCHEDULE_PAUSED_TAG,
        );
        if (pause && refusePause) {
          refusePause = false;
          throw new Error('relay unavailable');
        }
        fixture.published.push(event);
      },
    });
    fixture.schedule.maxConsecutiveFailures = 1;
    fixture.scheduleEvents.splice(
      0,
      1,
      buildWorkSchedule(fixture.principal, fixture.schedule, {
        createdAt: fixture.schedule.startsAt - 10,
      }),
    );
    await fixture.calendar.start();
    await fixture.calendar.wakeNow();
    expect(
      fixture.published.filter((event) =>
        event.tags.some((tag) => tag[0] === 't' && tag[1] === WORK_SCHEDULE_PAUSED_TAG),
      ),
    ).toHaveLength(0);
    await fixture.calendar.dispose();

    const restarted = new WorkCalendar({
      identity: fixture.agent,
      workspaceId: fixture.schedule.workspaceId,
      store: fixture.durable,
      readSchedules: async () => fixture.scheduleEvents,
      readReceipts: async () => fixture.published,
      authorize: async () => ({ authorized: true }),
      publish: async (event) => fixture.published.push(event),
      dispatch: async () => undefined,
      now: () => fixture.schedule.startsAt,
      resyncSeconds: 3_600,
    });
    await restarted.start();
    expect(
      fixture.published.filter((event) =>
        event.tags.some((tag) => tag[0] === 't' && tag[1] === WORK_SCHEDULE_PAUSED_TAG),
      ),
    ).toHaveLength(1);
    await restarted.dispose();
  });

  it('recovers a staged failure pause after a crash before publication', async () => {
    vi.useFakeTimers();
    const root = await mkdtemp(resolve(tmpdir(), 'beeline-work-calendar-crash-'));
    roots.push(root);
    class CrashAfterCompletionStore extends DurableWorkCalendarState {
      private shouldCrash = true;

      override async stageCompletion(
        ...args: Parameters<DurableWorkCalendarState['stageCompletion']>
      ): Promise<void> {
        await super.stageCompletion(...args);
        if (this.shouldCrash) {
          this.shouldCrash = false;
          throw new Error('crash-after-stage');
        }
      }
    }
    const durable = new CrashAfterCompletionStore(resolve(root, 'calendar.json'));
    const fixture = await calendarFixture({
      store: durable,
      dispatch: vi.fn(async (_request, beforeModelActivation) => {
        await beforeModelActivation();
        throw new Error('provider unavailable');
      }),
    });
    fixture.schedule.maxConsecutiveFailures = 1;
    fixture.scheduleEvents.splice(
      0,
      1,
      buildWorkSchedule(fixture.principal, fixture.schedule, {
        createdAt: fixture.schedule.startsAt - 10,
      }),
    );

    await fixture.calendar.start();
    await fixture.calendar.wakeNow();
    expect((await durable.runs())[0]?.state).toBe('failed');
    expect(
      (await durable.pendingOutputs()).some(({ event }) =>
        event.tags.some((tag) => tag[0] === 't' && tag[1] === WORK_SCHEDULE_PAUSED_TAG),
      ),
    ).toBe(true);
    expect(
      fixture.published.some((event) =>
        event.tags.some((tag) => tag[0] === 't' && tag[1] === WORK_SCHEDULE_PAUSED_TAG),
      ),
    ).toBe(false);
    await fixture.calendar.dispose();

    const restartedDispatch = vi.fn();
    const restarted = new WorkCalendar({
      identity: fixture.agent,
      workspaceId: fixture.schedule.workspaceId,
      store: durable,
      readSchedules: async () => fixture.scheduleEvents,
      readReceipts: async () => fixture.published,
      authorize: async () => ({ authorized: true }),
      publish: async (event) => fixture.published.push(event),
      dispatch: restartedDispatch,
      now: () => fixture.schedule.startsAt,
      resyncSeconds: 3_600,
    });
    await restarted.start();
    expect(
      fixture.published.filter((event) =>
        event.tags.some((tag) => tag[0] === 't' && tag[1] === WORK_SCHEDULE_PAUSED_TAG),
      ),
    ).toHaveLength(1);
    expect(restartedDispatch).not.toHaveBeenCalled();
    await restarted.dispose();
  });

  it('reconstructs relay-only failure pause outputs after local state loss', async () => {
    vi.useFakeTimers();
    const agent = createIdentity();
    const principal = createIdentity();
    const schedule = scheduleFixture(agent, principal, { maxConsecutiveFailures: 2 });
    const receiptEvents = [schedule.startsAt, schedule.startsAt + 60].map((nominalAt) =>
      buildScheduledTurnReceipt(agent, {
        version: 1,
        workspaceId: schedule.workspaceId,
        roomId: schedule.roomId,
        agentPubkey: agent.publicKey,
        principalPubkey: principal.publicKey,
        scheduleId: schedule.scheduleId,
        revision: schedule.revision,
        runId: deterministicScheduleRunId(schedule.scheduleId, schedule.revision, nominalAt),
        nominalAt,
        status: 'failed',
        at: nominalAt + 1,
        reservedTokens: schedule.perRunReservedTokens,
        reason: 'provider unavailable',
      }),
    );
    const fixture = await calendarFixture({
      agent,
      principal,
      schedule,
      now: schedule.startsAt + 120,
      receiptEvents,
    });
    await fixture.calendar.start();
    expect(fixture.dispatch).not.toHaveBeenCalled();
    expect(
      fixture.published.filter((event) =>
        event.tags.some((tag) => tag[0] === 't' && tag[1] === WORK_SCHEDULE_PAUSED_TAG),
      ),
    ).toHaveLength(1);
    const projection = fixture.published.find((event) =>
      event.tags.some((tag) => tag[0] === 't' && tag[1] === WORK_SCHEDULE_RUNTIME_TAG),
    );
    expect(projection && JSON.parse(projection.content)).toMatchObject({
      status: 'paused',
      consecutiveFailures: 2,
    });
    await fixture.calendar.dispose();
  });

  it('publishes immutable scheduled receipts with the complete status progression', async () => {
    vi.useFakeTimers();
    const fixture = await calendarFixture();
    await fixture.calendar.start();
    await fixture.calendar.wakeNow();
    const statuses = fixture.published.flatMap((event) => {
      const parsed = parseScheduledTurnReceipt(event);
      return parsed && event.tags.some((tag) => tag[0] === 't' && tag[1] === SCHEDULED_TURN_TAG)
        ? [parsed.value.status]
        : [];
    });
    expect(statuses).toEqual(['queued', 'working', 'complete']);
    await fixture.calendar.dispose();
  });

  it('replays a staged model output after relay failure without another model call', async () => {
    vi.useFakeTimers();
    const agent = createIdentity();
    const principal = createIdentity();
    const schedule = scheduleFixture(agent, principal);
    const durable = await state();
    const published: NostrEvent[] = [];
    let rejectOutput = true;
    const publish = async (event: NostrEvent) => {
      if (event.tags.some((tag) => tag[0] === 't' && tag[1] === 'agent-message') && rejectOutput) {
        rejectOutput = false;
        throw new Error('relay unavailable');
      }
      published.push(event);
    };
    const modelCall = vi.fn();
    const dispatch: WorkCalendarDependencies['dispatch'] = async (
      request,
      beforeModelActivation,
      publishOutput,
    ) => {
      await beforeModelActivation();
      modelCall();
      await publishOutput(
        signEvent(
          {
            pubkey: agent.publicKey,
            created_at: schedule.startsAt,
            kind: 9,
            tags: [
              ['h', request.roomId],
              ['t', 'agent-message'],
              ['request', request.queuedEvent.id],
            ],
            content: 'durable scheduled result',
          },
          agent.secretKey,
        ),
      );
    };
    const scheduleEvents = [
      buildWorkSchedule(principal, schedule, { createdAt: schedule.startsAt - 1 }),
    ];
    const first = new WorkCalendar({
      identity: agent,
      workspaceId: schedule.workspaceId,
      store: durable,
      readSchedules: async () => scheduleEvents,
      readReceipts: async () => published,
      authorize: async () => ({ authorized: true }),
      publish,
      dispatch,
      now: () => schedule.startsAt,
      resyncSeconds: 3_600,
    });
    await first.start();
    await first.wakeNow();
    await first.dispose();
    expect(modelCall).toHaveBeenCalledOnce();
    expect(published.some((event) => event.content === 'durable scheduled result')).toBe(false);
    expect(
      published.some((event) => parseScheduledTurnReceipt(event)?.value.status === 'failed'),
    ).toBe(true);

    const restarted = new WorkCalendar({
      identity: agent,
      workspaceId: schedule.workspaceId,
      store: durable,
      readSchedules: async () => scheduleEvents,
      readReceipts: async () => published,
      authorize: async () => ({ authorized: true }),
      publish,
      dispatch,
      now: () => schedule.startsAt,
      resyncSeconds: 3_600,
    });
    await restarted.start();
    expect(published.some((event) => event.content === 'durable scheduled result')).toBe(true);
    expect(modelCall).toHaveBeenCalledOnce();
    await restarted.dispose();
  });

  it('stays queued until the background dispatcher admits the model activation', async () => {
    vi.useFakeTimers();
    let admit!: () => void;
    let dispatchStarted!: () => void;
    const admission = new Promise<void>((resolveAdmission) => {
      admit = resolveAdmission;
    });
    const started = new Promise<void>((resolveStarted) => {
      dispatchStarted = resolveStarted;
    });
    const fixture = await calendarFixture({
      dispatch: async (_request, beforeModelActivation) => {
        dispatchStarted();
        await admission;
        await beforeModelActivation();
      },
    });
    await fixture.calendar.start();
    const wake = fixture.calendar.wakeNow();
    await started;
    expect(
      fixture.published.flatMap((event) => {
        const parsed = parseScheduledTurnReceipt(event);
        return parsed ? [parsed.value.status] : [];
      }),
    ).toEqual(['queued']);
    admit();
    await wake;
    expect(
      fixture.published.flatMap((event) => {
        const parsed = parseScheduledTurnReceipt(event);
        return parsed ? [parsed.value.status] : [];
      }),
    ).toEqual(['queued', 'working', 'complete']);
    await fixture.calendar.dispose();
  });

  it('submits all due schedules to the dispatcher before either turn completes', async () => {
    vi.useFakeTimers();
    const agent = createIdentity();
    const principal = createIdentity();
    const first = scheduleFixture(agent, principal, { scheduleId: 'parallel-one' });
    const second = scheduleFixture(agent, principal, { scheduleId: 'parallel-two' });
    let release!: () => void;
    const held = new Promise<void>((resolveHeld) => {
      release = resolveHeld;
    });
    const dispatch = vi.fn(async (_request, beforeModelActivation) => {
      await beforeModelActivation();
      await held;
    });
    const fixture = await calendarFixture({
      agent,
      principal,
      schedule: first,
      scheduleEvents: [
        buildWorkSchedule(principal, first, { createdAt: first.startsAt - 1 }),
        buildWorkSchedule(principal, second, { createdAt: second.startsAt - 1 }),
      ],
      dispatch,
    });
    await fixture.calendar.start();
    const wake = fixture.calendar.wakeNow();
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(2));
    release();
    await wake;
    await fixture.calendar.dispose();
  });
});
