import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const EVENT_ID_RE = /^[0-9a-f]{64}$/;
const PUBKEY_RE = /^[0-9a-f]{64}$/;
const DEFAULT_RETENTION_MS = 30 * 24 * 60 * 60_000;
const DEFAULT_MAX_EVENTS = 50_000;

type AttemptStatus = 'attempted' | 'delivered';

interface DeliveryAttempt {
  pubkey: string;
  attemptedAt: number;
  deliveredAt?: number;
  status: AttemptStatus;
}

interface DeliveredEvent {
  eventId: string;
  eventCreatedAt: number;
  recipients: DeliveryAttempt[];
}

interface RecipientCursor {
  pubkey: string;
  throughCreatedAt: number;
}

interface DeliveryStateFile {
  version: 1;
  cursors: RecipientCursor[];
  events: DeliveredEvent[];
}

/**
 * Durable at-most-once notification state.
 *
 * An event/recipient attempt is persisted before FCM is called. Both attempted
 * and delivered records are terminal on replay: an ambiguous FCM response may
 * lose one notification, but it can never cause a duplicate. Durable recipient
 * cursors remain after old event records are pruned, so bounded history cannot
 * make an old relay backlog eligible again.
 */
export class DeliveryState {
  private readonly cursors = new Map<string, number>();
  private readonly events = new Map<string, Map<string, DeliveryAttempt>>();
  private readonly eventCreatedAt = new Map<string, number>();

  private constructor(
    private readonly filePath?: string,
    private readonly now: () => number = Date.now,
    private readonly retentionMs = DEFAULT_RETENTION_MS,
    private readonly maxEvents = DEFAULT_MAX_EVENTS,
  ) {}

  static async load(
    filePath?: string,
    options: { now?: () => number; retentionMs?: number; maxEvents?: number } = {},
  ): Promise<DeliveryState> {
    const state = new DeliveryState(filePath, options.now, options.retentionMs, options.maxEvents);
    if (!filePath) return state;

    try {
      const parsed = JSON.parse(await readFile(filePath, 'utf8')) as DeliveryStateFile;
      if (parsed.version !== 1 || !Array.isArray(parsed.cursors) || !Array.isArray(parsed.events)) {
        throw new Error('unsupported delivery state format');
      }
      for (const cursor of parsed.cursors) {
        if (PUBKEY_RE.test(cursor.pubkey) && Number.isSafeInteger(cursor.throughCreatedAt)) {
          state.cursors.set(cursor.pubkey, cursor.throughCreatedAt);
        }
      }
      for (const entry of parsed.events) {
        if (!EVENT_ID_RE.test(entry.eventId) || !Number.isSafeInteger(entry.eventCreatedAt))
          continue;
        const recipients = new Map<string, DeliveryAttempt>();
        for (const attempt of entry.recipients ?? []) {
          if (
            PUBKEY_RE.test(attempt.pubkey) &&
            Number.isSafeInteger(attempt.attemptedAt) &&
            (attempt.status === 'attempted' || attempt.status === 'delivered')
          ) {
            recipients.set(attempt.pubkey, attempt);
          }
        }
        if (recipients.size > 0) {
          state.events.set(entry.eventId, recipients);
          state.eventCreatedAt.set(entry.eventId, entry.eventCreatedAt);
        }
      }
      if (state.prune()) await state.persist();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    return state;
  }

  cursorFor(pubkey: string, fallback: number): number {
    return this.cursors.get(pubkey) ?? fallback;
  }

  isBehindCursor(pubkey: string, eventCreatedAt: number): boolean {
    const cursor = this.cursors.get(pubkey);
    return cursor !== undefined && eventCreatedAt <= cursor;
  }

  hasAttempt(eventId: string, pubkey: string): boolean {
    return this.events.get(eventId)?.has(pubkey) ?? false;
  }

  async reserveAttempt(eventId: string, eventCreatedAt: number, pubkey: string): Promise<boolean> {
    if (this.hasAttempt(eventId, pubkey) || this.isBehindCursor(pubkey, eventCreatedAt))
      return false;

    const recipients = this.events.get(eventId) ?? new Map<string, DeliveryAttempt>();
    const attempt: DeliveryAttempt = {
      pubkey,
      attemptedAt: this.now(),
      status: 'attempted',
    };
    recipients.set(pubkey, attempt);
    this.events.set(eventId, recipients);
    this.eventCreatedAt.set(eventId, eventCreatedAt);
    try {
      await this.persist();
      return true;
    } catch (error) {
      recipients.delete(pubkey);
      if (recipients.size === 0) {
        this.events.delete(eventId);
        this.eventCreatedAt.delete(eventId);
      }
      throw error;
    }
  }

  async markDelivered(eventId: string, pubkey: string): Promise<void> {
    const attempt = this.events.get(eventId)?.get(pubkey);
    if (!attempt || attempt.status === 'delivered') return;
    attempt.status = 'delivered';
    attempt.deliveredAt = this.now();
    await this.persist();
  }

  async advanceCursor(pubkey: string, throughCreatedAt: number): Promise<void> {
    const current = this.cursors.get(pubkey) ?? 0;
    if (throughCreatedAt <= current) return;
    this.cursors.set(pubkey, throughCreatedAt);
    this.prune();
    await this.persist();
  }

  private prune(): boolean {
    const sizeBefore = this.events.size;
    const expiry = this.now() - this.retentionMs;
    const safelyPrunable = [...this.events.keys()]
      .filter((eventId) => {
        const createdAt = this.eventCreatedAt.get(eventId) ?? 0;
        const recipients = this.events.get(eventId);
        return (
          recipients !== undefined &&
          [...recipients.values()].every(
            (attempt) => (this.cursors.get(attempt.pubkey) ?? 0) >= createdAt,
          )
        );
      })
      .sort(
        (left, right) =>
          (this.eventCreatedAt.get(left) ?? 0) - (this.eventCreatedAt.get(right) ?? 0),
      );

    const removals = new Set(
      safelyPrunable.filter((eventId) =>
        [...(this.events.get(eventId)?.values() ?? [])].every(
          (attempt) => attempt.attemptedAt < expiry,
        ),
      ),
    );
    const targetRemovalCount = Math.max(0, this.events.size - this.maxEvents);
    for (const eventId of safelyPrunable) {
      if (removals.size >= targetRemovalCount) break;
      removals.add(eventId);
    }
    for (const eventId of removals) {
      this.events.delete(eventId);
      this.eventCreatedAt.delete(eventId);
    }
    return this.events.size !== sizeBefore;
  }

  private async persist(): Promise<void> {
    if (!this.filePath) return;
    const directory = dirname(this.filePath);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const value: DeliveryStateFile = {
      version: 1,
      cursors: [...this.cursors].map(([pubkey, throughCreatedAt]) => ({
        pubkey,
        throughCreatedAt,
      })),
      events: [...this.events].map(([eventId, recipients]) => ({
        eventId,
        eventCreatedAt: this.eventCreatedAt.get(eventId) ?? 0,
        recipients: [...recipients.values()],
      })),
    };
    const temporaryPath = `${this.filePath}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(value)}\n`, { mode: 0o600 });
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, this.filePath);
  }
}
