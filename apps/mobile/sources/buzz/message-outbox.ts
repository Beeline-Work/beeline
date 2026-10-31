import { SignedEventOutbox, type SignedOutboxRecord, type RoomViewMessage } from '@beeline/buzz-client';
import type { NostrEvent } from '@beeline/nostr';
import type { AgentMessageWriteResult } from '@beeline/api-contract/phone';
import { isUnsignedMonolithMessage } from './unsigned-monolith-message';

export type MessageOutboxRecord = SignedOutboxRecord & { queuedAt: number; reason?: string; offlineSince?: number; seen?: boolean };
export type MessageSendState = { kind: 'sending' | 'offline' | 'refused'; text: string };
export const OUTBOX_OFFLINE_CUTOFF_MS = 120_000;
export const outboxRoomId = (record: Pick<MessageOutboxRecord, 'event'>) => record.event.tags.find(tag => tag[0] === 'h')?.[1];

/** The app owns delivery; Room handles only select records for presentation. */
export class MessageOutbox {
  private records: MessageOutboxRecord[] = [];
  private restoring?: Promise<void>;
  private writes: Promise<void> = Promise.resolve();
  private readonly listeners = new Set<() => void>();
  private readonly flights = new Map<string, Promise<AgentMessageWriteResult | undefined>>();
  private cutoff?: ReturnType<typeof setTimeout>;
  private connected = false;
  private disposed = false;
  private epoch = 0;
  constructor(private readonly deps: {
    load(): Promise<readonly MessageOutboxRecord[]>;
    save(records: readonly MessageOutboxRecord[]): Promise<void>;
    send(event: NostrEvent): Promise<AgentMessageWriteResult>;
    rejection(error: unknown): string | undefined;
    now?: () => number;
  }) {}
  private now() { return this.deps.now?.() ?? Date.now(); }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  snapshot = () => this.records;
  private publish() { for (const listener of this.listeners) listener(); }
  private save(): Promise<void> {
    const records = this.records;
    const write = this.writes.catch(() => undefined).then(() => this.deps.save(records));
    this.writes = write;
    this.publish();
    this.scheduleCutoff();
    return write;
  }
  restore(): Promise<void> {
    return this.restoring ??= (async () => {
      const stored = await this.deps.load();
      const validator = new SignedEventOutbox({ load: async () => stored, save: async () => undefined }, { acceptUnsignedEvent: isUnsignedMonolithMessage });
      await validator.restore();
      this.records = [...new Map(validator.list().filter(record => outboxRoomId(record)).map(record => [record.event.id, {
        ...record, queuedAt: (record as MessageOutboxRecord).queuedAt ?? this.now(),
        // Old failed records represented exhausted network retries, not refusals.
        status: (record as MessageOutboxRecord).reason ? 'failed' as const : 'pending' as const,
      }])).values()];
      await this.save();
    })();
  }
  list(roomId?: string): readonly MessageOutboxRecord[] { return this.records.filter(record => !roomId || outboxRoomId(record) === roomId); }
  get(id: string) { return this.records.find(record => record.event.id === id); }
  async enqueue(event: NostrEvent, row: RoomViewMessage): Promise<void> {
    await this.restore();
    const validator = new SignedEventOutbox({ load: async () => [], save: async () => undefined }, { acceptUnsignedEvent: isUnsignedMonolithMessage });
    await validator.enqueue(event, row);
    if (this.get(event.id)) return;
    this.records = [...this.records, { event, row, status: 'pending', attempts: 0, queuedAt: this.now(), ...(!this.connected ? { offlineSince: this.now() } : {}) }];
    await this.save();
  }
  async remove(id: string) { this.records = this.records.filter(record => record.event.id !== id); await this.save(); }
  async reconcile(ids: ReadonlySet<string>) {
    if (!this.records.some(record => ids.has(record.event.id))) return;
    this.records = this.records.filter(record => !ids.has(record.event.id)); await this.save();
  }
  async acknowledgeFailures(roomId: string) {
    if (!this.records.some(record => outboxRoomId(record) === roomId && record.reason && !record.seen)) return;
    this.records = this.records.map(record => outboxRoomId(record) === roomId && record.reason ? { ...record, seen: true } : record);
    await this.save();
  }
  async fail(id: string, reason?: string) {
    if (!reason) return; // A transport failure never rejects a message.
    this.records = this.records.map(record => record.event.id === id ? { ...record, status: 'failed', reason } : record);
    await this.save();
  }
  state(id: string): MessageSendState | undefined {
    const record = this.get(id);
    if (!record) return;
    if (record.reason) return { kind: 'refused', text: `Not sent · ${record.reason}` };
    if (record.offlineSince !== undefined && this.now() - record.offlineSince >= OUTBOX_OFFLINE_CUTOFF_MS)
      return { kind: 'offline', text: 'Not sent yet · no connection' };
    return { kind: 'sending', text: 'Sending' };
  }
  /** Called by the shared connection owner on open and observed transport loss. */
  async connectionChanged(connected: boolean): Promise<void> {
    await this.restore();
    if (this.disposed) return;
    this.connected = connected;
    if (connected) this.epoch += 1;
    this.records = this.records.map(record => ({ ...record, offlineSince: connected ? undefined : record.offlineSince ?? this.now() }));
    await this.save();
    if (connected) await this.flush();
  }
  async flush(): Promise<void> {
    await this.restore();
    if (!this.connected || this.disposed) return;
    await Promise.all(this.records.filter(record => record.status === 'pending').map(record => this.send(record.event.id)));
  }
  send(id: string): Promise<AgentMessageWriteResult | undefined> {
    const held = this.flights.get(id);
    if (held) return held;
    const work = this.deliver(id).finally(() => this.flights.delete(id));
    this.flights.set(id, work);
    return work;
  }
  private async deliver(id: string): Promise<AgentMessageWriteResult | undefined> {
    await this.restore();
    if (!this.connected || this.disposed) return;
    const record = this.get(id);
    if (!record || record.status !== 'pending') return;
    const epoch = this.epoch;
    try {
      const result = await this.deps.send(record.event);
      if (this.disposed) return;
      await this.remove(id);
      return result;
    } catch (error) {
      if (this.disposed) return;
      const reason = this.deps.rejection(error);
      if (reason) await this.fail(id, reason);
      // A reconnect may have arrived while the old request was settling.
      else if (this.connected && epoch !== this.epoch) return this.deliver(id);
      return;
    }
  }
  private scheduleCutoff() {
    if (this.cutoff) clearTimeout(this.cutoff);
    const future = this.records.filter(record => !record.reason && record.offlineSince !== undefined)
      .map(record => record.offlineSince! + OUTBOX_OFFLINE_CUTOFF_MS - this.now()).filter(delay => delay > 0);
    if (!future.length || this.disposed) return;
    this.cutoff = setTimeout(() => { this.records = [...this.records]; this.publish(); this.scheduleCutoff(); }, Math.min(...future));
  }
  dispose() { this.disposed = true; if (this.cutoff) clearTimeout(this.cutoff); this.listeners.clear(); }
}
