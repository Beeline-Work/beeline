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

interface StandingAttention {
  pubkey: string;
  sourceId: string;
  reason: string;
}

export interface DeliveryStateFile {
  version: 1;
  cursors: RecipientCursor[];
  events: DeliveredEvent[];
  attentions?: StandingAttention[];
}

export interface DeliveryStatePersistence {
  load(): Promise<unknown | undefined>;
  save(value: DeliveryStateFile): Promise<void>;
}

export interface AttentionAttempt {
  eventId: string;
  eventCreatedAt: number;
  pubkey: string;
  sourceId: string;
  reason: string;
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
  private readonly attentions = new Map<string, StandingAttention>();

  private constructor(
    private readonly persistence?: DeliveryStatePersistence,
    private readonly now: () => number = Date.now,
    private readonly retentionMs = DEFAULT_RETENTION_MS,
    private readonly maxEvents = DEFAULT_MAX_EVENTS,
  ) {}

  static async load(
    persistence?: DeliveryStatePersistence,
    options: { now?: () => number; retentionMs?: number; maxEvents?: number } = {},
  ): Promise<DeliveryState> {
    const state = new DeliveryState(
      persistence,
      options.now,
      options.retentionMs,
      options.maxEvents,
    );
    if (!persistence) return state;

    const value = await persistence.load();
    if (value !== undefined) {
      const parsed = value as DeliveryStateFile;
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
      for (const attention of Array.isArray(parsed.attentions) ? parsed.attentions : []) {
        if (
          PUBKEY_RE.test(attention.pubkey) &&
          attention.sourceId &&
          typeof attention.reason === 'string'
        ) {
          state.attentions.set(state.attentionKey(attention), attention);
        }
      }
      if (state.prune()) await state.persist();
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

  /**
   * Atomically claims both a concrete relay event and its semantic attention
   * episode. The first attempt permanently spends the episode until an
   * explicit lifecycle resolution clears it, regardless of copy or delivery.
   */
  async reserveAttentionAttempt(attempt: AttentionAttempt): Promise<boolean> {
    if (
      this.hasAttempt(attempt.eventId, attempt.pubkey) ||
      this.isBehindCursor(attempt.pubkey, attempt.eventCreatedAt)
    ) {
      return false;
    }

    const key = this.attentionKey(attempt);
    const standing = this.attentions.get(key);
    const now = this.now();
    const eligible = !standing;
    const recipients = this.events.get(attempt.eventId) ?? new Map<string, DeliveryAttempt>();
    recipients.set(attempt.pubkey, {
      pubkey: attempt.pubkey,
      attemptedAt: now,
      status: 'attempted',
    });
    this.events.set(attempt.eventId, recipients);
    this.eventCreatedAt.set(attempt.eventId, attempt.eventCreatedAt);
    if (eligible) {
      this.attentions.set(key, {
        pubkey: attempt.pubkey,
        sourceId: attempt.sourceId,
        reason: attempt.reason,
      });
    }

    try {
      await this.persist();
      return eligible;
    } catch (error) {
      recipients.delete(attempt.pubkey);
      if (recipients.size === 0) {
        this.events.delete(attempt.eventId);
        this.eventCreatedAt.delete(attempt.eventId);
      }
      if (eligible) {
        this.attentions.delete(key);
      }
      throw error;
    }
  }

  /** A canonical non-waiting lifecycle record ends every attention reason for this episode. */
  async clearAttention(sourceId: string, pubkey: string): Promise<void> {
    const removed: Array<[string, StandingAttention]> = [];
    for (const [key, attention] of this.attentions) {
      if (attention.sourceId === sourceId && attention.pubkey === pubkey) {
        this.attentions.delete(key);
        removed.push([key, attention]);
      }
    }
    if (removed.length === 0) return;
    try {
      await this.persist();
    } catch (error) {
      for (const [key, attention] of removed) this.attentions.set(key, attention);
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

  private attentionKey(
    attention: Pick<StandingAttention, 'pubkey' | 'sourceId' | 'reason'>,
  ): string {
    return [attention.pubkey, attention.sourceId, attention.reason].join('\u0000');
  }

  private async persist(): Promise<void> {
    if (!this.persistence) return;
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
      attentions: [...this.attentions.values()],
    };
    await this.persistence.save(value);
  }
}
