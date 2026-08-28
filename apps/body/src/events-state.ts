import type { NostrEvent } from '@beeline/nostr';

export interface PendingRepositoryDelivery {
  /** GitHub ids covered by this delivery, including filtered/noise events. */
  sourceEventIds: string[];
  /** Newest GitHub event observed by the poll that created this delivery. */
  cursor: string;
  cards: Array<{ roomId: string; event: NostrEvent; published: boolean }>;
}

export interface RepositoryIngestionRecord {
  cursor?: string;
  seenEventIds: string[];
  lastSuccessfulPollAt?: string;
  nextPollAt: number;
  idlePolls: number;
  consecutiveFailures: number;
  lastError?: string;
  degradedNoticePublished: boolean;
  degradedNotice?: {
    cards: Array<{ roomId: string; event: NostrEvent; published: boolean }>;
  };
  pending?: PendingRepositoryDelivery;
}

export interface EventsStateData {
  version: 1;
  repositories: Record<string, RepositoryIngestionRecord>;
}

export interface RepositoryEventsStatePersistence {
  load(): Promise<unknown | undefined>;
  save(value: EventsStateData): Promise<void>;
}

const MAX_SEEN_EVENT_IDS = 2_000;

function emptyRecord(): RepositoryIngestionRecord {
  return {
    seenEventIds: [],
    nextPollAt: 0,
    idlePolls: 0,
    consecutiveFailures: 0,
    degradedNoticePublished: false,
  };
}

/**
 * Single-writer, atomic state for the repository-event service.
 *
 * A pending signed relay event is persisted before the first publish. Retrying
 * after an ambiguous relay response therefore republishes the same Nostr id.
 */
export class RepositoryEventsState {
  private data: EventsStateData = { version: 1, repositories: {} };
  private loaded = false;
  private saveTail: Promise<void> = Promise.resolve();

  constructor(private readonly persistence: RepositoryEventsStatePersistence) {}

  async load(): Promise<void> {
    if (this.loaded) return;
    const value = await this.persistence.load();
    if (value !== undefined) {
      const parsed = value as EventsStateData;
      if (parsed.version !== 1 || !parsed.repositories) {
        throw new Error('unsupported repository-event state');
      }
      this.data = parsed;
      for (const record of Object.values(this.data.repositories)) {
        record.seenEventIds ??= [];
        record.nextPollAt ??= 0;
        record.idlePolls ??= 0;
        record.consecutiveFailures ??= 0;
        record.degradedNoticePublished ??= false;
      }
    }
    this.loaded = true;
  }

  async record(key: string): Promise<RepositoryIngestionRecord> {
    await this.load();
    return (this.data.repositories[key] ??= emptyRecord());
  }

  async reserve(key: string, pending: PendingRepositoryDelivery): Promise<void> {
    const record = await this.record(key);
    if (record.pending) return;
    record.pending = pending;
    await this.save();
  }

  async markCardPublished(key: string, roomId: string): Promise<void> {
    const record = await this.record(key);
    const card = record.pending?.cards.find((candidate) => candidate.roomId === roomId);
    if (!card || card.published) return;
    card.published = true;
    await this.save();
  }

  async complete(
    key: string,
    input: {
      cursor: string;
      sourceEventIds: readonly string[];
      now: number;
      nextPollAt: number;
      active: boolean;
    },
  ): Promise<void> {
    const record = await this.record(key);
    record.cursor = input.cursor;
    record.seenEventIds = [...new Set([...input.sourceEventIds, ...record.seenEventIds])].slice(
      0,
      MAX_SEEN_EVENT_IDS,
    );
    record.lastSuccessfulPollAt = new Date(input.now).toISOString();
    record.nextPollAt = input.nextPollAt;
    record.idlePolls = input.active ? 0 : Math.min(16, record.idlePolls + 1);
    record.consecutiveFailures = 0;
    delete record.lastError;
    record.degradedNoticePublished = false;
    delete record.degradedNotice;
    delete record.pending;
    await this.save();
  }

  async fail(key: string, error: unknown, nextPollAt: number): Promise<number> {
    const record = await this.record(key);
    record.consecutiveFailures += 1;
    record.lastError = (error instanceof Error ? error.message : String(error)).slice(0, 500);
    record.nextPollAt = nextPollAt;
    await this.save();
    return record.consecutiveFailures;
  }

  async markDegradedNoticePublished(key: string): Promise<void> {
    const record = await this.record(key);
    record.degradedNoticePublished = true;
    delete record.degradedNotice;
    await this.save();
  }

  async reserveDegradedNotice(
    key: string,
    cards: Array<{ roomId: string; event: NostrEvent; published: boolean }>,
  ): Promise<void> {
    const record = await this.record(key);
    if (record.degradedNoticePublished || record.degradedNotice) return;
    record.degradedNotice = { cards };
    await this.save();
  }

  async markDegradedCardPublished(key: string, roomId: string): Promise<void> {
    const record = await this.record(key);
    const card = record.degradedNotice?.cards.find((candidate) => candidate.roomId === roomId);
    if (!card || card.published) return;
    card.published = true;
    await this.save();
  }

  async snapshot(): Promise<Record<string, RepositoryIngestionRecord>> {
    await this.load();
    return structuredClone(this.data.repositories);
  }

  private save(): Promise<void> {
    this.saveTail = this.saveTail.then(() => this.persistence.save(this.data));
    return this.saveTail;
  }
}
