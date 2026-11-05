import type { RouterCommandReceipt } from '@beeline/api-contract/router-command';
import { canonical } from './canonical.js';

const OPERATIONS = ['sendRoomMessage','sendRoomReply','markRead','markUnread','reactToMessage',
  'deleteRoomMessage','setMessageBookmark','clearMessageBookmarks','markNeedsYouSeen','clearNeedsYou','clearNeedsYouSection',
  'deleteRoomSchedule','deleteRoomSubscription','decideAgentGrant','decideWritePermission','skipChoice'] as const;
export type IntentOperation = typeof OPERATIONS[number];
export type IntentState = 'prepared' | 'sending' | 'pending' | 'unknown' | 'committed' | 'refused' | 'cancelled';
export type CommandPartition = Readonly<{ origin: string; principal: string }>;
export interface CommandIntent extends CommandPartition {
  readonly v: 1; readonly id: string; readonly operation: IntentOperation; readonly schema: 1;
  readonly bytes: string; readonly digest: string; readonly preparedAt: number;
  readonly state: IntentState; readonly sent: boolean;
}
export interface CommandIntentStorage {
  /** Atomic replacement. Rejection must leave the previous snapshot intact. */
  save(records: readonly CommandIntent[]): Promise<void>;
}
export type CommandAttempt = Readonly<{ generation: number; commandDedupV1: boolean }> & (
  | { readonly kind: 'initial' }
  | { readonly kind: 'reconnect' }
  | { readonly kind: 'retry'; readonly actionId: string }
);
export interface AdmittedCommand {
  readonly wire: { readonly operation: string; readonly input: string };
  readonly isCurrent: () => boolean;
}
const terminal = (state: IntentState) => state === 'committed' || state === 'refused' || state === 'cancelled';
const partitionKey = (partition: CommandPartition) => canonical([partition.origin, partition.principal]);
const intentKey = (intent: Pick<CommandIntent, 'origin' | 'principal' | 'operation' | 'id'>) =>
  canonical([intent.origin, intent.principal, intent.operation, intent.id]);

/** Trusted connection/action owner only. No transport, timers, global storage,
 * admission minting or feature-callable operation executor lives here.
 * PREPARED -> SENDING -> COMMITTED/PENDING; a lost outcome -> UNKNOWN.
 * UNKNOWN resumes only with the SAME bytes/id against negotiated deduplication.
 * Stop waiting never cancels an admitted effect; logout suspends its partition.
 */
export class CommandIntents {
  private readonly records = new Map<string, CommandIntent>();
  private readonly preparing = new Map<string, Promise<CommandIntent>>();
  private readonly reservations = new Map<string, { operation: IntentOperation; input: string; partition: string }>();
  private readonly flights = new Map<string, Promise<CommandIntent>>();
  private serial: Promise<void> = Promise.resolve();
  private partition: CommandPartition | undefined;
  constructor(private readonly storage: CommandIntentStorage,
    private readonly hash: (canonicalInput: string) => Promise<string>,
    private readonly createId: () => string, private readonly now: () => number) {}

