/** Durable local state and receipt outbox for the work calendar. */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { NostrEvent } from '@beeline/nostr';
import { MAX_MISSION_RESERVED_TOKENS, parseScheduledTurnReceipt } from '@beeline/buzz-client';

const HEX_64 = /^[0-9a-f]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,255}$/;
const MAX_RUNS = 1_000_000;
const MAX_RESERVED_TOKENS = MAX_MISSION_RESERVED_TOKENS;

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
  putWithReceipt(state: WorkScheduleRuntimeState, event: NostrEvent): Promise<void>;
  reserveReceipt(event: NostrEvent): Promise<void>;
  pendingReceipts(): Promise<NostrEvent[]>;
  markReceiptDelivered(eventId: string): Promise<void>;
}

interface DurableCalendarData {
  version: 3;
  schedules: Record<string, WorkScheduleRuntimeState>;
  pendingReceipts: Record<string, NostrEvent>;
}

export function cloneState(state: WorkScheduleRuntimeState): WorkScheduleRuntimeState {
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

  async putWithReceipt(state: WorkScheduleRuntimeState, event: NostrEvent): Promise<void> {
    await this.load();
    const parsed = parseRuntimeState(state);
    if (!parsed) throw new Error('invalid work calendar runtime state');
    if (!parseScheduledTurnReceipt(event))
      throw new Error('invalid scheduled receipt outbox event');
    await this.enqueueSave(async () => {
      const next: DurableCalendarData = {
        version: 3,
        schedules: {
          ...this.data.schedules,
          [parsed.scheduleId]: cloneState(parsed),
        },
        pendingReceipts: { ...this.data.pendingReceipts, [event.id]: event },
      };
      await this.write(next);
      this.data = next;
    });
  }

  async reserveReceipt(event: NostrEvent): Promise<void> {
    await this.load();
    if (!parseScheduledTurnReceipt(event))
      throw new Error('invalid scheduled receipt outbox event');
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
