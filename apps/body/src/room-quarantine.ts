export type RoomQuarantineKind =
  | 'active'
  | 'transport-backoff'
  | 'durable-backoff'
  | 'owner-grant-confirming'
  | 'owner-grant-backoff'
  | 'terminal-inert';

export interface RoomQuarantineRecord {
  roomId: string;
  kind: RoomQuarantineKind;
  reason: string;
  confirmations: number;
  changedAt: number;
  retryAt?: number;
}

export interface RoomQuarantineOptions {
  now?: () => number;
  random?: () => number;
  ownerGrantConfirmations?: number;
  transportBaseMs?: number;
  transportMaxMs?: number;
  ownerGrantBaseMs?: number;
  ownerGrantMaxMs?: number;
  onTransition?: (previous: RoomQuarantineRecord | undefined, next: RoomQuarantineRecord) => void;
}

const ARCHIVED = /channel is archived|archived channel/i;
const OWNER_GRANT = /owner_grant_needed|owner grant|installation.*grant/i;
const DURABLE = /local-only on another checkout/i;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function jitter(value: number, random: () => number): number {
  return Math.max(1, Math.round(value * (0.8 + random() * 0.4)));
}

/** One authoritative retry/quarantine record per Room; only state transitions are logged. */
export class RoomQuarantineStateMachine {
  readonly #records = new Map<string, RoomQuarantineRecord>();
  readonly #now: () => number;
  readonly #random: () => number;
  readonly #ownerGrantConfirmations: number;
  readonly #transportBaseMs: number;
  readonly #transportMaxMs: number;
  readonly #ownerGrantBaseMs: number;
  readonly #ownerGrantMaxMs: number;
  readonly #onTransition?: RoomQuarantineOptions['onTransition'];

  constructor(options: RoomQuarantineOptions = {}) {
    this.#now = options.now ?? Date.now;
    this.#random = options.random ?? Math.random;
    this.#ownerGrantConfirmations = options.ownerGrantConfirmations ?? 3;
    this.#transportBaseMs = options.transportBaseMs ?? 30_000;
    this.#transportMaxMs = options.transportMaxMs ?? 5 * 60_000;
    this.#ownerGrantBaseMs = options.ownerGrantBaseMs ?? 10 * 60_000;
    this.#ownerGrantMaxMs = options.ownerGrantMaxMs ?? 6 * 60 * 60_000;
    this.#onTransition = options.onTransition;
  }

  get(roomId: string): RoomQuarantineRecord | undefined {
    const record = this.#records.get(roomId);
    return record ? { ...record } : undefined;
  }

  mayAttempt(roomId: string): boolean {
    const record = this.#records.get(roomId);
    if (!record || record.kind === 'active') return true;
    if (record.kind === 'terminal-inert') return false;
    return this.#now() >= (record.retryAt ?? 0);
  }

  noteFailure(roomId: string, error: unknown): RoomQuarantineRecord {
    const reason = messageOf(error);
    const previous = this.#records.get(roomId);
    const now = this.#now();
    let next: RoomQuarantineRecord;
    if (ARCHIVED.test(reason)) {
      next = { roomId, kind: 'terminal-inert', reason, confirmations: 1, changedAt: now };
    } else if (DURABLE.test(reason)) {
      next = {
        roomId,
        kind: 'durable-backoff',
        reason,
        confirmations: (previous?.confirmations ?? 0) + 1,
        changedAt: now,
        retryAt: now + jitter(this.#ownerGrantBaseMs, this.#random),
      };
    } else if (OWNER_GRANT.test(reason)) {
      const confirmations =
        previous?.kind === 'owner-grant-backoff' || previous?.kind === 'owner-grant-confirming'
          ? previous.confirmations + 1
          : 1;
      const exponent = Math.max(0, confirmations - this.#ownerGrantConfirmations);
      const base =
        confirmations < this.#ownerGrantConfirmations
          ? this.#transportBaseMs
          : Math.min(this.#ownerGrantMaxMs, this.#ownerGrantBaseMs * 2 ** exponent);
      next = {
        roomId,
        kind:
          confirmations < this.#ownerGrantConfirmations
            ? 'owner-grant-confirming'
            : 'owner-grant-backoff',
        reason,
        confirmations,
        changedAt: now,
        retryAt: now + jitter(base, this.#random),
      };
    } else {
      const confirmations = previous?.kind === 'transport-backoff' ? previous.confirmations + 1 : 1;
      const base = Math.min(this.#transportMaxMs, this.#transportBaseMs * 2 ** (confirmations - 1));
      next = {
        roomId,
        kind: 'transport-backoff',
        reason,
        confirmations,
        changedAt: now,
        retryAt: now + jitter(base, this.#random),
      };
    }
    this.#set(previous, next);
    return { ...next };
  }

  noteArchived(roomId: string, reason: string): RoomQuarantineRecord {
    return this.noteFailure(roomId, new Error(`channel is archived: ${reason}`));
  }

  noteSuccess(roomId: string): void {
    const previous = this.#records.get(roomId);
    if (!previous || previous.kind === 'active' || previous.kind === 'terminal-inert') return;
    this.#set(previous, {
      roomId,
      kind: 'active',
      reason: 'Room recovered',
      confirmations: 0,
      changedAt: this.#now(),
    });
  }

  #set(previous: RoomQuarantineRecord | undefined, next: RoomQuarantineRecord): void {
    this.#records.set(next.roomId, next);
    if (previous?.kind === next.kind) return;
    this.#onTransition?.(previous ? { ...previous } : undefined, { ...next });
  }
}
