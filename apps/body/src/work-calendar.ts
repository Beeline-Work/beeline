/**
 * Durable per-agent work calendar runtime.
 *
 * This module decides whether an authorized recurring work item is due. It
 * never owns ACP process capacity: admitted work is handed to the ordinary
 * Room dispatcher with `trigger: 'schedule'` and background priority.
 */
import type { NostrEvent } from '@beeline/nostr';
import {
  buildScheduledTurnReceipt,
  deterministicScheduleRunId,
  type ArtifactRevisionRef,
  type Identity,
  type PermissionConcreteAction,
  type ScheduledTurnStatus,
} from '@beeline/buzz-client';
import {
  DEFAULT_CALENDAR_RESYNC_SECONDS,
  DEFAULT_CALENDAR_RETRY_SECONDS,
  MAX_CALENDAR_DUE_PER_WAKE,
  buildWorkSchedulePauseCard,
  buildWorkScheduleProjection,
  nextWorkOccurrence,
  parseWorkSchedule,
  previousWorkOccurrence,
  workScheduleKey,
  workScheduleRevisionDigest,
  type ParsedWorkSchedule,
  type WorkScheduleMission,
  type WorkScheduleV1,
} from './work-schedule.js';
import {
  cloneState,
  type WorkCalendarStore,
  type WorkScheduleRuntimeState,
} from './work-calendar-state.js';

export * from './work-schedule.js';
export { DurableWorkCalendarState } from './work-calendar-state.js';
export type { WorkCalendarStore, WorkScheduleRuntimeState } from './work-calendar-state.js';
export {
  SCHEDULED_TURN_TAG,
  buildScheduledTurnReceipt,
  deterministicScheduleRunId,
  parseScheduledTurnReceipt,
} from '@beeline/buzz-client';
export type {
  ParsedScheduledTurnReceipt,
  ScheduledTurnReceiptV1,
  ScheduledTurnStatus,
} from '@beeline/buzz-client';

export interface ScheduledTurnRequest {
  trigger: 'schedule';
  priority: 'background';
  workspaceId: string;
  roomId: string;
  agentPubkey: string;
  targetAgentPubkey: string;
  principalPubkey: string;
  scheduleId: string;
  scheduleRevision: number;
  scheduleRevisionDigest: string;
  scheduleRunId: string;
  nominalAt: number;
  prompt: string;
  artifactRefs: readonly ArtifactRevisionRef[];
  reservedTokens: number;
  maxRuns: number;
  dailyReservedTokens: number;
  queuedEvent: NostrEvent;
  execution:
    | { mode: 'model' }
    | { mode: 'script'; script: string; scriptSha256: string; timeoutSeconds: number };
  missionAction?: PermissionConcreteAction;
  mission?: WorkScheduleMission;
}

export type ScheduleAuthorityResult =
  { authorized: true } | { authorized: false; terminal: boolean; reason: string };

async function creationPrincipalFromHistory(
  candidates: readonly ParsedWorkSchedule[],
  validate?: (creation: readonly ParsedWorkSchedule[]) => Promise<boolean>,
): Promise<string | undefined> {
  const creation = candidates.filter((candidate) => candidate.value.revision === 1);
  const principals = new Set(creation.map((candidate) => candidate.value.principalPubkey));
  if (creation.length === 0 || principals.size !== 1) return undefined;
  if (validate && !(await validate(creation))) return undefined;
  return creation[0]!.value.principalPubkey;
}

/** Fresh admission failed after the ordinary Room dispatcher won a process slot. */
export class ScheduleActivationRefusedError extends Error {
  constructor(
    readonly terminal: boolean,
    readonly reason: string,
  ) {
    super(reason);
    this.name = 'ScheduleActivationRefusedError';
  }
}

interface HeapEntry {
  key: string;
  parsed: ParsedWorkSchedule;
  nominalAt: number;
  wakeAt: number;
  action: 'run' | 'skip';
}

const RUN_NOW_VISIBILITY_RETRY_MS = 250;

