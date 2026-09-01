import { verifyEvent, type NostrEvent } from '@beeline/nostr';
import type { RoomViewMessage } from './room-view.js';
import { isRoomViewMessage } from './surface-guards.js';

export type SignedOutboxRecord = {
  readonly event: NostrEvent;
  readonly row: RoomViewMessage;
  /** Failed sends stay visible until the person retries or dismisses them. */
  readonly status: 'pending' | 'failed';
  readonly attempts: number;
};

export type SignedOutboxStorage = {
  readonly load: () => Promise<readonly SignedOutboxRecord[]>;
  readonly save: (records: readonly SignedOutboxRecord[]) => Promise<void>;
};

/** Durable exact-event outbox. Retries reuse the byte-identical prepared frame. */
export class SignedEventOutbox {
  private records: SignedOutboxRecord[] = [];

  constructor(
    private readonly storage: SignedOutboxStorage,
    private readonly validation: {
      readonly acceptUnsignedEvent?: (event: NostrEvent) => boolean;
    } = {},
  ) {}

  private accepts(event: NostrEvent): boolean {
    return (
      verifyEvent(event) ||
      (event.sig === '' && this.validation.acceptUnsignedEvent?.(event) === true)
    );
  }

  async restore(): Promise<void> {
    const records = await this.storage.load();
    this.records = records.filter(
      (record) =>
        record.event.id === record.row.id &&
        this.accepts(record.event) &&
        isRoomViewMessage(record.row) &&
        (record.status === 'pending' || record.status === 'failed') &&
        Number.isSafeInteger(record.attempts) &&
        record.attempts >= 0,
    );
    if (this.records.length !== records.length) await this.storage.save(this.records);
  }

  list(): readonly SignedOutboxRecord[] {
    return this.records;
  }

  async enqueue(event: NostrEvent, row: RoomViewMessage): Promise<void> {
    if (!this.accepts(event) || event.id !== row.id) {
      throw new Error('outbox requires one pre-signed event and its exact render id');
    }
    if (!this.records.some((record) => record.event.id === event.id)) {
      this.records.push({ event, row, status: 'pending', attempts: 0 });
      await this.storage.save(this.records);
    }
  }

  async attempted(eventId: string): Promise<void> {
    this.records = this.records.map((record) =>
      record.event.id === eventId ? { ...record, attempts: record.attempts + 1 } : record,
    );
    await this.storage.save(this.records);
  }

  get(eventId: string): SignedOutboxRecord | undefined {
    return this.records.find((record) => record.event.id === eventId);
  }

  async retry(eventId: string): Promise<void> {
    this.records = this.records.map((record) =>
      record.event.id === eventId
        ? { ...record, status: 'pending' as const, attempts: record.attempts + 1 }
        : record,
    );
    await this.storage.save(this.records);
  }

  async fail(eventId: string): Promise<void> {
    this.records = this.records.map((record) =>
      record.event.id === eventId ? { ...record, status: 'failed' as const } : record,
    );
    await this.storage.save(this.records);
  }

  async remove(eventId: string): Promise<void> {
    const next = this.records.filter((record) => record.event.id !== eventId);
    if (next.length === this.records.length) return;
    this.records = next;
    await this.storage.save(this.records);
  }

  async reconcile(authoritativeIds: ReadonlySet<string>): Promise<void> {
    const next = this.records.filter((record) => !authoritativeIds.has(record.event.id));
    if (next.length !== this.records.length) {
      this.records = next;
      await this.storage.save(this.records);
    }
  }
}
