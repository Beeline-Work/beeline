/**
 * Where a turn's time goes.
 *
 * Nobody could answer "why is Beeline slower than my terminal?" with a number,
 * because nothing recorded the shape of a turn. `agent_turns.created_at` is a
 * FRESHNESS stamp — `DaemonService.turnReceipt` rewrites it on every heartbeat
 * and status upsert — so it is not a start time and must not be repurposed
 * into one. This module records the missing fact instead, entirely daemon-side.
 *
 * Two rules hold it up:
 *
 * 1. **Durations come from ONE process's monotonic clock.** Every number here
 *    is a difference of two `performance.now()` readings taken in this daemon.
 *    Wall clock appears exactly once, as `startedAt`, and only so an operator
 *    can line a trace up against a Room row — it is never subtracted, and no
 *    duration ever spans two machines.
 * 2. **A trace is an operator artifact and never a Room row.** This module
 *    takes no `DaemonApiClient` and cannot post anything: it writes JSON lines
 *    under the daemon's own runtime directory and logs one compact line. The
 *    repo's hard-won rules — one durable answer per turn, no revived daemon
 *    status chatter — are enforced here by construction.
 *
 * Phases are keyed by the turn's request id and grouped by ATTEMPT, so the
 * provider retry an empty completion buys (C92) is a second timeline beside
 * the first rather than time smeared over one.
 */