class ScheduleHeap {
  private values: HeapEntry[] = [];
  get size(): number {
    return this.values.length;
  }
  peek(): HeapEntry | undefined {
    return this.values[0];
  }
  clear(): void {
    this.values = [];
  }
  push(value: HeapEntry): void {
    this.values.push(value);
    let index = this.values.length - 1;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (this.compare(this.values[parent]!, value) <= 0) break;
      this.values[index] = this.values[parent]!;
      index = parent;
    }
    this.values[index] = value;
  }
  pop(): HeapEntry | undefined {
    const first = this.values[0];
    const last = this.values.pop();
    if (!first || !last || this.values.length === 0) return first;
    this.values[0] = last;
    let index = 0;
    for (;;) {
      const left = index * 2 + 1;
      const right = left + 1;
      let next = index;
      if (left < this.values.length && this.compare(this.values[left]!, this.values[next]!) < 0)
        next = left;
      if (right < this.values.length && this.compare(this.values[right]!, this.values[next]!) < 0)
        next = right;
      if (next === index) break;
      [this.values[index], this.values[next]] = [this.values[next]!, this.values[index]!];
      index = next;
    }
    return first;
  }
  private compare(left: HeapEntry, right: HeapEntry): number {
    return (
      left.wakeAt - right.wakeAt ||
      left.nominalAt - right.nominalAt ||
      left.key.localeCompare(right.key)
    );
  }
}

export interface WorkCalendarDependencies {
  identity: Identity;
  workspaceId: string;
  store: WorkCalendarStore;
  readSchedules(): Promise<readonly NostrEvent[]>;
  authorize(schedule: ParsedWorkSchedule): Promise<ScheduleAuthorityResult>;
  validateArtifacts?(schedule: ParsedWorkSchedule): Promise<ScheduleAuthorityResult>;
  validateScheduleCreation?(creation: readonly ParsedWorkSchedule[]): Promise<boolean>;
  missionAction?(
    schedule: ParsedWorkSchedule,
    nominalAt: number,
  ): Promise<PermissionConcreteAction | undefined>;
  publish(event: NostrEvent): Promise<void>;
  dispatch(
    request: ScheduledTurnRequest,
    beforeModelActivation: () => Promise<void>,
  ): Promise<void>;
  now?: () => number;
  resyncSeconds?: number;
  retrySeconds?: number;
  runNowVisibilityRetryMs?: number;
}

function dayUtc(at: number): string {
  return new Date(at * 1_000).toISOString().slice(0, 10);
}

/** One heap and one next-due timer for all schedules owned by one agent daemon. */
export class WorkCalendar {
  private readonly heap = new ScheduleHeap();
  private readonly schedules = new Map<string, ParsedWorkSchedule>();
  private readonly states = new Map<string, WorkScheduleRuntimeState>();
  private readonly retryAt = new Map<string, number>();
  private timer?: ReturnType<typeof setTimeout>;
  private nextResyncAt = 0;
  private started = false;
  private disposed = false;
  private wakeTail: Promise<void> = Promise.resolve();

  constructor(private readonly dependencies: WorkCalendarDependencies) {}

  snapshot(): { schedules: number; queued: number; nextAt?: number; timerArmed: boolean } {
    return {
      schedules: this.schedules.size,
      queued: this.heap.size,
      nextAt: this.heap.peek()?.wakeAt,
      timerArmed: Boolean(this.timer),
    };
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    try {
      await this.enqueueWake(async () => {
        await this.dependencies.store.load();
        for (const state of await this.dependencies.store.states()) {
          this.states.set(state.scheduleId, state);
          const schedule = state.scheduleEvent && parseWorkSchedule(state.scheduleEvent);
          if (
            schedule &&
            schedule.value.workspaceId === this.dependencies.workspaceId &&
            schedule.value.agentPubkey === this.dependencies.identity.publicKey &&
            schedule.value.revision === state.revision
          ) {
            this.schedules.set(workScheduleKey(schedule.value), schedule);
          }
        }
        await this.flushPendingReceipts();
        if (this.disposed) return;
        await this.refreshSafely();
      });
    } catch (error) {
      this.started = false;
      throw error;
    }
  }

