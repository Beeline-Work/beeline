/** Pure recurring-work wire schema, validation, signing, and cadence math. */
import { createHash } from 'node:crypto';
import { CronExpression, CronExpressionParser } from 'cron-parser';
import { signEvent, verifyEvent, type NostrEvent } from '@beeline/nostr';
import {
  MAX_MISSION_RESERVED_TOKENS,
  type ArtifactRevisionRef,
  type Identity,
} from '@beeline/buzz-client';

export const WORK_SCHEDULE_KIND = 30078;
export const WORK_SCHEDULE_TAG = 'buzz-work-schedule';
export const WORK_SCHEDULE_RUNTIME_TAG = 'buzz-work-schedule-runtime';
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
  /** Mission calendar owner remains the CoS; this names the exact execution target. */
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
  status: 'active' | 'paused' | 'cancelled';
  permissionGrantEventId?: string;
  /** Signed Beeline mandate generation used by the six-tool schedule surface. */
  agentToolMandate?: {
    eventId: string;
    defaultsVersion: number;
  };
}

export interface ParsedWorkSchedule {
  event: NostrEvent;
  value: WorkScheduleV1;
  nextAt: number | undefined;
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
    !['active', 'paused', 'cancelled'].includes(String(input.status))
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
  const rawAgentToolMandate = object(input.agentToolMandate);
  const agentToolMandate = rawAgentToolMandate
    ? {
        eventId: rawAgentToolMandate.eventId,
        defaultsVersion: integer(rawAgentToolMandate.defaultsVersion, 1),
      }
    : undefined;
  if (
    input.agentToolMandate !== undefined &&
    (!agentToolMandate ||
      typeof agentToolMandate.eventId !== 'string' ||
      !HEX_64.test(agentToolMandate.eventId) ||
      agentToolMandate.defaultsVersion === undefined)
  ) {
    return undefined;
  }
  if (permissionGrantEventId && agentToolMandate) return undefined;
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
    ...(agentToolMandate
      ? {
          agentToolMandate: {
            eventId: agentToolMandate.eventId as string,
            defaultsVersion: agentToolMandate.defaultsVersion as number,
          },
        }
      : {}),
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
        ...(schedule.agentToolMandate
          ? [
              ['mandate', schedule.agentToolMandate.eventId],
              ['mandate-defaults-version', String(schedule.agentToolMandate.defaultsVersion)],
            ]
          : []),
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
    (value.agentToolMandate
      ? uniqueTag(event, 'mandate') !== value.agentToolMandate.eventId ||
        uniqueTag(event, 'mandate-defaults-version') !==
          String(value.agentToolMandate.defaultsVersion)
      : uniqueTag(event, 'mandate') !== undefined ||
        uniqueTag(event, 'mandate-defaults-version') !== undefined) ||
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
  return signEvent(
    {
      pubkey: identity.publicKey,
      created_at: at,
      kind: WORK_SCHEDULE_KIND,
      tags: [
        ['d', `${workScheduleKey(schedule)}:pause`],
        ['h', schedule.roomId],
        ['t', WORK_SCHEDULE_PAUSED_TAG],
        ['agent', schedule.agentPubkey],
        ['principal', schedule.principalPubkey],
        ['schedule', schedule.scheduleId],
        ['revision', String(schedule.revision)],
        ['status', 'paused'],
        ['reason', reason],
        ['at', String(at)],
      ],
      content: '',
    },
    identity.secretKey,
  );
}