  setPartition(partition: CommandPartition | undefined): void {
    if (partition && (!partition.origin || partition.origin.length > 2048 || !partition.principal || partition.principal.length > 256))
      throw new Error('command partition invalid');
    this.partition = partition ? Object.freeze({ ...partition }) : undefined;
  }
  view(): readonly CommandIntent[] {
    const partition = this.partition && partitionKey(this.partition);
    return [...this.records.values()].filter(record => partitionKey(record) === partition).map(record => ({ ...record }));
  }
  /** Restore validates all records before installation. A crash while SENDING
   * preserves uncertainty; it never changes immutable bytes or invents failure. */
  restore(records: readonly CommandIntent[]): void {
    if (this.records.size || this.reservations.size || this.flights.size) throw new Error('command restore requires empty owner');
    const restored = new Map<string, CommandIntent>();
    for (const record of records) {
      if (!record || record.v !== 1 || record.schema !== 1 || !OPERATIONS.includes(record.operation) ||
          !/^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/.test(record.id) || !/^[0-9a-f]{64}$/.test(record.digest) ||
          typeof record.origin !== 'string' || !record.origin || typeof record.principal !== 'string' || !record.principal ||
          !Number.isSafeInteger(record.preparedAt) || record.preparedAt < 0 || typeof record.sent !== 'boolean' ||
          !['prepared','sending','pending','unknown','committed','refused','cancelled'].includes(record.state) ||
          typeof record.bytes !== 'string' || canonical(JSON.parse(record.bytes)) !== record.bytes ||
          (['sending','pending','unknown','committed'].includes(record.state) && !record.sent)) throw new Error('invalid command storage');
      const key = intentKey(record);
      if (restored.has(key)) throw new Error('duplicate command storage identity');
      const saved = Object.freeze({ ...record, state: record.state === 'sending' ? 'unknown' as const : record.state });
      restored.set(key, saved);
    }
    for (const [key, record] of restored) this.records.set(key, record);
  }
  /** Must be called in the synchronous action prefix after admission.spend.
   * Identity reserves synchronously; persistence/hash may outlive the tap.
   * An identical active intent joins unless the action explicitly means another.
   */
  prepare(admitted: AdmittedCommand, newIntent = false): Promise<CommandIntent> {
    if (!this.partition || !admitted.isCurrent()) throw new Error('command admission inactive');
    if (!(OPERATIONS as readonly string[]).includes(admitted.wire.operation)) throw new Error('command operation unsupported');
    const operation = admitted.wire.operation as IntentOperation;
    const input = canonical(JSON.parse(admitted.wire.input));
    if (input !== admitted.wire.input) throw new Error('command input not canonical');
    const partition = this.partition, owner = partitionKey(partition);
    if (!newIntent) {
      const existing = [...this.records.values()].find(record => partitionKey(record) === owner &&
        record.operation === operation && record.bytes === input && !terminal(record.state));
      if (existing) return Promise.resolve({ ...existing });
      for (const [key, reservation] of this.reservations) if (reservation.partition === owner &&
        reservation.operation === operation && reservation.input === input) return this.preparing.get(key)!;
    }
    const args = JSON.parse(input) as { messageId?: unknown };
    const id = operation === 'sendRoomMessage' || operation === 'sendRoomReply' ? args.messageId : this.createId();
    if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/.test(id) ||
        ((operation === 'sendRoomMessage' || operation === 'sendRoomReply') && !/^[0-9a-f]{64}$/.test(id))) throw new Error('command prepared identity required');
    const key = intentKey({ ...partition, operation, id });
    if (this.records.has(key) || this.reservations.has(key)) throw new Error('command identity already used');
    const preparedAt = this.now();
    if (!Number.isSafeInteger(preparedAt) || preparedAt < 0) throw new Error('command prepared time invalid');
    this.reservations.set(key, { operation, input, partition: owner });
    const preparation = this.enqueue(async () => {
      const digest = await this.hash('beeline-command:canonical-v1\n' + canonical({ schema: 1, operation, args }));
      if (!/^[0-9a-f]{64}$/.test(digest)) throw new Error('command digest invalid');
      const record: CommandIntent = Object.freeze({ ...partition, v: 1, schema: 1, id, operation,
        bytes: input, digest, preparedAt, state: 'prepared', sent: false });
      await this.saveWith(key, record);
      this.records.set(key, record);
      return { ...record };
    }).finally(() => { this.reservations.delete(key); this.preparing.delete(key); });
    this.preparing.set(key, preparation);
    return preparation;
  }
  cancel(record: CommandIntent): Promise<CommandIntent> {
    const key = intentKey(record);
    return this.enqueue(async () => {
      const current = this.require(key);
      if (current.sent || current.state !== 'prepared' || this.flights.has(key)) throw new Error('command already admitted to transport');
      return this.change(key, { ...current, state: 'cancelled' });
    });
  }
  /** The caller supplies its existing socket request function; no second owner.
   * Incapable servers leave uncertainty parked and can never downgrade a retry.
   */
  dispatch(record: CommandIntent, attempt: CommandAttempt,
    send: (operation: IntentOperation, args: unknown, command: { v: 1; id: string }) => Promise<RouterCommandReceipt>): Promise<CommandIntent> {
    const key = intentKey(record), active = this.flights.get(key);
    if (active) return active;
    if (!this.partition || partitionKey(record) !== partitionKey(this.partition)) throw new Error('command principal suspended');
    if (!attempt.commandDedupV1) throw new Error('command dedup unavailable');
    if (!Number.isSafeInteger(attempt.generation) || attempt.generation < 0) throw new Error('command connection generation invalid');
    const current = this.require(key);
    if (terminal(current.state)) return Promise.resolve({ ...current });
    if (current.state === 'sending') throw new Error('command already sending');
    // The negotiated server ledger binds immutable ID, operation and digest.
    // Repeating that same command is safe even after a lost receipt, without a
    // new gesture, connection generation or cumulative attempt entitlement.
    const flight = (async () => {
      await this.enqueue(async () => {
        if (!this.partition || partitionKey(current) !== partitionKey(this.partition)) throw new Error('command principal suspended');
        const latest = this.require(key);
        if (terminal(latest.state)) return;
        const digest = await this.hash('beeline-command:canonical-v1\n' + canonical({ schema: 1, operation: latest.operation, args: JSON.parse(latest.bytes) }));
        if (digest !== latest.digest) throw new Error('command stored digest mismatch');
        await this.change(key, { ...latest, state: 'sending', sent: true });
      });
      // Persistence may finish after logout; recheck before the first send.
      if (!this.partition || partitionKey(current) !== partitionKey(this.partition))
        return this.enqueue(() => this.change(key, { ...this.require(key), state: 'unknown' }));
      if (terminal(this.require(key).state)) return { ...this.require(key) };
      try {
        const receipt = await send(current.operation, JSON.parse(current.bytes), { v: 1, id: current.id });
        return await this.settle(current, receipt);
      } catch (error) {
        await this.enqueue(async () => {
          const latest = this.require(key);
          if (!terminal(latest.state)) await this.change(key, { ...latest, state: 'unknown' });
        });
        throw error;
      }
    })().finally(() => this.flights.delete(key));
    this.flights.set(key, flight);
    return flight;
  }
  settle(record: CommandIntent, receipt: RouterCommandReceipt): Promise<CommandIntent> {
    const key = intentKey(record);
    if (receipt.v !== 1 || receipt.commandId !== record.id || receipt.operation !== record.operation ||
        !['committed','pending','unknown','result-expired'].includes(receipt.state)) throw new Error('command receipt mismatch');
    return this.enqueue(async () => {
      const current = this.require(key);
      if (terminal(current.state)) return { ...current };
      const state = receipt.state === 'committed' || receipt.state === 'result-expired' ? 'committed' : receipt.state;
      return this.change(key, { ...current, state, sent: true });
    });
  }
  /** A matching committed effect can win the race with a delayed/lost receipt. */
  committedEffect(partition: CommandPartition, operation: IntentOperation, id: string): Promise<CommandIntent | undefined> {
    const key = intentKey({ ...partition, operation, id });
    return this.enqueue(async () => {
      const current = this.records.get(key);
      if (!current || !current.sent || terminal(current.state)) return current && { ...current };
      return this.change(key, { ...current, state: 'committed' });
    });
  }
  private require(key: string): CommandIntent {
    const record = this.records.get(key);
    if (!record) throw new Error('command not durably prepared');
    return record;
  }
  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const task = this.serial.then(work);
    this.serial = task.then(() => {}, () => {});
    return task;
  }
  private async change(key: string, record: CommandIntent): Promise<CommandIntent> {
    const frozen = Object.freeze(record);
    await this.saveWith(key, frozen);
    this.records.set(key, frozen);
    return { ...frozen };
  }
  private async saveWith(key: string, record: CommandIntent): Promise<void> {
    const next = new Map(this.records); next.set(key, record);
    const complete = [...next.entries()].filter(([,item]) => terminal(item.state));
    // Terminal local display records may compact; uncertain intents never do.
    for (const [old] of complete.slice(0, Math.max(0, complete.length - 100))) next.delete(old);
    await this.storage.save([...next.values()].map(item => ({ ...item })));
    // Mirror compaction only after the atomic save has succeeded.
    for (const old of this.records.keys()) if (!next.has(old)) this.records.delete(old);
  }
}