  /** WS/config test seam: refresh canonical records and re-arm the same single timer. */
  async refreshNow(): Promise<void> {
    await this.enqueueWake(async () => this.refreshSafely());
  }

  async wakeNow(): Promise<void> {
    await this.enqueueWake(async () => this.onWake());
  }

  /** Typed tool seam for one immediate occurrence on the same calendar authority. */
  async runNow(scheduleId: string): Promise<{ runId: string; eventId: string }> {
    let result: { runId: string; eventId: string } | undefined;
    await this.enqueueWake(async () => {
      await this.refresh();
      let found = this.scheduleById(scheduleId);
      // A schedule published by the preceding agent turn may not be visible
      // to the relay's broad projection yet. Retry the canonical read once;
      // a previously authenticated durable record remains available meanwhile.
      if (!found) {
        const delay = this.dependencies.runNowVisibilityRetryMs ?? RUN_NOW_VISIBILITY_RETRY_MS;
        if (delay > 0) await new Promise<void>((resolve) => setTimeout(resolve, delay));
        await this.refresh();
        found = this.scheduleById(scheduleId);
      }
      if (!found || found[1].value.status !== 'active') {
        throw new Error('schedule-unavailable');
      }
      const nominalAt = this.secondsNow();
      const receipt = await this.process({
        key: found[0],
        parsed: found[1],
        nominalAt,
        wakeAt: nominalAt,
        action: 'run',
      });
      if (!receipt) throw new Error('schedule-run-refused');
      result = {
        runId: deterministicScheduleRunId(scheduleId, found[1].value.revision, nominalAt),
        eventId: receipt.id,
      };
    });
    return result!;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    await this.wakeTail.catch(() => undefined);
  }

  private secondsNow(): number {
    return Math.floor(this.dependencies.now?.() ?? Date.now() / 1_000);
  }

  private enqueueWake(task: () => Promise<void>): Promise<void> {
    const run = this.wakeTail.catch(() => undefined).then(task);
    this.wakeTail = run.catch((error) => console.error('[work-calendar] wake failed:', error));
    return run;
  }

