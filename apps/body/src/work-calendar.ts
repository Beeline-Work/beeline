/**
 * Durable per-agent work calendar.
 *
 * This module decides whether an authorized recurring work item is due. It
 * never owns ACP process capacity: admitted work is handed to the ordinary
 * Room dispatcher with `trigger: 'schedule'` and background priority.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { CronExpression, CronExpressionParser } from 'cron-parser';
import { signEvent, verifyEvent, type NostrEvent } from '@beeline/nostr';
import {
  MAX_MISSION_RESERVED_TOKENS,
  type ArtifactRevisionRef,
  type Identity,
  type PermissionConcreteAction,
} from '@beeline/buzz-client';

export const WORK_SCHEDULE_KIND = 30078;
export const WORK_SCHEDULE_TAG = 'buzz-work-schedule';
export const WORK_SCHEDULE_RUNTIME_TAG = 'buzz-work-schedule-runtime';
export const SCHEDULED_TURN_TAG = 'buzz-scheduled-turn';
export const WORK_SCHEDULE_PAUSED_TAG = 'buzz-work-schedule-paused';
export const WORK_SCHEDULE_VERSION = 1 as const;
export const DEFAULT_CALENDAR_RESYNC_SECONDS = 60;
export const DEFAULT_CALENDAR_RETRY_SECONDS = 5;
export const MAX_CALENDAR_DUE_PER_WAKE = 16;
export const MIN_MODEL_SCHEDULE_CADENCE_SECONDS = 15 * 60;
export const MIN_SCRIPT_SCHEDULE_CADENCE_SECONDS = 60;
export const MAX_MISSION_SCRIPT_CONSECUTIVE_FAILURES = 3;

const HEX_64 = /^[0-9a-f]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,255}$/;
const LOCAL_TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const MAX_PROMPT_CHARS = 32_000;
const MAX_SCRIPT_CHARS = 32_000;
const MAX_ARTIFACT_REFS = 128;
const MAX_RUNS = 1_000_000;
const MAX_RESERVED_TOKENS = MAX_MISSION_RESERVED_TOKENS;
const MAX_INTERVAL_SECONDS = 366 * 24 * 60 * 60;

export type WorkScheduleExecution =
  | { mode: 'model' }
  | {
      /** Omission is the wire-level default for new mission schedules. */
      mode?: 'script';
      script: string;
      scriptSha256: string;
      timeoutSeconds: number;
    };

export interface WorkScheduleMission {
  missionId: string;
  grantEventId: string;
  controllerAgentPubkey: string;
  repository: { key: string; targetBranch: string };
}

export interface WorkScheduleV1 {
  version: 1;
  scheduleId: string;
  revision: number;
  workspaceId: string;
  roomId: string;
  agentPubkey: string;
  /** Mission calendar owner remains the CoS; this names the delegated turn recipient. */
  targetAgentPubkey?: string;
  principalPubkey: string;
  prompt: string;
  /** Legacy v1 records omit this and retain their pre-M3 model-turn behavior. */
  execution?: WorkScheduleExecution;
  mission?: WorkScheduleMission;
  artifactRefs?: ArtifactRevisionRef[];
  cadence:
    | { type: 'cron'; expression: string; timezone: string }
    | { type: 'daily'; localTime: string; timezone: string }
    | { type: 'interval'; everySeconds: number; anchorAt: number };
  startsAt: number;
  expiresAt: number;
  maxRuns: number;
  perRunReservedTokens: number;
  dailyReservedTokens: number;
  catchUp: 'skip' | 'latest-one';
  maxConsecutiveFailures: number;
  status: 'active' | 'paused';
  permissionGrantEventId?: string;
}

export interface ParsedWorkSchedule {
  event: NostrEvent;
  value: WorkScheduleV1;
  nextAt: number | undefined;
}

export type ScheduledTurnStatus = 'queued' | 'working' | 'complete' | 'failed' | 'skipped';

export interface ScheduledTurnReceiptV1 {
  version: 1;
  workspaceId: string;
  roomId: string;
  agentPubkey: string;
  principalPubkey: string;
  scheduleId: string;
  revision: number;
  runId: string;
  nominalAt: number;
  status: ScheduledTurnStatus;
  at: number;
  reservedTokens: number;
  reason?: string;
}

export interface ParsedScheduledTurnReceipt {
  event: NostrEvent;
  value: ScheduledTurnReceiptV1;
}

export interface WorkScheduleProjectionV1 {
  version: 1;
  type: 'runtime';
  workspaceId: string;
  roomId: string;
  agentPubkey: string;
  principalPubkey: string;
  scheduleId: string;
  revision: number;
  status: 'active' | 'paused';
  nextAt?: number;
  lastExecutionAt?: number;
  runCount: number;
  budgetDay?: string;
  dailyReservedTokens: number;
  consecutiveFailures: number;
  pauseReason?: string;
  updatedAt: number;
}

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

export interface WorkScheduleRuntimeState {
  scheduleId: string;
  principalPubkey: string;
  revision: number;
  lastExecutionAt?: number;
  runCount: number;
  budgetDay?: string;
  dailyReservedTokens: number;
  consecutiveFailures: number;
  status: 'active' | 'paused';
  pauseReason?: string;
}

export interface WorkCalendarStore {
  load(): Promise<void>;
  states(): Promise<WorkScheduleRuntimeState[]>;
  put(state: WorkScheduleRuntimeState): Promise<void>;
  reserveReceipt(event: NostrEvent): Promise<void>;
  pendingReceipts(): Promise<NostrEvent[]>;
  markReceiptDelivered(eventId: string): Promise<void>;
}

interface DurableCalendarData {
  version: 3;
  schedules: Record<string, WorkScheduleRuntimeState>;
  pendingReceipts: Record<string, NostrEvent>;
}

function cloneState(state: WorkScheduleRuntimeState): WorkScheduleRuntimeState {
  return structuredClone(state);
}

