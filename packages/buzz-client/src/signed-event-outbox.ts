import { verifyEvent, type NostrEvent } from '@beeline/nostr';
import type { RoomViewMessage } from './room-view.js';

export type SignedOutboxRecord = {
  readonly event: NostrEvent;
  readonly row: RoomViewMessage;
  readonly attempts: number;
};

export type SignedOutboxStorage = {
  readonly load: () => Promise<readonly SignedOutboxRecord[]>;
  readonly save: (records: readonly SignedOutboxRecord[]) => Promise<void>;
};

/** Durable exact-event outbox. Retries reuse the byte-identical signed frame. */
export class SignedEventOutbox {
  private records: SignedOutboxRecord[] = [];

  constructor(private readonly storage: SignedOutboxStorage) {}

  async restore(): Promise<void> {
    const records = await this.storage.load();
    this.records = records.filter((record) =>
      record.event.id === record.row.id && verifyEvent(record.event));
  }

  list(): readonly SignedOutboxRecord[] {
    return this.records;
  }

  async enqueue(event: NostrEvent, row: RoomViewMessage): Promise<void> {
    if (!verifyEvent(event) || event.id !== row.id) {
      throw new Error('outbox requires one pre-signed event and its exact render id');
    }
    if (!this.records.some((record) => record.event.id === event.id)) {
      this.records.push({ event, row, attempts: 0 });
      await this.storage.save(this.records);
    }
  }

  async attempted(eventId: string): Promise<void> {
    this.records = this.records.map((record) => record.event.id === eventId
      ? { ...record, attempts: record.attempts + 1 }
      : record);
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