  private async refresh(): Promise<void> {
    if (this.disposed) return;
    const scheduleEvents = await this.dependencies.readSchedules();
    const candidates = new Map<string, ParsedWorkSchedule[]>();
    for (const event of scheduleEvents) {
      const parsed = parseWorkSchedule(event);
      if (
        !parsed ||
        parsed.value.workspaceId !== this.dependencies.workspaceId ||
        parsed.value.agentPubkey !== this.dependencies.identity.publicKey
      )
        continue;
      const key = workScheduleKey(parsed.value);
      const list = candidates.get(key) ?? [];
      list.push(parsed);
      candidates.set(key, list);
    }
    for (const [key, list] of candidates) {
      const plausible = list.filter(
        (candidate) =>
          candidate.event.pubkey === candidate.value.principalPubkey ||
          candidate.event.pubkey === candidate.value.agentPubkey ||
          (candidate.value.mission !== undefined &&
            candidate.event.pubkey === candidate.value.mission.controllerAgentPubkey),
      );
      const existing = this.states.get(list[0]!.value.scheduleId);
      const pinnedPrincipal =
        existing?.principalPubkey ??
        (await creationPrincipalFromHistory(plausible, this.dependencies.validateScheduleCreation));
      if (!pinnedPrincipal) continue;
      // The canonical revision is selected before authorization. Never fall
      // back to an older or differently-authored record when the newest
      // revision is paused or has lost authority.
      const current = plausible
        .filter((candidate) => candidate.value.principalPubkey === pinnedPrincipal)
        .sort(
          (left, right) =>
            right.value.revision - left.value.revision ||
            right.event.created_at - left.event.created_at ||
            right.event.id.localeCompare(left.event.id),
        )[0];
      if (!current) continue;
      // A relay read may be temporarily incomplete. Durable state has already
      // observed a newer authenticated revision, so never roll configuration
      // or execution semantics backward to an older projection.
      if (existing && current.value.revision < existing.revision) continue;
      if (existing?.status === 'paused') {
        const humanResume =
          current.value.revision > existing.revision &&
          current.value.status === 'active' &&
          current.event.pubkey === current.value.principalPubkey &&
          current.event.pubkey !== current.value.agentPubkey;
        const missionControllerResume =
          current.value.revision > existing.revision &&
          current.value.status === 'active' &&
          current.value.mission !== undefined &&
          current.event.pubkey === current.value.mission.controllerAgentPubkey;
        const agentToolResume =
          current.value.revision > existing.revision &&
          current.value.status === 'active' &&
          current.value.agentToolMandate !== undefined &&
          current.event.pubkey === current.value.agentPubkey;
        const recoveredAgentToolMandate =
          existing.pauseReason === 'agent-tool-mandate-invalid' &&
          current.value.revision === existing.revision &&
          current.value.status === 'active' &&
          current.value.agentToolMandate !== undefined &&
          current.event.pubkey === current.value.agentPubkey;
        if (
          !humanResume &&
          !missionControllerResume &&
          !agentToolResume &&
          !recoveredAgentToolMandate
        )
          continue;
      }
      const authority = await this.dependencies.authorize(current);
      if (!authority.authorized) {
        if (authority.terminal) await this.pause(current, authority.reason, true);
        else throw new Error(`transient schedule authority failure: ${authority.reason}`);
        continue;
      }
      if (current.value.status === 'paused' || current.value.status === 'cancelled') {
        this.schedules.set(key, current);
        await this.pause(
          current,
          current.value.status === 'cancelled' ? 'schedule-cancelled' : 'schedule-paused',
          false,
        );
        continue;
      }
      const artifacts = await this.validateArtifacts(current);
      if (!artifacts.authorized) {
        if (artifacts.terminal) await this.pause(current, artifacts.reason, true);
        else throw new Error(`transient artifact validation failure: ${artifacts.reason}`);
        continue;
      }
      const recoveredAgentToolMandate =
        existing?.status === 'paused' &&
        existing.pauseReason === 'agent-tool-mandate-invalid' &&
        current.value.revision === existing.revision &&
        current.value.status === 'active' &&
        current.value.agentToolMandate !== undefined &&
        current.event.pubkey === current.value.agentPubkey;
      if (existing && (current.value.revision > existing.revision || recoveredAgentToolMandate)) {
        const resumed: WorkScheduleRuntimeState = {
          ...existing,
          revision: current.value.revision,
          scheduleEvent: current.event,
          consecutiveFailures: 0,
          status: 'active',
        };
        delete resumed.pauseReason;
        await this.persist(resumed);
        if (recoveredAgentToolMandate) await this.publishProjection(current.value, resumed);
      } else if (!existing) {
        await this.persist({
          scheduleId: current.value.scheduleId,
          principalPubkey: pinnedPrincipal,
          revision: current.value.revision,
          scheduleEvent: current.event,
          runCount: 0,
          dailyReservedTokens: 0,
          consecutiveFailures: 0,
          status: 'active',
        });
      } else if (existing.scheduleEvent?.id !== current.event.id) {
        await this.persist({ ...existing, scheduleEvent: current.event });
      }
      this.schedules.set(key, current);
    }
    this.rebuildHeap();
    this.nextResyncAt =
      this.secondsNow() + (this.dependencies.resyncSeconds ?? DEFAULT_CALENDAR_RESYNC_SECONDS);
    this.armTimer();
  }

  private scheduleById(scheduleId: string): [string, ParsedWorkSchedule] | undefined {
    return [...this.schedules.entries()].find(
      ([, parsed]) => parsed.value.scheduleId === scheduleId,
    );
  }

  private async refreshSafely(): Promise<void> {
    try {
      await this.refresh();
    } catch (error) {
      console.error('[work-calendar] canonical refresh failed:', error);
      this.nextResyncAt =
        this.secondsNow() + (this.dependencies.retrySeconds ?? DEFAULT_CALENDAR_RETRY_SECONDS);
      this.armTimer();
    }
  }

  private rebuildHeap(): void {
    this.heap.clear();
    const now = this.secondsNow();
    for (const [key, parsed] of this.schedules) {
      const entry = this.entryFor(key, parsed, now);
      if (entry) this.heap.push(entry);
    }
  }

