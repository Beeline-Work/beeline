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
import type { ArtifactRevisionRef, Identity } from '@beeline/buzz-client';

export const WORK_SCHEDULE_KIND = 30078;
export const WORK_SCHEDULE_TAG = 'buzz-work-schedule';
export const WORK_SCHEDULE_RUNTIME_TAG = 'buzz-work-schedule-runtime';
export const SCHEDULED_TURN_TAG = 'buzz-scheduled-turn';
export const WORK_SCHEDULE_PAUSED_TAG = 'buzz-work-schedule-paused';
export const WORK_SCHEDULE_VERSION = 1 as const;
export const DEFAULT_CALENDAR_RESYNC_SECONDS = 60;
export const DEFAULT_CALENDAR_RETRY_SECONDS = 5;
export const MAX_CALENDAR_DUE_PER_WAKE = 16;

const HEX_64 = /^[0-9a-f]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,255}$/;
const LOCAL_TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const MAX_PROMPT_CHARS = 32_000;
const MAX_ARTIFACT_REFS = 128;
const MAX_RUNS = 1_000_000;
const MAX_RESERVED_TOKENS = 100_000_000;
const MAX_INTERVAL_SECONDS = 366 * 24 * 60 * 60;

export interface WorkScheduleV1 {
  version: 1;
  scheduleId: string;
  revision: number;
  workspaceId: string;
  roomId: string;
  agentPubkey: string;
  principalPubkey: string;
  prompt: string;
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
  status: 'active' | 'paused' | 'deleted';
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
  consecutiveFailures: number;
  updatedAt: number;
}

export interface ScheduledTurnRequest {
  trigger: 'schedule';
  priority: 'background';
  workspaceId: string;
  roomId: string;
  agentPubkey: string;
  principalPubkey: string;
  scheduleId: string;
  scheduleRevision: number;
  scheduleRunId: string;
  nominalAt: number;
  prompt: string;
  artifactRefs: readonly ArtifactRevisionRef[];
  reservedTokens: number;
  queuedEvent: NostrEvent;
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

class WorkingReceiptPendingError extends Error {}

export interface CalendarRunReservation {
  runId: string;
  scheduleId: string;
  revision: number;
  workspaceId: string;
  roomId: string;
  agentPubkey: string;
  principalPubkey: string;
  nominalAt: number;
  reservedTokens: number;
  reservedAt: number;
}

export interface CalendarStoredReceipt {
  event: NostrEvent;
  published: boolean;
}

export interface CalendarRunRecord extends CalendarRunReservation {
  state: 'reserved' | ScheduledTurnStatus;
  receipts: Partial<Record<ScheduledTurnStatus, CalendarStoredReceipt>>;
}

export interface WorkCalendarStore {
  load(): Promise<void>;
  runs(): Promise<CalendarRunRecord[]>;
  reserveRun(
    reservation: CalendarRunReservation,
  ): Promise<{ state: 'reserved' | 'existing'; record: CalendarRunRecord }>;
  stageReceipt(
    runId: string,
    status: ScheduledTurnStatus,
    event: NostrEvent,
  ): Promise<CalendarStoredReceipt>;
  markReceiptPublished(runId: string, status: ScheduledTurnStatus, eventId: string): Promise<void>;
  pendingReceipts(): Promise<
    Array<{ runId: string; status: ScheduledTurnStatus; event: NostrEvent }>
  >;
  stageOutput(key: string, event: NostrEvent): Promise<NostrEvent>;
  pendingOutputs(): Promise<Array<{ key: string; event: NostrEvent }>>;
  markOutputPublished(key: string, eventId: string): Promise<void>;
  stageCompletion(
    runId: string,
    status: 'complete' | 'failed' | 'skipped',
    receipt: NostrEvent,
    outputs: readonly { key: string; event: NostrEvent }[],
  ): Promise<void>;
  principalForSchedule(scheduleId: string): Promise<string | undefined>;
  pinSchedulePrincipal(scheduleId: string, principalPubkey: string): Promise<void>;
}

interface DurableCalendarData {
  version: 1;
  runs: Record<string, CalendarRunRecord>;
  outputs: Record<string, NostrEvent>;
  principals: Record<string, string>;
}

function cloneRun(record: CalendarRunRecord): CalendarRunRecord {
  return structuredClone(record);
}

/** Atomic local journal. A staged terminal receipt is authoritative even if relay publication fails. */
export class DurableWorkCalendarState implements WorkCalendarStore {
  private data: DurableCalendarData = { version: 1, runs: {}, outputs: {}, principals: {} };
  private loaded = false;
  private saveTail: Promise<void> = Promise.resolve();