/** Atomic local state for best-effort execution progress and failure pausing. */
export class DurableWorkCalendarState implements WorkCalendarStore {
  private data: DurableCalendarData = { version: 3, schedules: {}, pendingReceipts: {} };
  private loaded = false;
  private saveTail: Promise<void> = Promise.resolve();

  constructor(private readonly path: string) {}

  async load(): Promise<void> {
    if (this.loaded) return;
    try {
      const parsed = JSON.parse(await readFile(this.path, 'utf8')) as {
        version?: unknown;
        schedules?: unknown;
        pendingReceipts?: unknown;
      };
      // P2 was not shipped before the execution model was simplified. Drop
      // its development-only reservation/outbox journal as a lost store; the
      // best-effort contract intentionally reconstructs from schedule config.
      if (parsed.version === 1) {
        const migrated: DurableCalendarData = {
          version: 3,
          schedules: {},
          pendingReceipts: {},
        };
        this.loaded = true;
        await this.save(migrated);
        this.data = migrated;
        return;
      }
      const rawSchedules = object(parsed.schedules);
      if ((parsed.version !== 2 && parsed.version !== 3) || !rawSchedules) {
        throw new Error(`unsupported durable work calendar state at ${this.path}`);
      }
      const schedules: Record<string, WorkScheduleRuntimeState> = {};
      for (const [key, value] of Object.entries(rawSchedules)) {
        const state = parseRuntimeState(value);
        if (!state || key !== state.scheduleId) {
          throw new Error(`invalid durable work calendar state at ${this.path}`);
        }
        schedules[key] = state;
      }
      const pendingReceipts: Record<string, NostrEvent> = {};
      if (parsed.version === 3) {
        const rawReceipts = object(parsed.pendingReceipts);
        if (!rawReceipts) throw new Error(`invalid durable work calendar state at ${this.path}`);
        for (const [eventId, candidate] of Object.entries(rawReceipts)) {
          const event = candidate as NostrEvent;
          if (event?.id !== eventId || !parseScheduledTurnReceipt(event)) {
            throw new Error(`invalid durable work calendar receipt at ${this.path}`);
          }
          pendingReceipts[eventId] = event;
        }
      }
      this.data = { version: 3, schedules, pendingReceipts };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    this.loaded = true;
  }

  async states(): Promise<WorkScheduleRuntimeState[]> {
    await this.load();
    return Object.values(this.data.schedules).map(cloneState);
  }

  async put(state: WorkScheduleRuntimeState): Promise<void> {
    await this.load();
    const parsed = parseRuntimeState(state);
    if (!parsed) throw new Error('invalid work calendar runtime state');
    await this.enqueueSave(async () => {
      const next: DurableCalendarData = {
        version: 3,
        schedules: {
          ...this.data.schedules,
          [parsed.scheduleId]: cloneState(parsed),
        },
        pendingReceipts: { ...this.data.pendingReceipts },
      };
      await this.write(next);
      this.data = next;
    });
  }

  async reserveReceipt(event: NostrEvent): Promise<void> {
    await this.load();
    if (!parseScheduledTurnReceipt(event)) throw new Error('invalid scheduled receipt outbox event');
    await this.enqueueSave(async () => {
      const next: DurableCalendarData = {
        ...this.data,
        pendingReceipts: { ...this.data.pendingReceipts, [event.id]: event },
      };
      await this.write(next);
      this.data = next;
    });
  }

  async pendingReceipts(): Promise<NostrEvent[]> {
    await this.load();
    return Object.values(this.data.pendingReceipts).sort(
      (left, right) => left.created_at - right.created_at || left.id.localeCompare(right.id),
    );
  }

  async markReceiptDelivered(eventId: string): Promise<void> {
    await this.load();
    if (!this.data.pendingReceipts[eventId]) return;
    await this.enqueueSave(async () => {
      const pendingReceipts = { ...this.data.pendingReceipts };
      delete pendingReceipts[eventId];
      const next: DurableCalendarData = { ...this.data, pendingReceipts };
      await this.write(next);
      this.data = next;
    });
  }

  private save(data: DurableCalendarData): Promise<void> {
    return this.enqueueSave(async () => {
      await this.write(data);
    });
  }

  private enqueueSave(task: () => Promise<void>): Promise<void> {
    const run = this.saveTail.catch(() => undefined).then(task);
    this.saveTail = run.catch(() => undefined);
    return run;
  }

  private async write(data: DurableCalendarData): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = resolve(dirname(this.path), `work-calendar-${process.pid}.tmp`);
    await writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, this.path);
  }
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function integer(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): number | undefined {
  return Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max
    ? (value as number)
    : undefined;
}

function nonEmpty(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  return text && text.length <= max ? text : undefined;
}