import { appendFile, mkdir, readdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import type { SessionSchedulerSnapshot } from './session-scheduler.js';

/**
 * The phases a turn is cut into.
 *
 * `queue-wait` … `publish` are sequential and sum to roughly the turn's total.
 * `tool-work` is the exception: it is NESTED inside the MODEL phases — the
 * window from the prompt leaving to the prompt resolving, which is
 * `first-model-output` plus `model-stream` together. It is deliberately not
 * nested in `model-stream` alone: a harness routinely runs tools BEFORE it says
 * anything, and a measured turn where tool-work exceeded model-stream is what
 * showed that. The phases therefore do not add up and must not be summed.
 */
export const TURN_PHASES = [
  /** Enqueued on `SessionScheduler` until this turn holds a slot. A capacity wait lives here. */
  'queue-wait',
  /** `lifecycle.activate()`: the ACP spawn and `session/new`. Zero on a warm session. */
  'activation',
  /** Room conversation, Workspace roster and attachment downloads, before the prompt. */
  'context-fetch',
  /** `session/prompt` sent until the first assistant text chunk arrives. */
  'first-model-output',
  /** First chunk until the prompt resolves: the rest of the model's answer, tools included. */
  'model-stream',
  /** Union of the intervals with at least one tool call outstanding. Nested in the model phases. */
  'tool-work',
  /** The durable reply write that settles the turn. */
  'publish',
] as const;
export type TurnPhase = (typeof TURN_PHASES)[number];

/** One attempt at a turn: the first, plus one per provider re-pin (C92). */
export interface TurnAttemptTrace {
  /** `<requestId>#<attempt>` — stable, and the retry is addressable on its own. */
  attemptId: string;
  attempt: number;
  /**
   * Whether this attempt had to spawn a harness. `cold` means `activate()` ran
   * a real ACP handshake; `warm` means the scheduler handed back a live
   * session and `activation` is zero.
   */
  activation: 'cold' | 'warm';
  /** True when the scheduler reported `waiting-for-slot` before admitting this turn. */
  capacityWait?: boolean;
  /** The OpenRouter provider this attempt was re-pinned to, when it is a retry. */
  provider?: string;
  /** Why the previous attempt did not answer, when this attempt is its retry. */
  retryReason?: string;
  /** Milliseconds per phase, monotonic. A phase that never ran is absent, not zero. */
  phases: Partial<Record<TurnPhase, number>>;
  /** Distinct tool calls the harness reported during this attempt. */
  toolCalls: number;
}

export interface TurnTraceRecord {
  version: 1;
  surface: 'room' | 'corner';
  agentId: string;
  roomId: string;
  requestId: string;
  /** Wall clock at admission, for correlation only — never subtracted (see the header). */
  startedAt: string;
  outcome: 'complete' | 'failed';
  /** The distilled failure reason, when the turn failed. */
  reason?: string;
  /** Monotonic total for the whole turn, this process's clock. */
  totalMs: number;
  attempts: TurnAttemptTrace[];
  /**
   * The scheduler's own `snapshot()`, read twice: as the turn was enqueued and
   * again once it was admitted. A long `queue-wait` beside a full snapshot is
   * a capacity wait; a long one beside an empty snapshot is not.
   */
  scheduler: {
    atQueue?: SessionSchedulerSnapshot;
    atAdmission?: SessionSchedulerSnapshot;
  };
}

export interface TurnTraceSink {
  write(record: TurnTraceRecord): Promise<void>;
}

/** A tool call is outstanding until the harness gives it a terminal status. */
function toolCallOutstanding(call: { status?: string }): boolean {
  return !/^(?:completed|complete|failed|error|succeeded|success|passed|done|rejected|denied|cancelled|canceled)$/i.test(
    call.status ?? '',
  );
}

interface MutableAttempt {
  attempt: number;
  activation: 'cold' | 'warm';
  capacityWait: boolean;
  provider?: string;
  retryReason?: string;
  phases: Map<TurnPhase, number>;
  toolCallIds: Set<string>;
  promptSentAt?: number;
  firstOutputAt?: number;
  toolWorkOpenedAt?: number;
  settled?: boolean;
}

export interface TurnTraceOptions {
  surface: 'room' | 'corner';
  agentId: string;
  roomId: string;
  requestId: string;
  /** Where the finished record goes. Without one the trace is measured and dropped. */
  sink?: TurnTraceSink;
  /** Monotonic clock (test seam). Must be monotonic — never `Date.now`. */
  now?: () => number;
}

/**
 * One turn's stopwatch. Every method is total: a phase that never started, a
 * double `end`, a `finish` after a throw mid-activation — none of them raise,
 * because a diagnostic that can fail a turn is worse than no diagnostic.
 */
export class TurnTrace {
  private readonly now: () => number;
  private readonly startedAtWall = new Date().toISOString();
  private readonly begunAt: number;
  private readonly attempts: MutableAttempt[] = [];
  private readonly open = new Map<TurnPhase, number>();
  private atQueue?: SessionSchedulerSnapshot;
  private atAdmission?: SessionSchedulerSnapshot;
  private finished = false;

  constructor(private readonly options: TurnTraceOptions) {
    this.now = options.now ?? (() => performance.now());
    this.begunAt = this.now();
    this.attempts.push(this.newAttempt(1));
  }

  private newAttempt(attempt: number): MutableAttempt {
    return {
      attempt,
      activation: 'warm',
      capacityWait: false,
      phases: new Map(),
      toolCallIds: new Set(),
    };
  }

  private get current(): MutableAttempt {
    return this.attempts[this.attempts.length - 1]!;
  }

  private add(phase: TurnPhase, ms: number): void {
    const attempt = this.current;
    attempt.phases.set(phase, (attempt.phases.get(phase) ?? 0) + Math.max(0, ms));
  }

  /** Open a phase. A phase already open keeps its original start. */
  start(phase: TurnPhase): void {
    if (!this.open.has(phase)) this.open.set(phase, this.now());
  }

  /** Close a phase and accumulate it on the current attempt. A no-op when it never opened. */
  end(phase: TurnPhase): void {
    const openedAt = this.open.get(phase);
    if (openedAt === undefined) return;
    this.open.delete(phase);
    this.add(phase, this.now() - openedAt);
  }

  /** Time `run` as one phase, whether it resolves or throws. */
  async measure<T>(phase: TurnPhase, run: () => Promise<T>): Promise<T> {
    this.start(phase);
    try {
      return await run();
    } finally {
      this.end(phase);
    }
  }

  noteScheduler(where: 'queue' | 'admission', snapshot: SessionSchedulerSnapshot): void {
    if (where === 'queue') this.atQueue = snapshot;
    else this.atAdmission = snapshot;
  }

  /** The scheduler told this turn it was waiting for a slot: the wait is capacity, not the model. */
  noteCapacityWait(): void {
    this.current.capacityWait = true;
  }

  noteActivation(kind: 'cold' | 'warm'): void {
    this.current.activation = kind;
  }

  /** The prompt left for the harness. Idempotent: a steer resume is the same attempt. */
  promptSent(): void {
    this.current.promptSentAt ??= this.now();
  }

  /** The first assistant text chunk of this attempt landed. */
  firstModelOutput(): void {
    const attempt = this.current;
    if (attempt.firstOutputAt !== undefined || attempt.promptSentAt === undefined) return;
    attempt.firstOutputAt = this.now();
    attempt.phases.set('first-model-output', attempt.firstOutputAt - attempt.promptSentAt);
  }

  /**
   * The harness's tool-call snapshot for this attempt. `tool-work` is the
   * union of the intervals with at least one call outstanding — never a sum of
   * per-call times, which would double-count parallel calls. A harness that
   * never marks a call terminal therefore reads as "tools outstanding to the
   * end of the turn", which is exactly what happened.
   */
  toolCalls(calls: readonly { id?: string; status?: string }[]): void {
    const attempt = this.current;
    calls.forEach((call, index) => attempt.toolCallIds.add(call.id ?? `#${index}`));
    const outstanding = calls.some((call) => toolCallOutstanding(call));
    if (outstanding && attempt.toolWorkOpenedAt === undefined) {
      attempt.toolWorkOpenedAt = this.now();
    } else if (!outstanding && attempt.toolWorkOpenedAt !== undefined) {
      this.add('tool-work', this.now() - attempt.toolWorkOpenedAt);
      attempt.toolWorkOpenedAt = undefined;
    }
  }

  /** The prompt resolved (or gave up). Closes this attempt's model and tool windows. */
  promptSettled(): void {
    const attempt = this.current;
    if (attempt.settled) return;
    attempt.settled = true;
    const settledAt = this.now();
    if (attempt.toolWorkOpenedAt !== undefined) {
      this.add('tool-work', settledAt - attempt.toolWorkOpenedAt);
      attempt.toolWorkOpenedAt = undefined;
    }
    if (attempt.firstOutputAt !== undefined) {
      attempt.phases.set('model-stream', settledAt - attempt.firstOutputAt);
    } else if (attempt.promptSentAt !== undefined) {
      // Nothing was ever streamed: the whole wait belongs to the phase that
      // was measuring it, and there is no stream to attribute time to.
      attempt.phases.set('first-model-output', settledAt - attempt.promptSentAt);
    }
  }

  /**
   * Open the attempt a provider re-pin buys. Everything after this call —
   * including the re-pin's own `activate()` — belongs to the new attempt, so
   * the retry reads as its own timeline rather than as slow first-token time.
   */
  retry(input: { provider?: string; reason?: string } = {}): void {
    const next = this.newAttempt(this.current.attempt + 1);
    next.activation = 'cold';
    if (input.provider) next.provider = input.provider;
    if (input.reason) next.retryReason = input.reason;
    this.attempts.push(next);
  }

  /** The record as it stands, without writing it. */
  snapshot(outcome: 'complete' | 'failed', reason?: string): TurnTraceRecord {
    return {
      version: 1,
      surface: this.options.surface,
      agentId: this.options.agentId,
      roomId: this.options.roomId,
      requestId: this.options.requestId,
      startedAt: this.startedAtWall,
      outcome,
      ...(reason ? { reason } : {}),
      totalMs: round(this.now() - this.begunAt),
      attempts: this.attempts.map((attempt) => ({
        attemptId: `${this.options.requestId}#${attempt.attempt}`,
        attempt: attempt.attempt,
        activation: attempt.activation,
        ...(attempt.capacityWait ? { capacityWait: true } : {}),
        ...(attempt.provider ? { provider: attempt.provider } : {}),
        ...(attempt.retryReason ? { retryReason: attempt.retryReason } : {}),
        phases: Object.fromEntries(
          TURN_PHASES.filter((phase) => attempt.phases.has(phase)).map((phase) => [
            phase,
            round(attempt.phases.get(phase)!),
          ]),
        ),
        toolCalls: attempt.toolCallIds.size,
      })),
      scheduler: {
        ...(this.atQueue ? { atQueue: this.atQueue } : {}),
        ...(this.atAdmission ? { atAdmission: this.atAdmission } : {}),
      },
    };
  }

  /**
   * Close every open phase and hand the record to the sink. Called once, after
   * the turn's receipt, so it never delays an answer; failures are swallowed,
   * because losing a diagnostic must never fail a turn.
   */
  async finish(outcome: 'complete' | 'failed', reason?: string): Promise<TurnTraceRecord> {
    if (!this.finished) {
      this.finished = true;
      for (const phase of [...this.open.keys()]) this.end(phase);
      this.promptSettled();
    }
    const record = this.snapshot(outcome, reason);
    await this.options.sink?.write(record).catch((error) => {
      console.error('[thin-core] turn trace write failed:', error);
    });
    return record;
  }
}

function round(ms: number): number {
  return Math.round(ms * 10) / 10;
}

/** `1.90s`, `12ms` — a duration a human reads without converting units. */
export function formatDuration(ms: number): string {
  return ms >= 1_000 ? `${(ms / 1_000).toFixed(2)}s` : `${Math.round(ms)}ms`;
}

/**
 * One attempt as one line: the timeline an operator actually reads. `tool-work`
 * is marked as nested so nobody adds it to the sequential phases.
 */
export function formatTurnAttempt(attempt: TurnAttemptTrace): string {
  const parts = [`attempt ${attempt.attempt} ${attempt.activation}`];
  if (attempt.capacityWait) parts.push('capacity-wait');
  if (attempt.provider) parts.push(`provider ${attempt.provider}`);
  for (const phase of TURN_PHASES) {
    const value = attempt.phases[phase];
    if (value === undefined) continue;
    parts.push(
      phase === 'tool-work'
        ? `tool-work ${formatDuration(value)} (within model time)`
        : `${phase} ${formatDuration(value)}`,
    );
  }
  if (attempt.toolCalls) parts.push(`${attempt.toolCalls} tool call${attempt.toolCalls === 1 ? '' : 's'}`);
  return parts.join(' · ');
}

/** The compact per-turn operator log line. Never a Room row. */
export function formatTurnTraceLine(record: TurnTraceRecord): string {
  const head = `${record.surface} ${record.roomId} turn ${record.requestId} ${record.outcome} ${formatDuration(record.totalMs)}`;
  return [head, ...record.attempts.map((attempt) => formatTurnAttempt(attempt))].join('\n  ');
}

/** Where a daemon keeps its turn traces: `<runtimeDir>/turn-traces/`. */
export function turnTraceDirectory(runtimeDir: string): string {
  return resolve(runtimeDir, 'turn-traces');
}

/** Days of turn traces kept on disk. A diagnostic must not grow without bound. */
export const TURN_TRACE_RETENTION_DAYS = 7;

function traceFileName(date: Date): string {
  return `turns-${date.toISOString().slice(0, 10)}.jsonl`;
}

/**
 * The operator artifact: one JSON line per turn under the daemon's own runtime
 * directory, 0600, rotated daily and pruned after a week. Writes are
 * serialized so two concurrent Rooms cannot interleave half a line.
 */
export class TurnTraceFile implements TurnTraceSink {
  private tail: Promise<void> = Promise.resolve();
  private announced = false;
  private prunedDay?: string;

  constructor(
    private readonly directory: string,
    private readonly options: { log?: (line: string) => void; clock?: () => Date } = {},
  ) {}

  path(now = (this.options.clock ?? (() => new Date()))()): string {
    return resolve(this.directory, traceFileName(now));
  }

  write(record: TurnTraceRecord): Promise<void> {
    this.tail = this.tail
      .catch(() => undefined)
      .then(async () => {
        const now = (this.options.clock ?? (() => new Date()))();
        const path = this.path(now);
        await mkdir(this.directory, { recursive: true, mode: 0o700 });
        await appendFile(path, `${JSON.stringify(record)}\n`, { mode: 0o600 });
        await this.prune(now);
        const log = this.options.log ?? ((line: string) => console.log(line));
        log(
          `[thin-core] turn trace ${formatTurnTraceLine(record)}${
            this.announced ? '' : `\n  recorded in ${path}`
          }`,
        );
        this.announced = true;
      });
    return this.tail;
  }

  private async prune(now: Date): Promise<void> {
    const day = now.toISOString().slice(0, 10);
    if (this.prunedDay === day) return;
    this.prunedDay = day;
    const cutoff = traceFileName(new Date(now.getTime() - TURN_TRACE_RETENTION_DAYS * 86_400_000));
    const names = await readdir(this.directory).catch(() => [] as string[]);
    await Promise.all(
      names
        .filter((name) => /^turns-\d{4}-\d{2}-\d{2}\.jsonl$/.test(name) && name < cutoff)
        .map((name) => rm(resolve(this.directory, name), { force: true })),
    );
  }
}