  private entryFor(key: string, parsed: ParsedWorkSchedule, now: number): HeapEntry | undefined {
    const schedule = parsed.value;
    if (schedule.status !== 'active' || now > schedule.expiresAt) return undefined;
    const state = this.states.get(schedule.scheduleId);
    if (!state || state.status !== 'active' || state.runCount >= schedule.maxRuns) return undefined;
    const after = state.lastExecutionAt ?? schedule.startsAt - 1;
    const next = nextWorkOccurrence(schedule, after);
    if (next === undefined) return undefined;
    if (next < now) {
      const latest = previousWorkOccurrence(schedule, now);
      if (latest === undefined || latest <= after) return undefined;
      return {
        key,
        parsed,
        nominalAt: latest,
        wakeAt: Math.max(now, this.retryAt.get(schedule.scheduleId) ?? now),
        action: schedule.catchUp === 'skip' ? 'skip' : 'run',
      };
    }
    return {
      key,
      parsed,
      nominalAt: next,
      wakeAt: Math.max(next, this.retryAt.get(schedule.scheduleId) ?? next),
      action: 'run',
    };
  }

  private armTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.disposed) return;
    const now = this.secondsNow();
    const nextAt = Math.min(
      this.heap.peek()?.wakeAt ?? Number.POSITIVE_INFINITY,
      this.nextResyncAt || Number.POSITIVE_INFINITY,
    );
    if (!Number.isFinite(nextAt)) return;
    const delay = Math.max(0, Math.min(2_147_000_000, (nextAt - now) * 1_000));
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.enqueueWake(async () => this.onWake());
    }, delay);
    this.timer.unref?.();
  }

  private async onWake(): Promise<void> {
    if (this.disposed) return;
    await this.flushPendingReceipts();
    const due: HeapEntry[] = [];
    while (due.length < MAX_CALENDAR_DUE_PER_WAKE) {
      const entry = this.heap.peek();
      if (!entry || entry.wakeAt > this.secondsNow()) break;
      this.heap.pop();
      due.push(entry);
    }
    // Submit independently due schedules together. SessionScheduler remains
    // the final per-Room/process capacity queue and keeps each turn background.
    const results = await Promise.allSettled(due.map((entry) => this.process(entry)));
    for (const [index, entry] of due.entries()) {
      const result = results[index]!;
      if (result.status === 'rejected') {
        console.error(
          `[work-calendar] occurrence ${entry.parsed.value.scheduleId} failed:`,
          result.reason,
        );
        this.retryLater(entry.parsed.value.scheduleId);
      }
      const current = this.schedules.get(entry.key);
      if (current && current.value.revision === entry.parsed.value.revision) {
        const next = this.entryFor(entry.key, current, this.secondsNow());
        if (next) this.heap.push(next);
      }
    }
    if (this.secondsNow() >= this.nextResyncAt) {
      await this.refreshSafely();
      return;
    }
    this.armTimer();
  }

  private async process(entry: HeapEntry): Promise<NostrEvent | undefined> {
    const schedule = entry.parsed.value;
    const runId = deterministicScheduleRunId(
      schedule.scheduleId,
      schedule.revision,
      entry.nominalAt,
    );
    if (entry.action === 'skip') {
      return this.finish(
        entry.parsed,
        runId,
        entry.nominalAt,
        'skipped',
        false,
        'catch-up-skipped',
      );
    }

    const authority = await this.dependencies.authorize(entry.parsed);
    if (!authority.authorized) {
      if (authority.terminal) await this.pause(entry.parsed, authority.reason, true);
      else this.retryLater(schedule.scheduleId);
      return undefined;
    }
    const artifacts = await this.validateArtifacts(entry.parsed);
    if (!artifacts.authorized) {
      if (artifacts.terminal) await this.pause(entry.parsed, artifacts.reason, true);
      else this.retryLater(schedule.scheduleId);
      return undefined;
    }
    if (this.secondsNow() > schedule.expiresAt) {
      return this.finish(
        entry.parsed,
        runId,
        entry.nominalAt,
        'skipped',
        false,
        'schedule-expired',
      );
    }
    const budgetReason = this.budgetRefusal(schedule);
    if (budgetReason) {
      return this.finish(entry.parsed, runId, entry.nominalAt, 'skipped', false, budgetReason);
    }
    const missionAction = schedule.mission
      ? await this.dependencies.missionAction?.(entry.parsed, entry.nominalAt)
      : undefined;
    if (schedule.mission && !missionAction) {
      await this.pause(entry.parsed, 'mission-grant-invalid', true);
      return undefined;
    }

    // Receipts are best-effort observability only. A relay failure never gates
    // execution and receipts are never replayed as calendar state.
    const queued = await this.publishReceipt(schedule, runId, entry.nominalAt, 'queued');

    let activated = false;
    try {
      await this.dependencies.dispatch(
        {
          trigger: 'schedule',
          priority: 'background',
          workspaceId: schedule.workspaceId,
          roomId: schedule.roomId,
          agentPubkey: schedule.agentPubkey,
          targetAgentPubkey: schedule.targetAgentPubkey ?? schedule.agentPubkey,
          principalPubkey: schedule.principalPubkey,
          scheduleId: schedule.scheduleId,
          scheduleRevision: schedule.revision,
          scheduleRevisionDigest: workScheduleRevisionDigest(schedule),
          scheduleRunId: runId,
          nominalAt: entry.nominalAt,
          prompt: schedule.prompt,
          artifactRefs: schedule.artifactRefs ?? [],
          reservedTokens: schedule.perRunReservedTokens,
          maxRuns: schedule.maxRuns,
          dailyReservedTokens: schedule.dailyReservedTokens,
          queuedEvent: queued,
          execution:
            schedule.execution && schedule.execution.mode !== 'model'
              ? {
                  mode: 'script',
                  script: schedule.execution.script,
                  scriptSha256: schedule.execution.scriptSha256,
                  timeoutSeconds: schedule.execution.timeoutSeconds,
                }
              : { mode: 'model' },
          ...(missionAction ? { missionAction } : {}),
          ...(schedule.mission ? { mission: schedule.mission } : {}),
        },
        async () => {
          if (activated) return;
          const currentAuthority = await this.dependencies.authorize(entry.parsed);
          if (!currentAuthority.authorized) {
            throw new ScheduleActivationRefusedError(
              currentAuthority.terminal,
              currentAuthority.reason,
            );
          }
          const currentArtifacts = await this.validateArtifacts(entry.parsed);
          if (!currentArtifacts.authorized) {
            throw new ScheduleActivationRefusedError(
              currentArtifacts.terminal,
              currentArtifacts.reason,
            );
          }
          if (this.secondsNow() > schedule.expiresAt) {
            throw new ScheduleActivationRefusedError(true, 'schedule-expired');
          }
          const currentBudgetReason = this.budgetRefusal(schedule);
          if (currentBudgetReason) {
            throw new ScheduleActivationRefusedError(true, currentBudgetReason);
          }
          activated = true;
          await this.publishReceipt(schedule, runId, entry.nominalAt, 'working');
        },
      );
      if (!activated) {
        throw new Error('scheduled dispatcher bypassed the activation authority check');
      }
    } catch (error) {
      if (error instanceof ScheduleActivationRefusedError) {
        if (
          ['schedule-expired', 'max-runs-exhausted', 'daily-budget-exhausted'].includes(
            error.reason,
          )
        )
          return this.finish(entry.parsed, runId, entry.nominalAt, 'skipped', false, error.reason);
        else if (error.terminal) await this.pause(entry.parsed, error.reason, true);
        else this.retryLater(schedule.scheduleId);
        return undefined;
      }
      const reason =
        String(error instanceof Error ? error.message : error)
          .replace(/[\r\n]+/g, ' ')
          .slice(0, 600) || 'scheduled-turn-failed';
      return this.finish(entry.parsed, runId, entry.nominalAt, 'failed', activated, reason);
    }
    // Keep the last-execution write outside the model/dispatcher catch: a
    // durable-store failure here is a daemon crash condition, not a model
    // failure. On restart the occurrence may run again by design.
    return this.finish(entry.parsed, runId, entry.nominalAt, 'complete', true);
  }

  private budgetRefusal(schedule: WorkScheduleV1): string | undefined {
    const state = this.states.get(schedule.scheduleId);
    if (!state || state.runCount >= schedule.maxRuns) return 'max-runs-exhausted';
    const day = dayUtc(this.secondsNow());
    const daily = state.budgetDay === day ? state.dailyReservedTokens : 0;
    return daily + schedule.perRunReservedTokens > schedule.dailyReservedTokens
      ? 'daily-budget-exhausted'
      : undefined;
  }

  private async finish(
    parsed: ParsedWorkSchedule,
    runId: string,
    nominalAt: number,
    status: 'complete' | 'failed' | 'skipped',
    activated: boolean,
    reason?: string,
  ): Promise<NostrEvent | undefined> {
    const schedule = parsed.value;
    const current = this.states.get(schedule.scheduleId);
    if (!current) return;
    const now = this.secondsNow();
    const budgetDay = dayUtc(now);
    const failures =
      status === 'failed'
        ? current.consecutiveFailures + 1
        : status === 'complete'
          ? 0
          : current.consecutiveFailures;
    const paused = failures >= schedule.maxConsecutiveFailures;
    const next: WorkScheduleRuntimeState = {
      ...current,
      revision: schedule.revision,
      lastExecutionAt: nominalAt,
      runCount: current.runCount + (activated ? 1 : 0),
      budgetDay,
      dailyReservedTokens:
        (current.budgetDay === budgetDay ? current.dailyReservedTokens : 0) +
        (activated ? schedule.perRunReservedTokens : 0),
      consecutiveFailures: failures,
      status: paused ? 'paused' : 'active',
      ...(paused ? { pauseReason: 'max-consecutive-failures' } : {}),
    };
    if (!paused) delete next.pauseReason;

    // This write deliberately follows the model turn. A crash before it may
    // repeat the occurrence; that is the calendar's documented best-effort
    // behavior. Failure pause state, however, is durable before its card.
    const receipt = this.buildReceipt(schedule, runId, nominalAt, status, reason);
    await this.dependencies.store.putWithReceipt(next, receipt);
    this.states.set(next.scheduleId, cloneState(next));
    this.retryAt.delete(schedule.scheduleId);
    await this.publishReservedReceipt(receipt, status, runId);
    await this.publishProjection(schedule, next);
    if (paused) {
      await this.publishBestEffort(
        buildWorkSchedulePauseCard(this.dependencies.identity, schedule, now),
        `pause card for ${schedule.scheduleId}`,
      );
    }
    return receipt;
  }

  private async publishReceipt(
    schedule: WorkScheduleV1,
    runId: string,
    nominalAt: number,
    status: ScheduledTurnStatus,
    reason?: string,
  ): Promise<NostrEvent> {
    const event = this.buildReceipt(schedule, runId, nominalAt, status, reason);
    if (status === 'complete' || status === 'failed' || status === 'skipped') {
      await this.dependencies.store.reserveReceipt(event);
      await this.publishReservedReceipt(event, status, runId);
    } else {
      await this.publishBestEffort(event, `${status} receipt for ${runId}`);
    }
    return event;
  }

  private buildReceipt(
    schedule: WorkScheduleV1,
    runId: string,
    nominalAt: number,
    status: ScheduledTurnStatus,
    reason?: string,
  ): NostrEvent {
    return buildScheduledTurnReceipt(this.dependencies.identity, {
      version: 1,
      workspaceId: schedule.workspaceId,
      roomId: schedule.roomId,
      agentPubkey: schedule.agentPubkey,
      principalPubkey: schedule.principalPubkey,
      scheduleId: schedule.scheduleId,
      revision: schedule.revision,
      runId,
      nominalAt,
      status,
      at: this.secondsNow(),
      reservedTokens: schedule.perRunReservedTokens,
      ...(reason ? { reason } : {}),
    });
  }

  private async publishReservedReceipt(
    event: NostrEvent,
    status: ScheduledTurnStatus,
    runId: string,
  ): Promise<void> {
    try {
      await this.dependencies.publish(event);
      await this.dependencies.store.markReceiptDelivered(event.id);
    } catch (error) {
      console.error(`[work-calendar] ${status} receipt for ${runId} publish failed:`, error);
    }
  }

  private async flushPendingReceipts(): Promise<void> {
    for (const event of await this.dependencies.store.pendingReceipts()) {
      try {
        await this.dependencies.publish(event);
        await this.dependencies.store.markReceiptDelivered(event.id);
      } catch (error) {
        console.error(`[work-calendar] pending receipt ${event.id} publish failed:`, error);
      }
    }
  }

  private validateArtifacts(parsed: ParsedWorkSchedule): Promise<ScheduleAuthorityResult> {
    return this.dependencies.validateArtifacts?.(parsed) ?? Promise.resolve({ authorized: true });
  }

  private retryLater(scheduleId: string): void {
    this.retryAt.set(
      scheduleId,
      this.secondsNow() + (this.dependencies.retrySeconds ?? DEFAULT_CALENDAR_RETRY_SECONDS),
    );
  }

  private async persist(state: WorkScheduleRuntimeState): Promise<void> {
    await this.dependencies.store.put(state);
    this.states.set(state.scheduleId, cloneState(state));
  }

  private async pause(
    parsed: ParsedWorkSchedule,
    reason: string,
    publishCard: boolean,
  ): Promise<void> {
    const schedule = parsed.value;
    const current = this.states.get(schedule.scheduleId) ?? {
      scheduleId: schedule.scheduleId,
      principalPubkey: schedule.principalPubkey,
      revision: schedule.revision,
      runCount: 0,
      dailyReservedTokens: 0,
      consecutiveFailures: 0,
      status: 'active' as const,
    };
    const paused: WorkScheduleRuntimeState = {
      ...current,
      revision: schedule.revision,
      scheduleEvent: parsed.event,
      status: 'paused',
      pauseReason: reason,
    };
    // Authority/failure pause is durable before any best-effort relay card.
    await this.persist(paused);
    this.retryAt.delete(schedule.scheduleId);
    await this.publishProjection(schedule, paused);
    if (publishCard) {
      await this.publishBestEffort(
        buildWorkSchedulePauseCard(this.dependencies.identity, schedule, this.secondsNow(), reason),
        `pause card for ${schedule.scheduleId}`,
      );
    }
  }

  private async publishProjection(
    schedule: WorkScheduleV1,
    state: WorkScheduleRuntimeState,
  ): Promise<void> {
    const nextAt =
      state.status === 'active'
        ? nextWorkOccurrence(schedule, state.lastExecutionAt ?? schedule.startsAt - 1)
        : undefined;
    await this.publishBestEffort(
      buildWorkScheduleProjection(this.dependencies.identity, {
        version: 1,
        type: 'runtime',
        workspaceId: schedule.workspaceId,
        roomId: schedule.roomId,
        agentPubkey: schedule.agentPubkey,
        principalPubkey: schedule.principalPubkey,
        scheduleId: schedule.scheduleId,
        revision: schedule.revision,
        status: state.status,
        ...(nextAt !== undefined ? { nextAt } : {}),
        ...(state.lastExecutionAt !== undefined ? { lastExecutionAt: state.lastExecutionAt } : {}),
        runCount: state.runCount,
        ...(state.budgetDay ? { budgetDay: state.budgetDay } : {}),
        dailyReservedTokens: state.dailyReservedTokens,
        consecutiveFailures: state.consecutiveFailures,
        ...(state.pauseReason ? { pauseReason: state.pauseReason } : {}),
        updatedAt: this.secondsNow(),
      }),
      `runtime projection for ${schedule.scheduleId}`,
    );
  }

  private async publishBestEffort(event: NostrEvent, label: string): Promise<void> {
    try {
      await this.dependencies.publish(event);
    } catch (error) {
      console.error(`[work-calendar] ${label} publish failed:`, error);
    }
  }
}