function parseRuntimeState(value: unknown): WorkScheduleRuntimeState | undefined {
  const input = object(value);
  if (!input) return undefined;
  const scheduleId = nonEmpty(input?.scheduleId, 256);
  const principalPubkey =
    typeof input?.principalPubkey === 'string' && HEX_64.test(input.principalPubkey)
      ? input.principalPubkey
      : undefined;
  const revision = integer(input?.revision, 1);
  const lastExecutionAt =
    input?.lastExecutionAt === undefined ? undefined : integer(input.lastExecutionAt);
  const runCount = integer(input?.runCount, 0, MAX_RUNS);
  const dailyReservedTokens = integer(input?.dailyReservedTokens, 0, MAX_RESERVED_TOKENS);
  const consecutiveFailures = integer(input?.consecutiveFailures, 0, MAX_RUNS);
  const budgetDay =
    input?.budgetDay === undefined || /^\d{4}-\d{2}-\d{2}$/.test(String(input.budgetDay))
      ? (input?.budgetDay as string | undefined)
      : undefined;
  const pauseReason =
    input?.pauseReason === undefined ? undefined : nonEmpty(input.pauseReason, 600);
  if (
    !scheduleId ||
    !SAFE_ID.test(scheduleId) ||
    !principalPubkey ||
    revision === undefined ||
    (input.lastExecutionAt !== undefined && lastExecutionAt === undefined) ||
    runCount === undefined ||
    dailyReservedTokens === undefined ||
    consecutiveFailures === undefined ||
    (input.budgetDay !== undefined && budgetDay === undefined) ||
    !['active', 'paused'].includes(String(input.status)) ||
    (input.pauseReason !== undefined && !pauseReason)
  ) {
    return undefined;
  }
  return {
    scheduleId,
    principalPubkey,
    revision,
    ...(lastExecutionAt !== undefined ? { lastExecutionAt } : {}),
    runCount,
    ...(budgetDay ? { budgetDay } : {}),
    dailyReservedTokens,
    consecutiveFailures,
    status: input.status as WorkScheduleRuntimeState['status'],
    ...(pauseReason ? { pauseReason } : {}),
  };
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function uniqueTag(event: NostrEvent, name: string): string | undefined {
  const matches = event.tags.filter((tag) => tag[0] === name);
  return matches.length === 1 ? matches[0]?.[1] : undefined;
}

function parseArtifactRef(value: unknown): ArtifactRevisionRef | undefined {
  const input = object(value);
  const artifactId = nonEmpty(input?.artifactId, 256);
  const revision = integer(input?.revision, 1);
  const eventId =
    typeof input?.eventId === 'string' && HEX_64.test(input.eventId) ? input.eventId : undefined;
  const digest =
    typeof input?.sha256 === 'string' && HEX_64.test(input.sha256) ? input.sha256 : undefined;
  return artifactId && revision !== undefined && eventId && digest
    ? { artifactId, revision, eventId, sha256: digest }
    : undefined;
}

function parseTimezone(value: unknown): string | undefined {
  const timezone = nonEmpty(value, 128);
  if (!timezone) return undefined;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(0);
    return timezone;
  } catch {
    return undefined;
  }
}

