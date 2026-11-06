import { SignedEventOutbox, type SignedOutboxRecord, type RoomViewMessage } from '@beeline/buzz-client';
import type { NostrEvent } from '@beeline/nostr';
import type { AgentMessageWriteResult } from '@beeline/api-contract/phone';
import { isUnsignedMonolithMessage } from './unsigned-monolith-message';

export type MessageOutboxRecord = SignedOutboxRecord & { queuedAt: number; reason?: string; failure?: 'connection' | 'refused'; seen?: boolean };
export type MessageSendState = { kind: 'sending' | 'offline' | 'refused'; text: string; reason?: string };
export const outboxRoomId = (record: Pick<MessageOutboxRecord, 'event'>) => record.event.tags.find(tag => tag[0] === 'h')?.[1];

/** The app owns delivery; Room handles only select records for presentation. */
export class MessageOutbox {
  private records: MessageOutboxRecord[] = [];
  private restoring?: Promise<void>;
  private writes: Promise<void> = Promise.resolve();
  private readonly listeners = new Set<() => void>();
  private readonly flights = new Map<string, Promise<AgentMessageWriteResult | undefined>>();
  private connected = false;
  private disposed = false;
  private epoch = 0;
  constructor(private readonly deps: {
    load(): Promise<readonly MessageOutboxRecord[]>;
    save(records: readonly MessageOutboxRecord[]): Promise<void>;
    send(event: NostrEvent): Promise<AgentMessageWriteResult>;
    sendWithCause?(event: NostrEvent, cause: 'send' | 'reconnect'): Promise<AgentMessageWriteResult>;
    rejection(error: unknown): string | undefined;
    now?: () => number;
  }) {}
  private now() { return this.deps.now?.() ?? Date.now(); }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  snapshot = () => this.records;
  private publish() { for (const listener of this.listeners) listener(); }
  private save(): Promise<void> {
    const write = this.writes.catch(() => undefined).then(() => this.deps.save(this.records));
    this.writes = write;
    this.publish();
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
        status: (record as MessageOutboxRecord).reason || (record as MessageOutboxRecord).failure ? 'failed' as const : 'pending' as const,
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
    const write = this.writes
      .catch(() => undefined)
      .then(async () => {
        if (this.get(event.id)) return;
        const record: MessageOutboxRecord = {
          event,
          row,
          status: 'pending',
          attempts: 0,
          queuedAt: this.now(),
        };
        // Only durable records may be published, delivered, or included in later saves.
        await this.deps.save([...this.records, record]);
        this.records = [...this.records, record];
        this.publish();
      });
    this.writes = write;
    await write;
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
    if (this.disposed) return;
    this.records = this.records.map(record => record.event.id === id
      ? { ...record, status: 'failed', failure: reason ? 'refused' : 'connection', reason } : record);
    await this.save();
  }
  async retry(ids: readonly string[]): Promise<readonly (AgentMessageWriteResult | undefined)[]> {
    await this.restore();
    await Promise.all(ids.map(id => this.flights.get(id)));
    const selected = new Set(ids);
    let failedIds: string[] = [];
    const write = this.writes.catch(() => undefined).then(async () => {
      if (this.disposed) return;
      const failed = new Set(this.records.filter(record => selected.has(record.event.id) && record.status === 'failed').map(record => record.event.id));
      if (!failed.size) return;
      const next = this.records.map(record => failed.has(record.event.id)
        ? { ...record, status: 'pending' as const, failure: undefined, reason: undefined, seen: undefined } : record);
      await this.deps.save(next);
      this.records = this.records.map(record => failed.has(record.event.id)
        ? { ...record, status: 'pending', failure: undefined, reason: undefined, seen: undefined } : record);
      failedIds = [...failed];
      this.publish();
    });
    this.writes = write;
    await write;
    // A person's explicit Retry owns an attempt even while the socket is down.
    return Promise.all(failedIds.map(id => this.startDelivery(id, 'send', true)));
  }
  state(id: string): MessageSendState | undefined {
    const record = this.get(id);
    if (!record) return;
    if (record.reason) return { kind: 'refused', text: `Not sent: ${record.reason}`, reason: record.reason };
    if (record.status === 'failed') return { kind: 'offline', text: 'Not sent' };
    return { kind: 'sending', text: 'Sending' };
  }
  /** Called by the shared connection owner on open and observed transport loss. */
  async connectionChanged(connected: boolean): Promise<void> {
    await this.restore();
    if (this.disposed) return;
    // A confirming answer on an already connected socket is not a new epoch.
    if (connected && !this.connected) this.epoch += 1;
    this.connected = connected;
    await this.save();
    if (connected) await this.flush();
  }
  async flush(): Promise<void> {
    await this.restore();
    if (!this.connected || this.disposed) return;
    await Promise.all(this.records.filter(record => record.status === 'pending').map(record => this.send(record.event.id, 'reconnect')));
  }
  send(id: string, cause: 'send' | 'reconnect' = 'send'): Promise<AgentMessageWriteResult | undefined> {
    return this.startDelivery(id, cause);
  }
  private startDelivery(id: string, cause: 'send' | 'reconnect', allowDisconnected = false): Promise<AgentMessageWriteResult | undefined> {
    const held = this.flights.get(id);
    if (held) return held;
    const work = this.deliver(id, cause, allowDisconnected).finally(() => this.flights.delete(id));
    this.flights.set(id, work);
    return work;
  }
  private async deliver(id: string, cause: 'send' | 'reconnect', allowDisconnected = false): Promise<AgentMessageWriteResult | undefined> {
    await this.restore();
    if ((!this.connected && !allowDisconnected) || this.disposed) return;
    const record = this.get(id);
    if (!record || record.status !== 'pending') return;
    const epoch = this.epoch;
    try {
      const result = await (this.deps.sendWithCause
        ? this.deps.sendWithCause(record.event, cause) : this.deps.send(record.event));
      if (this.disposed) return;
      await this.remove(id);
      return result;
    } catch (error) {
      if (this.disposed) return;
      const reason = this.deps.rejection(error);
      if (reason) await this.fail(id, reason);
      // A reconnect may have arrived while the old request was settling.
      else if (this.connected && epoch !== this.epoch) return this.deliver(id, 'reconnect');
      else if (cause === 'reconnect') await this.fail(id);
      return;
    }
  }
  dispose() { this.disposed = true; this.listeners.clear(); }
}