  constructor(private readonly path: string) {}

  async load(): Promise<void> {
    if (this.loaded) return;
    try {
      const parsed = JSON.parse(await readFile(this.path, 'utf8')) as DurableCalendarData;
      if (
        parsed.version !== 1 ||
        !parsed.runs ||
        typeof parsed.runs !== 'object' ||
        (parsed.outputs !== undefined &&
          (!parsed.outputs || typeof parsed.outputs !== 'object' || Array.isArray(parsed.outputs))) ||
        (parsed.principals !== undefined &&
          (!parsed.principals ||
            typeof parsed.principals !== 'object' ||
            Array.isArray(parsed.principals)))
      ) {
        throw new Error(`unsupported durable work calendar state at ${this.path}`);
      }
      this.data = { ...parsed, outputs: parsed.outputs ?? {}, principals: parsed.principals ?? {} };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    this.loaded = true;
  }

  async runs(): Promise<CalendarRunRecord[]> {
    await this.load();
    return Object.values(this.data.runs).map(cloneRun);
  }

  async reserveRun(
    reservation: CalendarRunReservation,
  ): Promise<{ state: 'reserved' | 'existing'; record: CalendarRunRecord }> {
    await this.load();
    const existing = this.data.runs[reservation.runId];
    if (existing) return { state: 'existing', record: cloneRun(existing) };
    const record: CalendarRunRecord = { ...reservation, state: 'reserved', receipts: {} };
    this.data.runs[reservation.runId] = record;
    await this.save();
    return { state: 'reserved', record: cloneRun(record) };
  }

  async stageReceipt(
    runId: string,
    status: ScheduledTurnStatus,
    event: NostrEvent,
  ): Promise<CalendarStoredReceipt> {
    await this.load();
    const record = this.data.runs[runId];
    if (!record) throw new Error(`calendar run ${runId} was not reserved`);
    const existing = record.receipts[status];
    if (existing) return structuredClone(existing);
    const receipt = { event, published: false };
    record.receipts[status] = receipt;
    if (status !== 'working') record.state = status;
    await this.save();
    return structuredClone(receipt);
  }

  async markReceiptPublished(
    runId: string,
    status: ScheduledTurnStatus,
    eventId: string,
  ): Promise<void> {
    await this.load();
    const record = this.data.runs[runId];
    const receipt = record?.receipts[status];
    if (!receipt || receipt.event.id !== eventId || receipt.published) return;
    receipt.published = true;
    if (status === 'working' && !isTerminal(record.state)) record.state = 'working';
    await this.save();
  }

  async pendingReceipts(): Promise<
    Array<{ runId: string; status: ScheduledTurnStatus; event: NostrEvent }>
  > {
    await this.load();
    const pending: Array<{ runId: string; status: ScheduledTurnStatus; event: NostrEvent }> = [];
    for (const record of Object.values(this.data.runs)) {
      for (const status of ['queued', 'working', 'complete', 'failed', 'skipped'] as const) {
        if (status === 'working') continue;
        const receipt = record.receipts[status];
        if (receipt && !receipt.published)
          pending.push({ runId: record.runId, status, event: receipt.event });
      }
    }
    return pending.sort(
      (left, right) =>
        left.event.created_at - right.event.created_at ||
        left.event.id.localeCompare(right.event.id),
    );
  }

  async stageOutput(key: string, event: NostrEvent): Promise<NostrEvent> {
    await this.load();
    const existing = this.data.outputs[key];
    if (existing) return structuredClone(existing);
    this.data.outputs[key] = event;
    await this.save();
    return structuredClone(event);
  }

  async pendingOutputs(): Promise<Array<{ key: string; event: NostrEvent }>> {
    await this.load();
    return Object.entries(this.data.outputs)
      .map(([key, event]) => ({ key, event: structuredClone(event) }))
      .sort(
        (left, right) =>
          left.event.created_at - right.event.created_at ||
          left.event.id.localeCompare(right.event.id),
      );
  }

  async markOutputPublished(key: string, eventId: string): Promise<void> {
    await this.load();
    if (this.data.outputs[key]?.id !== eventId) return;
    delete this.data.outputs[key];
    await this.save();
  }

  async stageCompletion(
    runId: string,
    status: 'complete' | 'failed' | 'skipped',
    event: NostrEvent,
    outputs: readonly { key: string; event: NostrEvent }[],
  ): Promise<void> {
    await this.load();
    const record = this.data.runs[runId];
    if (!record) throw new Error(`calendar run ${runId} was not reserved`);
    if (!record.receipts[status]) record.receipts[status] = { event, published: false };
    record.state = status;
    for (const output of outputs) {
      if (!this.data.outputs[output.key]) this.data.outputs[output.key] = output.event;
    }
    await this.save();
  }

  async principalForSchedule(scheduleId: string): Promise<string | undefined> {
    await this.load();
    return this.data.principals[scheduleId];
  }

  async pinSchedulePrincipal(scheduleId: string, principalPubkey: string): Promise<void> {
    await this.load();
    const existing = this.data.principals[scheduleId];
    if (existing && existing !== principalPubkey)
      throw new Error(`schedule ${scheduleId} is pinned to another principal`);
    if (existing) return;
    this.data.principals[scheduleId] = principalPubkey;
    await this.save();
  }

  private save(): Promise<void> {
    this.saveTail = this.saveTail.then(async () => {
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      const temporary = resolve(dirname(this.path), `work-calendar-${process.pid}.tmp`);
      await writeFile(temporary, `${JSON.stringify(this.data, null, 2)}\n`, { mode: 0o600 });
      await rename(temporary, this.path);
    });
    return this.saveTail;
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

export function parseWorkScheduleValue(value: unknown): WorkScheduleV1 | undefined {
  const input = object(value);
  if (!input || input.version !== 1) return undefined;
  const scheduleId = nonEmpty(input.scheduleId, 256);
  const revision = integer(input.revision, 1);
  const workspaceId = nonEmpty(input.workspaceId, 256);
  const roomId = nonEmpty(input.roomId, 256);
  const prompt = nonEmpty(input.prompt, MAX_PROMPT_CHARS);
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
    !cadence ||
    revision === undefined ||
    typeof input.agentPubkey !== 'string' ||
    !HEX_64.test(input.agentPubkey) ||
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
    !['active', 'paused', 'deleted'].includes(String(input.status))
  )
    return undefined;
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
    principalPubkey: input.principalPubkey,
    prompt,
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
  return createHash('sha256').update(stable(revision)).digest('hex');
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
        ['principal', schedule.principalPubkey],
        ['revision', String(schedule.revision)],
        ['status', schedule.status],
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
    uniqueTag(event, 'principal') !== value.principalPubkey ||
    uniqueTag(event, 'revision') !== String(value.revision) ||
    uniqueTag(event, 'status') !== value.status
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
): NostrEvent {
  const content = {
    version: 1,
    scheduleId: schedule.scheduleId,
    revision: schedule.revision,
    status: 'paused',
    at,
    message: `Scheduled work paused after ${schedule.maxConsecutiveFailures} consecutive failures. A Room admin must publish an active revision to resume it.`,
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
  action: 'run' | 'skip' | 'resume' | 'resume-relay-queued' | 'recover-unknown';
  relayQueuedEvent?: NostrEvent;
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
  readReceipts(): Promise<readonly NostrEvent[]>;
  authorize(schedule: ParsedWorkSchedule): Promise<ScheduleAuthorityResult>;
  validateScheduleCreation?(creation: readonly ParsedWorkSchedule[]): Promise<boolean>;
  publish(event: NostrEvent): Promise<void>;
  dispatch(
    request: ScheduledTurnRequest,
    beforeModelActivation: () => Promise<void>,
    publishOutput: (event: NostrEvent) => Promise<void>,
  ): Promise<void>;
  now?: () => number;
  resyncSeconds?: number;
  retrySeconds?: number;
}

function currentStatus(record: CalendarRunRecord): ScheduledTurnStatus | 'reserved' {
  return record.state;
}

function isTerminal(status: CalendarRunRecord['state'] | ScheduledTurnStatus): boolean {
  return status === 'complete' || status === 'failed' || status === 'skipped';
}

function dayUtc(at: number): string {
  return new Date(at * 1_000).toISOString().slice(0, 10);
}

/** One heap and one next-due timer for all schedules owned by one agent daemon. */
export class WorkCalendar {
  private readonly heap = new ScheduleHeap();
  private readonly schedules = new Map<string, ParsedWorkSchedule>();
  private localRuns: CalendarRunRecord[] = [];
  private relayReceipts: ParsedScheduledTurnReceipt[] = [];
  private readonly retryAt = new Map<string, number>();
  private timer?: ReturnType<typeof setTimeout>;
  private nextResyncAt = 0;
  private started = false;
  private disposed = false;
  private wakeTail: Promise<void> = Promise.resolve();
  private readonly inFlight = new Map<string, Promise<void>>();

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
        if (this.disposed) return;
        await this.flushOutbox();
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
    await Promise.all([...this.inFlight.values()]);
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    await this.wakeTail.catch(() => undefined);
    await Promise.all([...this.inFlight.values()]);
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
    const [scheduleEvents, receiptEvents] = await Promise.all([
      this.dependencies.readSchedules(),
      this.dependencies.readReceipts(),
    ]);
    this.localRuns = await this.dependencies.store.runs();
    this.relayReceipts = receiptEvents.flatMap((event) => {
      const parsed = parseScheduledTurnReceipt(event);
      return parsed &&
        parsed.event.pubkey === this.dependencies.identity.publicKey &&
        parsed.value.workspaceId === this.dependencies.workspaceId &&
        parsed.value.agentPubkey === this.dependencies.identity.publicKey
        ? [parsed]
        : [];
    });
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
      let pinnedPrincipal = await this.dependencies.store.principalForSchedule(
        list[0]!.value.scheduleId,
      );
      const plausible = list.filter(
        (candidate) =>
          candidate.event.pubkey === candidate.value.principalPubkey ||
          candidate.event.pubkey === candidate.value.agentPubkey,
      );
      if (!pinnedPrincipal) {
        const durablePrincipals = new Set([
          ...this.localRuns
            .filter((run) => run.scheduleId === list[0]!.value.scheduleId)
            .map((run) => run.principalPubkey),
          ...this.relayReceipts
            .filter((receipt) => receipt.value.scheduleId === list[0]!.value.scheduleId)
            .map((receipt) => receipt.value.principalPubkey),
        ]);
        if (durablePrincipals.size > 1) continue;
        pinnedPrincipal =
          durablePrincipals.values().next().value ??
          (await creationPrincipalFromHistory(
            plausible,
            this.dependencies.validateScheduleCreation,
          ));
        if (!pinnedPrincipal) continue;
        await this.dependencies.store.pinSchedulePrincipal(
          list[0]!.value.scheduleId,
          pinnedPrincipal,
        );
      }
      const newest = plausible
        .filter((candidate) => candidate.value.principalPubkey === pinnedPrincipal)
        .sort(
          (left, right) =>
            right.value.revision - left.value.revision ||
            right.event.created_at - left.event.created_at ||
            right.event.id.localeCompare(left.event.id),
        )[0];
      const current =
        newest && (await this.dependencies.authorize(newest)).authorized ? newest : undefined;
      if (!current) continue;
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

  private recordsFor(schedule: WorkScheduleV1): CalendarRunRecord[] {
    return this.localRuns.filter((run) => run.scheduleId === schedule.scheduleId);
  }

  private receiptsFor(schedule: WorkScheduleV1): ParsedScheduledTurnReceipt[] {
    return this.relayReceipts.filter((receipt) => receipt.value.scheduleId === schedule.scheduleId);
  }

  private relayRunStates(schedule: WorkScheduleV1): ParsedScheduledTurnReceipt[] {
    const rank: Record<ScheduledTurnStatus, number> = {
      queued: 1,
      working: 2,
      complete: 3,
      failed: 3,
      skipped: 3,
    };
    const states = new Map<string, ParsedScheduledTurnReceipt>();
    for (const receipt of this.receiptsFor(schedule)) {
      if (receipt.value.revision !== schedule.revision) continue;
      const current = states.get(receipt.value.runId);
      if (
        !current ||
        rank[receipt.value.status] > rank[current.value.status] ||
        (rank[receipt.value.status] === rank[current.value.status] &&
          (receipt.value.at > current.value.at ||
            (receipt.value.at === current.value.at && receipt.event.id > current.event.id)))
      ) {
        states.set(receipt.value.runId, receipt);
      }
    }
    return [...states.values()];
  }

  private entryFor(key: string, parsed: ParsedWorkSchedule, now: number): HeapEntry | undefined {
    const schedule = parsed.value;
    if (schedule.status !== 'active' || now > schedule.expiresAt) return undefined;
    const revisionRuns = this.recordsFor(schedule).filter(
      (run) => run.revision === schedule.revision,
    );
    const pending = revisionRuns
      .filter((run) => !isTerminal(currentStatus(run)))
      .sort((left, right) => right.nominalAt - left.nominalAt)[0];
    if (pending) {
      const action = pending.state === 'working' ? 'recover-unknown' : 'resume';
      return {
        key,
        parsed,
        nominalAt: pending.nominalAt,
        wakeAt: Math.max(now, this.retryAt.get(pending.runId) ?? now),
        action,
      };
    }
    const relayPending = this.relayRunStates(schedule)
      .filter(
        (receipt) =>
          (receipt.value.status === 'working' || receipt.value.status === 'queued') &&
          !revisionRuns.some((run) => run.runId === receipt.value.runId),
      )
      .sort((left, right) => right.value.nominalAt - left.value.nominalAt)[0];
    if (relayPending)
      return {
        key,
        parsed,
        nominalAt: relayPending.value.nominalAt,
        wakeAt: now,
        action: relayPending.value.status === 'working' ? 'recover-unknown' : 'resume-relay-queued',
        ...(relayPending.value.status === 'queued'
          ? { relayQueuedEvent: relayPending.event }
          : {}),
      };
    const failures = this.consecutiveFailures(schedule);
    if (failures >= schedule.maxConsecutiveFailures) return undefined;
    const handled = [
      ...revisionRuns.map((run) => run.nominalAt),
      ...this.receiptsFor(schedule)
        .filter((receipt) => receipt.value.revision === schedule.revision)
        .map((receipt) => receipt.value.nominalAt),
    ];
    const after = handled.length ? Math.max(...handled) : schedule.startsAt - 1;
    const next = nextWorkOccurrence(schedule, after);
    if (next === undefined) return undefined;
    if (next < now) {
      const latest = previousWorkOccurrence(schedule, now);
      if (latest === undefined || latest <= after) return undefined;
      return {
        key,
        parsed,
        nominalAt: latest,
        wakeAt: now,
        action: schedule.catchUp === 'skip' ? 'skip' : 'run',
      };
    }
    return { key, parsed, nominalAt: next, wakeAt: next, action: 'run' };
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
    await this.flushOutbox();
    let submitted = 0;
    while (submitted < MAX_CALENDAR_DUE_PER_WAKE) {
      const entry = this.heap.peek();
      if (!entry || entry.wakeAt > this.secondsNow()) break;
      this.heap.pop();
      submitted += 1;
      const key = `${entry.key}:${entry.parsed.value.revision}:${entry.nominalAt}`;
      if (this.inFlight.has(key)) continue;
      const run = this.process(entry)
        .then(async () => {
          this.localRuns = await this.dependencies.store.runs();
          const current = this.schedules.get(entry.key);
          if (current && current.value.revision === entry.parsed.value.revision) {
            const next = this.entryFor(entry.key, current, this.secondsNow());
            if (next) this.heap.push(next);
          }
        })
        .catch((error) => console.error(`[work-calendar] run ${key} failed:`, error))
        .finally(() => {
          this.inFlight.delete(key);
          this.armTimer();
        });
      this.inFlight.set(key, run);
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
    const reservation = await this.dependencies.store.reserveRun({
      runId,
      scheduleId: schedule.scheduleId,
      revision: schedule.revision,
      workspaceId: schedule.workspaceId,
      roomId: schedule.roomId,
      agentPubkey: schedule.agentPubkey,
      principalPubkey: schedule.principalPubkey,
      nominalAt: entry.nominalAt,
      reservedTokens: schedule.perRunReservedTokens,
      reservedAt: this.secondsNow(),
    });
    if (reservation.state === 'reserved') this.localRuns.push(reservation.record);

    if (entry.action === 'recover-unknown' || reservation.record.state === 'working') {
      await this.finish(
        schedule,
        runId,
        entry.nominalAt,
        'failed',
        'outcome-unknown-after-restart',
      );
      return;
    }
    if (entry.action === 'skip') {
      await this.finish(schedule, runId, entry.nominalAt, 'skipped', 'catch-up-skipped');
      return;
    }
    if (isTerminal(reservation.record.state)) return;

    let queued: NostrEvent | undefined;
    if (entry.action === 'resume-relay-queued' && entry.relayQueuedEvent) {
      await this.dependencies.store.stageReceipt(runId, 'queued', entry.relayQueuedEvent);
      await this.dependencies.store.markReceiptPublished(
        runId,
        'queued',
        entry.relayQueuedEvent.id,
      );
      queued = entry.relayQueuedEvent;
    } else {
      queued = await this.publishReceipt(schedule, runId, entry.nominalAt, 'queued');
    }
    if (!queued) {
      this.retryAt.set(
        runId,
        this.secondsNow() + (this.dependencies.retrySeconds ?? DEFAULT_CALENDAR_RETRY_SECONDS),
      );
      return;
    }

    const authority = await this.dependencies.authorize(entry.parsed);
    if (!authority.authorized) {
      if (authority.terminal)
        await this.finish(schedule, runId, entry.nominalAt, 'skipped', authority.reason);
      else
        this.retryAt.set(
          runId,
          this.secondsNow() + (this.dependencies.retrySeconds ?? DEFAULT_CALENDAR_RETRY_SECONDS),
        );
      return;
    }
    if (this.secondsNow() > schedule.expiresAt) {
      await this.finish(schedule, runId, entry.nominalAt, 'skipped', 'schedule-expired');
      return;
    }
    const budgetReason = this.budgetRefusal(schedule, runId);
    if (budgetReason) {
      await this.finish(schedule, runId, entry.nominalAt, 'skipped', budgetReason);
      return;
    }

    try {
      let activationChecked = false;
      await this.dependencies.dispatch(
        {
          trigger: 'schedule',
          priority: 'background',
          workspaceId: schedule.workspaceId,
          roomId: schedule.roomId,
          agentPubkey: schedule.agentPubkey,
          principalPubkey: schedule.principalPubkey,
          scheduleId: schedule.scheduleId,
          scheduleRevision: schedule.revision,
          scheduleRunId: runId,
          nominalAt: entry.nominalAt,
          prompt: schedule.prompt,
          artifactRefs: schedule.artifactRefs ?? [],
          reservedTokens: schedule.perRunReservedTokens,
          queuedEvent: queued,
        },
        async () => {
          if (activationChecked) return;
          const currentAuthority = await this.dependencies.authorize(entry.parsed);
          if (!currentAuthority.authorized) {
            throw new ScheduleActivationRefusedError(
              currentAuthority.terminal,
              currentAuthority.reason,
            );
          }
          if (this.secondsNow() > schedule.expiresAt) {
            throw new ScheduleActivationRefusedError(true, 'schedule-expired');
          }
          const currentBudgetReason = this.budgetRefusal(schedule, runId);
          if (currentBudgetReason) {
            throw new ScheduleActivationRefusedError(true, currentBudgetReason);
          }
          const working = await this.publishReceipt(
            schedule,
            runId,
            entry.nominalAt,
            'working',
          );
          if (!working) throw new WorkingReceiptPendingError('working-receipt-publish-pending');
          activationChecked = true;
        },
        (event) => this.publishOutput(`reply:${schedule.scheduleId}:${runId}`, event),
      );
      if (!activationChecked) {
        throw new Error('scheduled dispatcher bypassed the activation authority check');
      }
      await this.finish(schedule, runId, entry.nominalAt, 'complete');
    } catch (error) {
      if (error instanceof WorkingReceiptPendingError) {
        this.retryAt.set(
          runId,
          this.secondsNow() + (this.dependencies.retrySeconds ?? DEFAULT_CALENDAR_RETRY_SECONDS),
        );
        return;
      }
      if (error instanceof ScheduleActivationRefusedError) {
        await this.finish(
          schedule,
          runId,
          entry.nominalAt,
          error.terminal ? 'skipped' : 'failed',
          error.reason,
        );
        return;
      }
      const reason =
        String(error instanceof Error ? error.message : error)
          .replace(/[\r\n]+/g, ' ')
          .slice(0, 600) || 'scheduled-turn-failed';
      await this.finish(schedule, runId, entry.nominalAt, 'failed', reason);
    }
  }

  private budgetRefusal(schedule: WorkScheduleV1, runId: string): string | undefined {
    const modelRuns = new Map<string, { at: number; reservedTokens: number }>();
    for (const run of this.recordsFor(schedule)) {
      if (run.runId !== runId && ['working', 'complete', 'failed'].includes(run.state)) {
        modelRuns.set(run.runId, { at: run.reservedAt, reservedTokens: run.reservedTokens });
      }
    }
    for (const receipt of this.receiptsFor(schedule)) {
      if (
        receipt.value.runId !== runId &&
        ['working', 'complete', 'failed'].includes(receipt.value.status)
      ) {
        modelRuns.set(receipt.value.runId, {
          at: receipt.value.at,
          reservedTokens: receipt.value.reservedTokens,
        });
      }
    }
    if (modelRuns.size >= schedule.maxRuns) return 'max-runs-exhausted';
    const day = dayUtc(this.secondsNow());
    const daily = [...modelRuns.values()]
      .filter((run) => dayUtc(run.at) === day)
      .reduce((sum, run) => sum + run.reservedTokens, 0);
    return daily + schedule.perRunReservedTokens > schedule.dailyReservedTokens
      ? 'daily-budget-exhausted'
      : undefined;
  }

  private consecutiveFailures(
    schedule: WorkScheduleV1,
    additional?: {
      runId: string;
      nominalAt: number;
      status: 'complete' | 'failed' | 'skipped';
    },
  ): number {
    const terminal = new Map<string, { nominalAt: number; status: ScheduledTurnStatus }>();
    for (const run of this.recordsFor(schedule)) {
      if (run.revision === schedule.revision && isTerminal(run.state))
        terminal.set(run.runId, {
          nominalAt: run.nominalAt,
          status: run.state as ScheduledTurnStatus,
        });
    }
    for (const receipt of this.receiptsFor(schedule)) {
      if (receipt.value.revision === schedule.revision && isTerminal(receipt.value.status)) {
        terminal.set(receipt.value.runId, {
          nominalAt: receipt.value.nominalAt,
          status: receipt.value.status,
        });
      }
    }
    if (additional) terminal.set(additional.runId, additional);
    let count = 0;
    for (const result of [...terminal.values()].sort(
      (left, right) => right.nominalAt - left.nominalAt,
    )) {
      if (result.status === 'failed') count += 1;
      else if (result.status === 'complete') break;
    }
    return count;
  }

  private async finish(
    schedule: WorkScheduleV1,
    runId: string,
    nominalAt: number,
    status: 'complete' | 'failed' | 'skipped',
    reason?: string,
  ): Promise<void> {
    const terminalEvent = this.buildReceipt(schedule, runId, nominalAt, status, reason);
    const failures = this.consecutiveFailures(schedule, { runId, nominalAt, status });
    const paused = failures >= schedule.maxConsecutiveFailures;
    const nextAt = paused ? undefined : nextWorkOccurrence(schedule, nominalAt);
    const projectionKey = `projection:${schedule.scheduleId}:${schedule.revision}:${runId}:${status}`;
    const projection = buildWorkScheduleProjection(this.dependencies.identity, {
      version: 1,
      type: 'runtime',
      workspaceId: schedule.workspaceId,
      roomId: schedule.roomId,
      agentPubkey: schedule.agentPubkey,
      principalPubkey: schedule.principalPubkey,
      scheduleId: schedule.scheduleId,
      revision: schedule.revision,
      status: paused ? 'paused' : schedule.status,
      ...(nextAt !== undefined ? { nextAt } : {}),
      consecutiveFailures: failures,
      updatedAt: this.secondsNow(),
    });
    const outputs = [{ key: projectionKey, event: projection }];
    if (paused && failures === schedule.maxConsecutiveFailures) {
      outputs.push({
        key: `pause:${schedule.scheduleId}:${schedule.revision}`,
        event: buildWorkSchedulePauseCard(this.dependencies.identity, schedule, this.secondsNow()),
      });
    }
    await this.dependencies.store.stageCompletion(runId, status, terminalEvent, outputs);
    this.retryAt.delete(runId);
    this.localRuns = await this.dependencies.store.runs();
    await this.publishReceipt(schedule, runId, nominalAt, status, reason);
    for (const output of outputs) await this.publishOutput(output.key, output.event);
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

  private async publishReceipt(
    schedule: WorkScheduleV1,
    runId: string,
    nominalAt: number,
    status: ScheduledTurnStatus,
    reason?: string,
  ): Promise<NostrEvent | undefined> {
    const event = this.buildReceipt(schedule, runId, nominalAt, status, reason);
    const staged = await this.dependencies.store.stageReceipt(runId, status, event);
    if (staged.published) return staged.event;
    try {
      await this.dependencies.publish(staged.event);
      await this.dependencies.store.markReceiptPublished(runId, status, staged.event.id);
      return staged.event;
    } catch (error) {
      console.error(`[work-calendar] ${status} receipt publish failed for ${runId}:`, error);
      return undefined;
    }
  }

  private async flushOutbox(): Promise<void> {
    for (const pending of await this.dependencies.store.pendingReceipts()) {
      try {
        await this.dependencies.publish(pending.event);
        await this.dependencies.store.markReceiptPublished(
          pending.runId,
          pending.status,
          pending.event.id,
        );
      } catch (error) {
        console.error(
          `[work-calendar] pending receipt publish failed for ${pending.runId}:`,
          error,
        );
        break;
      }
    }
    for (const pending of await this.dependencies.store.pendingOutputs()) {
      try {
        await this.dependencies.publish(pending.event);
        await this.dependencies.store.markOutputPublished(pending.key, pending.event.id);
      } catch (error) {
        console.error(`[work-calendar] pending output publish failed for ${pending.key}:`, error);
        break;
      }
    }
  }

  private async publishOutput(key: string, event: NostrEvent): Promise<void> {
    const staged = await this.dependencies.store.stageOutput(key, event);
    try {
      await this.dependencies.publish(staged);
      await this.dependencies.store.markOutputPublished(key, staged.id);
    } catch (error) {
      console.error(`[work-calendar] output publish failed for ${key}:`, error);
    }
  }
}