function parseCadence(value: unknown): WorkScheduleV1['cadence'] | undefined {
  const input = object(value);
  if (input?.type === 'interval') {
    const everySeconds = integer(input.everySeconds, 1, MAX_INTERVAL_SECONDS);
    const anchorAt = integer(input.anchorAt);
    return everySeconds !== undefined && anchorAt !== undefined
      ? { type: 'interval', everySeconds, anchorAt }
      : undefined;
  }
  const timezone = parseTimezone(input?.timezone);
  if (!timezone) return undefined;
  if (input?.type === 'daily') {
    return typeof input.localTime === 'string' && LOCAL_TIME.test(input.localTime)
      ? { type: 'daily', localTime: input.localTime, timezone }
      : undefined;
  }
  if (input?.type === 'cron') {
    const expression = nonEmpty(input.expression, 512);
    if (!expression) return undefined;
    try {
      CronExpressionParser.parse(expression, { currentDate: new Date(0), tz: timezone });
      return { type: 'cron', expression, timezone };
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function parseExecution(value: unknown): WorkScheduleExecution | undefined {
  const input = object(value);
  if (!input) return undefined;
  if (input.mode === 'model') return { mode: 'model' };
  if (input.mode !== undefined && input.mode !== 'script') return undefined;
  const script = input.script;
  const scriptSha256 = input.scriptSha256;
  const timeoutSeconds = integer(input.timeoutSeconds, 1, 3_600);
  if (
    typeof script !== 'string' ||
    !script.trim() ||
    script.length > MAX_SCRIPT_CHARS ||
    typeof scriptSha256 !== 'string' ||
    !HEX_64.test(scriptSha256) ||
    createHash('sha256').update(script).digest('hex') !== scriptSha256 ||
    timeoutSeconds === undefined
  ) {
    return undefined;
  }
  return { mode: 'script', script, scriptSha256, timeoutSeconds };
}

function parseMission(value: unknown): WorkScheduleMission | undefined {
  const input = object(value);
  const repository = object(input?.repository);
  const missionId = nonEmpty(input?.missionId, 256);
  const repositoryKey = nonEmpty(repository?.key, 256);
  const targetBranch = nonEmpty(repository?.targetBranch, 256);
  if (
    !missionId ||
    !SAFE_ID.test(missionId) ||
    typeof input?.grantEventId !== 'string' ||
    !HEX_64.test(input.grantEventId) ||
    typeof input.controllerAgentPubkey !== 'string' ||
    !HEX_64.test(input.controllerAgentPubkey) ||
    !repositoryKey ||
    !SAFE_ID.test(repositoryKey) ||
    !targetBranch ||
    !SAFE_ID.test(targetBranch)
  ) {
    return undefined;
  }
  return {
    missionId,
    grantEventId: input.grantEventId,
    controllerAgentPubkey: input.controllerAgentPubkey,
    repository: { key: repositoryKey, targetBranch },
  };
}

export function workScheduleExecutionMode(schedule: WorkScheduleV1): 'script' | 'model' {
  if (!schedule.execution) return 'model';
  return schedule.execution.mode === 'model' ? 'model' : 'script';
}

function minimumCadenceSeconds(schedule: WorkScheduleV1): number {
  if (schedule.cadence.type === 'interval') return schedule.cadence.everySeconds;
  if (schedule.cadence.type === 'daily') return 24 * 60 * 60;
  const expression = CronExpressionParser.parse(schedule.cadence.expression, {
    currentDate: new Date(0),
    tz: schedule.cadence.timezone,
  });
  const times: number[] = [];
  for (const hour of expression.fields.hour.values) {
    for (const minute of expression.fields.minute.values) {
      for (const second of expression.fields.second.values) {
        times.push(hour * 3_600 + minute * 60 + second);
      }
    }
  }
  times.sort((left, right) => left - right);
  if (times.length === 0) return 0;
  let minimum = 24 * 60 * 60;
  for (let index = 1; index < times.length; index += 1) {
    minimum = Math.min(minimum, times[index]! - times[index - 1]!);
  }
  return Math.min(minimum, 24 * 60 * 60 - times.at(-1)! + times[0]!);
}

export function workScheduleCadenceFloorSeconds(schedule: WorkScheduleV1): number {
  return workScheduleExecutionMode(schedule) === 'script'
    ? MIN_SCRIPT_SCHEDULE_CADENCE_SECONDS
    : MIN_MODEL_SCHEDULE_CADENCE_SECONDS;
}

export function parseWorkScheduleValue(value: unknown): WorkScheduleV1 | undefined {
  const input = object(value);
  if (!input || input.version !== 1) return undefined;
  const scheduleId = nonEmpty(input.scheduleId, 256);
  const revision = integer(input.revision, 1);
  const workspaceId = nonEmpty(input.workspaceId, 256);
  const roomId = nonEmpty(input.roomId, 256);
  const prompt = nonEmpty(input.prompt, MAX_PROMPT_CHARS);
  const execution = input.execution === undefined ? undefined : parseExecution(input.execution);
  const mission = input.mission === undefined ? undefined : parseMission(input.mission);
  const cadence = parseCadence(input.cadence);
  const startsAt = integer(input.startsAt);
  const expiresAt = integer(input.expiresAt);
  const maxRuns = integer(input.maxRuns, 1, MAX_RUNS);
  const perRunReservedTokens = integer(input.perRunReservedTokens, 0, MAX_RESERVED_TOKENS);
  const dailyReservedTokens = integer(input.dailyReservedTokens, 0, MAX_RESERVED_TOKENS);
  const maxConsecutiveFailures = integer(input.maxConsecutiveFailures, 1, MAX_RUNS);
  if (
    !scheduleId ||
    !SAFE_ID.test(scheduleId) ||
    !workspaceId ||
    !SAFE_ID.test(workspaceId) ||
    !roomId ||
    !SAFE_ID.test(roomId) ||
    !prompt ||
    (input.execution !== undefined && !execution) ||
    (input.mission !== undefined && !mission) ||
    (mission !== undefined && execution === undefined) ||
    (execution !== undefined && execution.mode !== 'model' && mission === undefined) ||
    !cadence ||
    revision === undefined ||
    typeof input.agentPubkey !== 'string' ||
    !HEX_64.test(input.agentPubkey) ||
    (input.targetAgentPubkey !== undefined &&
      (typeof input.targetAgentPubkey !== 'string' || !HEX_64.test(input.targetAgentPubkey))) ||
    typeof input.principalPubkey !== 'string' ||
    !HEX_64.test(input.principalPubkey) ||
    startsAt === undefined ||
    expiresAt === undefined ||
    expiresAt <= startsAt ||
    maxRuns === undefined ||
    perRunReservedTokens === undefined ||
    dailyReservedTokens === undefined ||
    perRunReservedTokens > dailyReservedTokens ||
    maxConsecutiveFailures === undefined ||
    !['skip', 'latest-one'].includes(String(input.catchUp)) ||
    !['active', 'paused'].includes(String(input.status))
  )
    return undefined;
  const targetAgentPubkey =
    typeof input.targetAgentPubkey === 'string' ? input.targetAgentPubkey : input.agentPubkey;
  if (
    mission &&
    (input.agentPubkey !== mission.controllerAgentPubkey ||
      input.targetAgentPubkey === undefined ||
      (workScheduleExecutionMode({
        ...(input as unknown as WorkScheduleV1),
        ...(execution ? { execution } : {}),
      }) === 'script' &&
        maxConsecutiveFailures! > MAX_MISSION_SCRIPT_CONSECUTIVE_FAILURES))
  ) {
    return undefined;
  }
  const candidateForCadence = {
    ...(input as unknown as WorkScheduleV1),
    ...(execution ? { execution } : {}),
    cadence,
  };
  // Legacy records omitted `execution` and keep their pre-M3 cadence. Every
  // explicit M3 record is checked by the daemon parser before it can enter the heap.
  if (
    execution &&
    minimumCadenceSeconds(candidateForCadence) <
      workScheduleCadenceFloorSeconds(candidateForCadence)
  ) {
    return undefined;
  }
  let artifactRefs: ArtifactRevisionRef[] | undefined;
  if (input.artifactRefs !== undefined) {
    if (!Array.isArray(input.artifactRefs) || input.artifactRefs.length > MAX_ARTIFACT_REFS)
      return undefined;
    const parsed = input.artifactRefs.map(parseArtifactRef);
    if (parsed.some((item) => !item)) return undefined;
    artifactRefs = parsed as ArtifactRevisionRef[];
  }
  const permissionGrantEventId = input.permissionGrantEventId;
  if (
    permissionGrantEventId !== undefined &&
    (typeof permissionGrantEventId !== 'string' || !HEX_64.test(permissionGrantEventId))
  ) {
    return undefined;
  }
  return {
    version: 1,
    scheduleId,
    revision,
    workspaceId,
    roomId,
    agentPubkey: input.agentPubkey,
    ...(input.targetAgentPubkey !== undefined ? { targetAgentPubkey } : {}),
    principalPubkey: input.principalPubkey,
    prompt,
    ...(execution ? { execution } : {}),
    ...(mission ? { mission } : {}),
    ...(artifactRefs ? { artifactRefs } : {}),
    cadence,
    startsAt,
    expiresAt,
    maxRuns,
    perRunReservedTokens,
    dailyReservedTokens,
    catchUp: input.catchUp as WorkScheduleV1['catchUp'],
    maxConsecutiveFailures,
    status: input.status as WorkScheduleV1['status'],
    ...(permissionGrantEventId ? { permissionGrantEventId } : {}),
  };
}

export function workScheduleKey(
  schedule: Pick<WorkScheduleV1, 'workspaceId' | 'agentPubkey' | 'scheduleId'>,
): string {
  if (
    !SAFE_ID.test(schedule.workspaceId) ||
    !HEX_64.test(schedule.agentPubkey) ||
    !SAFE_ID.test(schedule.scheduleId)
  ) {
    throw new Error('invalid work schedule key');
  }
  return `${WORK_SCHEDULE_TAG}:${schedule.workspaceId}:${schedule.agentPubkey}:${schedule.scheduleId}`;
}

/** Digest used by P1 `schedule.change`; the later grant id is excluded to avoid a circular signature. */
export function workScheduleRevisionDigest(schedule: WorkScheduleV1): string {
  const { permissionGrantEventId: _grant, ...revision } = schedule;
  const digestible = revision.mission
    ? {
        ...revision,
        mission: {
          missionId: revision.mission.missionId,
          controllerAgentPubkey: revision.mission.controllerAgentPubkey,
          repository: revision.mission.repository,
        },
      }
    : revision;
  return createHash('sha256').update(stable(digestible)).digest('hex');
}

function dailyExpression(localTime: string): string {
  const [hour, minute] = localTime.split(':');
  return `${Number(minute)} ${Number(hour)} * * *`;
}

function cadenceExpression(
  schedule: WorkScheduleV1,
): { expression: string; timezone: string } | undefined {
  if (schedule.cadence.type === 'interval') return undefined;
  return schedule.cadence.type === 'daily'
    ? {
        expression: dailyExpression(schedule.cadence.localTime),
        timezone: schedule.cadence.timezone,
      }
    : { expression: schedule.cadence.expression, timezone: schedule.cadence.timezone };
}

function localParts(
  atMs: number,
  timezone: string,
): { year: number; month: number; day: number; date: string; minute: number; second: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(atMs);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value);
  const year = get('year');
  const month = get('month');
  const day = get('day');
  return {
    year,
    month,
    day,
    date: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
    minute: get('hour') * 60 + get('minute'),
    second: get('second'),
  };
}

function localMinuteSerial(parts: ReturnType<typeof localParts>): number {
  return (
    Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      Math.floor(parts.minute / 60),
      parts.minute % 60,
    ) / 60_000
  );
}

/**
 * cron-parser shifts a missing 02:30 to 03:30. The calendar contract says the
 * missing wall-clock occurrence runs at the next valid instant (03:00), so
 * detect that forward offset jump and return its boundary. No cron fields are
 * interpreted here; cron-parser remains the sole expression parser.
 */
function nextValidDstInstant(
  expression: CronExpression,
  candidateMs: number,
  afterMs: number,
  timezone: string,
): number {
  const candidate = localParts(candidateMs, timezone);
  const fourHoursEarlier = localParts(candidateMs - 240 * 60_000, timezone);
  if (localMinuteSerial(candidate) - localMinuteSerial(fourHoursEarlier) <= 240) {
    return candidateMs;
  }
  for (let minutes = 0; minutes < 240; minutes += 1) {
    const currentMs = candidateMs - minutes * 60_000;
    const previousMs = currentMs - 60_000;
    const current = localParts(currentMs, timezone);
    const previous = localParts(previousMs, timezone);
    if (
      current.date === candidate.date &&
      previous.date === candidate.date &&
      current.minute - previous.minute > 1
    ) {
      if (currentMs <= afterMs) return candidateMs;
      // Ask cron-parser's parsed field collection whether the skipped local
      // wall-clock range contained an occurrence. Rebuilding in UTC lets a
      // Date represent that otherwise-nonexistent local time without parsing
      // or reimplementing cron field semantics in Body.
      const wallClock = CronExpression.fieldsToExpression(expression.fields, { tz: 'UTC' });
      const second = expression.fields.second.values[0] ?? 0;
      for (let missing = previous.minute + 1; missing < current.minute; missing += 1) {
        const local = new Date(
          Date.UTC(
            current.year,
            current.month - 1,
            current.day,
            Math.floor(missing / 60),
            missing % 60,
            second,
          ),
        );
        if (wallClock.includesDate(local)) return currentMs;
      }
      return candidateMs;
    }
  }
  return candidateMs;
}

/** Normalize cron-parser's reverse traversal of a repeated wall time to its first instant. */
function firstRepeatedLocalInstant(candidateMs: number, timezone: string): number {
  const candidate = localParts(candidateMs, timezone);
  const fourHoursEarlier = localParts(candidateMs - 240 * 60_000, timezone);
  if (localMinuteSerial(candidate) - localMinuteSerial(fourHoursEarlier) >= 240) {
    return candidateMs;
  }
  let first = candidateMs;
  for (let minutes = 1; minutes <= 240; minutes += 1) {
    const priorMs = candidateMs - minutes * 60_000;
    const prior = localParts(priorMs, timezone);
    if (
      prior.date === candidate.date &&
      prior.minute === candidate.minute &&
      prior.second === candidate.second
    ) {
      first = priorMs;
    }
  }
  return first;
}

function boundOccurrence(schedule: WorkScheduleV1, value: number): number | undefined {
  return value >= schedule.startsAt && value <= schedule.expiresAt ? value : undefined;
}

export function nextWorkOccurrence(
  scheduleInput: WorkScheduleV1,
  after: number,
): number | undefined {
  const schedule = parseWorkScheduleValue(scheduleInput);
  if (!schedule || !Number.isFinite(after))
    throw new Error('invalid work schedule occurrence input');
  if (after >= schedule.expiresAt) return undefined;
  if (schedule.cadence.type === 'interval') {
    const minimum = Math.max(schedule.startsAt, Math.floor(after) + 1);
    const steps = Math.max(
      0,
      Math.ceil((minimum - schedule.cadence.anchorAt) / schedule.cadence.everySeconds),
    );
    return boundOccurrence(
      schedule,
      schedule.cadence.anchorAt + steps * schedule.cadence.everySeconds,
    );
  }
  const cadence = cadenceExpression(schedule)!;
  const expression = CronExpressionParser.parse(cadence.expression, {
    currentDate: new Date(Math.max(after, schedule.startsAt - 1) * 1_000),
    endDate: new Date(schedule.expiresAt * 1_000),
    tz: cadence.timezone,
  });
  try {
    const candidateMs = expression.next().toDate().getTime();
    const adjustedMs = nextValidDstInstant(
      expression,
      candidateMs,
      after * 1_000,
      cadence.timezone,
    );
    return boundOccurrence(
      schedule,
      Math.floor(firstRepeatedLocalInstant(adjustedMs, cadence.timezone) / 1_000),
    );
  } catch {
    return undefined;
  }
}

export function previousWorkOccurrence(
  scheduleInput: WorkScheduleV1,
  atOrBefore: number,
): number | undefined {
  const schedule = parseWorkScheduleValue(scheduleInput);
  if (!schedule || !Number.isFinite(atOrBefore))
    throw new Error('invalid work schedule occurrence input');
  const upper = Math.min(Math.floor(atOrBefore), schedule.expiresAt);
  if (upper < schedule.startsAt) return undefined;
  if (schedule.cadence.type === 'interval') {
    const steps = Math.floor((upper - schedule.cadence.anchorAt) / schedule.cadence.everySeconds);
    if (steps < 0) return undefined;
    return boundOccurrence(
      schedule,
      schedule.cadence.anchorAt + steps * schedule.cadence.everySeconds,
    );
  }
  const cadence = cadenceExpression(schedule)!;
  // `prev()` is exclusive. Add one second so an exact occurrence remains eligible.
  const expression = CronExpressionParser.parse(cadence.expression, {
    currentDate: new Date((upper + 1) * 1_000),
    startDate: new Date(schedule.startsAt * 1_000),
    tz: cadence.timezone,
  });
  let candidate: number | undefined;
  try {
    candidate = boundOccurrence(
      schedule,
      Math.floor(
        firstRepeatedLocalInstant(expression.prev().toDate().getTime(), cadence.timezone) / 1_000,
      ),
    );
  } catch {
    // A missing local time can be the schedule's first occurrence, leaving no
    // ordinary `prev()` result inside the start bound. Forward recovery below
    // still finds it through the maintained parser.
  }
  const recovered = nextWorkOccurrence(schedule, candidate ?? schedule.startsAt - 1);
  return recovered !== undefined && recovered <= upper ? recovered : candidate;
}

export function deterministicScheduleRunId(
  scheduleId: string,
  revision: number,
  nominalAt: number,
): string {
  if (
    !SAFE_ID.test(scheduleId) ||
    !Number.isSafeInteger(revision) ||
    revision < 1 ||
    !Number.isSafeInteger(nominalAt) ||
    nominalAt < 0
  ) {
    throw new Error('invalid scheduled run identity');
  }
  return `wsr_${createHash('sha256').update(`buzz-work-run:v1:${scheduleId}:${revision}:${nominalAt}`).digest('hex')}`;
}

export function buildWorkSchedule(
  author: Identity,
  scheduleInput: WorkScheduleV1,
  options: { createdAt?: number; nextAt?: number } = {},
): NostrEvent {
  const schedule = parseWorkScheduleValue(scheduleInput);
  if (!schedule) throw new Error('invalid work schedule');
  const createdAt = options.createdAt ?? Math.floor(Date.now() / 1_000);
  const nextAt =
    options.nextAt ??
    nextWorkOccurrence(schedule, Math.max(schedule.startsAt - 1, createdAt - 1)) ??
    0;
  return signEvent(
    {
      pubkey: author.publicKey,
      created_at: createdAt,
      kind: WORK_SCHEDULE_KIND,
      tags: [
        ['d', workScheduleKey(schedule)],
        ['t', WORK_SCHEDULE_TAG],
        ['h', schedule.roomId],
        ['agent', schedule.agentPubkey],
        ...(schedule.targetAgentPubkey ? [['target-agent', schedule.targetAgentPubkey]] : []),
        ['principal', schedule.principalPubkey],
        ['revision', String(schedule.revision)],
        ['status', schedule.status],
        ...(schedule.execution ? [['execution', workScheduleExecutionMode(schedule)]] : []),
        ...(schedule.execution && schedule.execution.mode !== 'model'
          ? [['script-sha256', schedule.execution.scriptSha256]]
          : []),
        ...(schedule.mission
          ? [
              ['mission', schedule.mission.missionId],
              ['mission-grant', schedule.mission.grantEventId],
              ['controller', schedule.mission.controllerAgentPubkey],
            ]
          : []),
        ['next-at', String(nextAt)],
      ],
      content: JSON.stringify(schedule),
    },
    author.secretKey,
  );
}

export function parseWorkSchedule(event: NostrEvent): ParsedWorkSchedule | undefined {
  if (event.kind !== WORK_SCHEDULE_KIND || event.content.length > 64_000 || !verifyEvent(event))
    return undefined;
  let value: WorkScheduleV1 | undefined;
  try {
    value = parseWorkScheduleValue(JSON.parse(event.content));
  } catch {
    return undefined;
  }
  const nextAtText = uniqueTag(event, 'next-at');
  const nextAt = nextAtText === undefined ? undefined : integer(Number(nextAtText));
  if (
    !value ||
    nextAtText === undefined ||
    nextAt === undefined ||
    uniqueTag(event, 'd') !== workScheduleKey(value) ||
    uniqueTag(event, 't') !== WORK_SCHEDULE_TAG ||
    uniqueTag(event, 'h') !== value.roomId ||
    uniqueTag(event, 'agent') !== value.agentPubkey ||
    (value.targetAgentPubkey
      ? uniqueTag(event, 'target-agent') !== value.targetAgentPubkey
      : uniqueTag(event, 'target-agent') !== undefined) ||
    uniqueTag(event, 'principal') !== value.principalPubkey ||
    uniqueTag(event, 'revision') !== String(value.revision) ||
    uniqueTag(event, 'status') !== value.status ||
    (value.execution
      ? uniqueTag(event, 'execution') !== workScheduleExecutionMode(value)
      : uniqueTag(event, 'execution') !== undefined) ||
    (value.execution && value.execution.mode !== 'model'
      ? uniqueTag(event, 'script-sha256') !== value.execution.scriptSha256
      : uniqueTag(event, 'script-sha256') !== undefined) ||
    (value.mission
      ? uniqueTag(event, 'mission') !== value.mission.missionId ||
        uniqueTag(event, 'mission-grant') !== value.mission.grantEventId ||
        uniqueTag(event, 'controller') !== value.mission.controllerAgentPubkey ||
        event.pubkey !== value.mission.controllerAgentPubkey
      : uniqueTag(event, 'mission') !== undefined ||
        uniqueTag(event, 'mission-grant') !== undefined ||
        uniqueTag(event, 'controller') !== undefined)
  )
    return undefined;
  return { event, value, nextAt: nextAt || undefined };
}

function parseReceiptValue(value: unknown): ScheduledTurnReceiptV1 | undefined {
  const input = object(value);
  const reason = input?.reason === undefined ? undefined : nonEmpty(input.reason, 600);
  if (
    !input ||
    input.version !== 1 ||
    !SAFE_ID.test(String(input.workspaceId)) ||
    !SAFE_ID.test(String(input.roomId)) ||
    typeof input.agentPubkey !== 'string' ||
    !HEX_64.test(input.agentPubkey) ||
    typeof input.principalPubkey !== 'string' ||
    !HEX_64.test(input.principalPubkey) ||
    typeof input.scheduleId !== 'string' ||
    !SAFE_ID.test(input.scheduleId) ||
    integer(input.revision, 1) === undefined ||
    typeof input.runId !== 'string' ||
    !/^wsr_[0-9a-f]{64}$/.test(input.runId) ||
    integer(input.nominalAt) === undefined ||
    !['queued', 'working', 'complete', 'failed', 'skipped'].includes(String(input.status)) ||
    integer(input.at) === undefined ||
    integer(input.reservedTokens, 0, MAX_RESERVED_TOKENS) === undefined ||
    (input.reason !== undefined && !reason)
  )
    return undefined;
  return {
    version: 1,
    workspaceId: input.workspaceId as string,
    roomId: input.roomId as string,
    agentPubkey: input.agentPubkey,
    principalPubkey: input.principalPubkey,
    scheduleId: input.scheduleId,
    revision: input.revision as number,
    runId: input.runId,
    nominalAt: input.nominalAt as number,
    status: input.status as ScheduledTurnStatus,
    at: input.at as number,
    reservedTokens: input.reservedTokens as number,
    ...(reason ? { reason } : {}),
  };
}

export function buildScheduledTurnReceipt(
  identity: Identity,
  input: ScheduledTurnReceiptV1,
): NostrEvent {
  const value = parseReceiptValue(input);
  if (
    !value ||
    identity.publicKey !== value.agentPubkey ||
    deterministicScheduleRunId(value.scheduleId, value.revision, value.nominalAt) !== value.runId
  ) {
    throw new Error('invalid scheduled turn receipt');
  }
  return signEvent(
    {
      pubkey: identity.publicKey,
      created_at: value.at,
      kind: 9,
      tags: [
        ['h', value.roomId],
        ['t', SCHEDULED_TURN_TAG],
        ['workspace', value.workspaceId],
        ['agent', value.agentPubkey],
        ['principal', value.principalPubkey],
        ['schedule', value.scheduleId],
        ['revision', String(value.revision)],
        ['run', value.runId],
        ['nominal', String(value.nominalAt)],
        ['status', value.status],
      ],
      content: JSON.stringify(value),
    },
    identity.secretKey,
  );
}

export function parseScheduledTurnReceipt(
  event: NostrEvent,
): ParsedScheduledTurnReceipt | undefined {
  if (event.kind !== 9 || event.content.length > 8_000 || !verifyEvent(event)) return undefined;
  let value: ScheduledTurnReceiptV1 | undefined;
  try {
    value = parseReceiptValue(JSON.parse(event.content));
  } catch {
    return undefined;
  }
  if (
    !value ||
    event.pubkey !== value.agentPubkey ||
    deterministicScheduleRunId(value.scheduleId, value.revision, value.nominalAt) !== value.runId ||
    uniqueTag(event, 'h') !== value.roomId ||
    uniqueTag(event, 't') !== SCHEDULED_TURN_TAG ||
    uniqueTag(event, 'workspace') !== value.workspaceId ||
    uniqueTag(event, 'agent') !== value.agentPubkey ||
    uniqueTag(event, 'principal') !== value.principalPubkey ||
    uniqueTag(event, 'schedule') !== value.scheduleId ||
    uniqueTag(event, 'revision') !== String(value.revision) ||
    uniqueTag(event, 'run') !== value.runId ||
    uniqueTag(event, 'nominal') !== String(value.nominalAt) ||
    uniqueTag(event, 'status') !== value.status
  )
    return undefined;
  return { event, value };
}

export function buildWorkScheduleProjection(
  identity: Identity,
  input: WorkScheduleProjectionV1,
): NostrEvent {
  const runtimeKey = `${workScheduleKey(input)}:runtime`;
  return signEvent(
    {
      pubkey: identity.publicKey,
      created_at: input.updatedAt,
      kind: WORK_SCHEDULE_KIND,
      tags: [
        // Runtime state is daemon-authored and therefore has its own replaceable
        // key. Sharing the desired-config key would erase an agent-authored
        // schedule on relays that correctly collapse kind:30078 by author+d.
        ['d', runtimeKey],
        ['t', WORK_SCHEDULE_RUNTIME_TAG],
        ['projection', 'runtime'],
        ['h', input.roomId],
        ['agent', input.agentPubkey],
        ['principal', input.principalPubkey],
        ['revision', String(input.revision)],
        ['status', input.status],
        ['next-at', String(input.nextAt ?? 0)],
        ['last-execution', String(input.lastExecutionAt ?? 0)],
        ['runs', String(input.runCount)],
        ['daily-reserved', String(input.dailyReservedTokens)],
        ['failures', String(input.consecutiveFailures)],
      ],
      content: JSON.stringify(input),
    },
    identity.secretKey,
  );
}

export function buildWorkSchedulePauseCard(
  identity: Identity,
  schedule: WorkScheduleV1,
  at: number,
  reason = 'max-consecutive-failures',
): NostrEvent {
  const detail = reason.replaceAll('-', ' ');
  const content = {
    version: 1,
    scheduleId: schedule.scheduleId,
    revision: schedule.revision,
    status: 'paused',
    reason,
    at,
    message:
      reason === 'max-consecutive-failures'
        ? `Scheduled work paused after ${schedule.maxConsecutiveFailures} consecutive failures. A Room admin must publish a newer active revision to resume it.`
        : `Scheduled work paused because ${detail}. A current Room admin must restore authority and publish a newer active revision to resume it.`,
  };
  return signEvent(
    {
      pubkey: identity.publicKey,
      created_at: at,
      kind: 9,
      tags: [
        ['h', schedule.roomId],
        ['t', WORK_SCHEDULE_PAUSED_TAG],
        ['agent', schedule.agentPubkey],
        ['principal', schedule.principalPubkey],
        ['schedule', schedule.scheduleId],
        ['revision', String(schedule.revision)],
        ['status', 'paused'],
        ['reason', reason],
      ],
      content: JSON.stringify(content),
    },
    identity.secretKey,
  );
}

interface HeapEntry {
  key: string;
  parsed: ParsedWorkSchedule;
  nominalAt: number;
  wakeAt: number;
  action: 'run' | 'skip';
}

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
    this.schedules.clear();
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
        if (!humanResume) continue;
      }
      const authority = await this.dependencies.authorize(current);
      if (!authority.authorized) {
        if (authority.terminal) await this.pause(current, authority.reason, true);
        else throw new Error(`transient schedule authority failure: ${authority.reason}`);
        continue;
      }
      if (current.value.status === 'paused') {
        await this.pause(current, 'schedule-paused', false);
        continue;
      }
      const artifacts = await this.validateArtifacts(current);
      if (!artifacts.authorized) {
        if (artifacts.terminal) await this.pause(current, artifacts.reason, true);
        else throw new Error(`transient artifact validation failure: ${artifacts.reason}`);
        continue;
      }
      if (existing && current.value.revision > existing.revision) {
        const resumed: WorkScheduleRuntimeState = {
          ...existing,
          revision: current.value.revision,
          consecutiveFailures: 0,
          status: 'active',
        };
        delete resumed.pauseReason;
        await this.persist(resumed);
      } else if (!existing) {
        await this.persist({
          scheduleId: current.value.scheduleId,
          principalPubkey: pinnedPrincipal,
          revision: current.value.revision,
          runCount: 0,
          dailyReservedTokens: 0,
          consecutiveFailures: 0,
          status: 'active',
        });
      }
      this.schedules.set(key, current);
    }
    this.rebuildHeap();
    this.nextResyncAt =
      this.secondsNow() + (this.dependencies.resyncSeconds ?? DEFAULT_CALENDAR_RESYNC_SECONDS);
    this.armTimer();
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

  private async process(entry: HeapEntry): Promise<void> {
    const schedule = entry.parsed.value;
    const runId = deterministicScheduleRunId(
      schedule.scheduleId,
      schedule.revision,
      entry.nominalAt,
    );
    if (entry.action === 'skip') {
      await this.finish(entry.parsed, runId, entry.nominalAt, 'skipped', false, 'catch-up-skipped');
      return;
    }

    const authority = await this.dependencies.authorize(entry.parsed);
    if (!authority.authorized) {
      if (authority.terminal) await this.pause(entry.parsed, authority.reason, true);
      else this.retryLater(schedule.scheduleId);
      return;
    }
    const artifacts = await this.validateArtifacts(entry.parsed);
    if (!artifacts.authorized) {
      if (artifacts.terminal) await this.pause(entry.parsed, artifacts.reason, true);
      else this.retryLater(schedule.scheduleId);
      return;
    }
    if (this.secondsNow() > schedule.expiresAt) {
      await this.finish(entry.parsed, runId, entry.nominalAt, 'skipped', false, 'schedule-expired');
      return;
    }
    const budgetReason = this.budgetRefusal(schedule);
    if (budgetReason) {
      await this.finish(entry.parsed, runId, entry.nominalAt, 'skipped', false, budgetReason);
      return;
    }
    const missionAction = schedule.mission
      ? await this.dependencies.missionAction?.(entry.parsed, entry.nominalAt)
      : undefined;
    if (schedule.mission && !missionAction) {
      await this.pause(entry.parsed, 'mission-grant-invalid', true);
      return;
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
          await this.finish(entry.parsed, runId, entry.nominalAt, 'skipped', false, error.reason);
        else if (error.terminal) await this.pause(entry.parsed, error.reason, true);
        else this.retryLater(schedule.scheduleId);
        return;
      }
      const reason =
        String(error instanceof Error ? error.message : error)
          .replace(/[\r\n]+/g, ' ')
          .slice(0, 600) || 'scheduled-turn-failed';
      await this.finish(entry.parsed, runId, entry.nominalAt, 'failed', activated, reason);
      return;
    }
    // Keep the last-execution write outside the model/dispatcher catch: a
    // durable-store failure here is a daemon crash condition, not a model
    // failure. On restart the occurrence may run again by design.
    await this.finish(entry.parsed, runId, entry.nominalAt, 'complete', true);
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
  ): Promise<void> {
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
    await this.persist(next);
    this.retryAt.delete(schedule.scheduleId);
    await this.publishReceipt(schedule, runId, nominalAt, status, reason);
    await this.publishProjection(schedule, next);
    if (paused) {
      await this.publishBestEffort(
        buildWorkSchedulePauseCard(this.dependencies.identity, schedule, now),
        `pause card for ${schedule.scheduleId}`,
      );
    }
  }

  private async publishReceipt(
    schedule: WorkScheduleV1,
    runId: string,
    nominalAt: number,
    status: ScheduledTurnStatus,
    reason?: string,
  ): Promise<NostrEvent> {
    const event = buildScheduledTurnReceipt(this.dependencies.identity, {
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
    if (status === 'complete' || status === 'failed' || status === 'skipped') {
      await this.dependencies.store.reserveReceipt(event);
      try {
        await this.dependencies.publish(event);
        await this.dependencies.store.markReceiptDelivered(event.id);
      } catch (error) {
        console.error(`[work-calendar] ${status} receipt for ${runId} publish failed:`, error);
      }
    } else {
      await this.publishBestEffort(event, `${status} receipt for ${runId}`);
    }
    return event;
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
