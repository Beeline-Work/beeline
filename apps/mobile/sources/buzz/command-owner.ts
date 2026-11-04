import { CommandIntents, type CommandIntent, type AdmittedCommand } from '@beeline/net/owner';
import type { RouterCommandReceipt } from '@beeline/api-contract/router-command';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { getRandomBytes } from 'expo-crypto';
import { MMKV } from 'react-native-mmkv';
import { webRuntimeStorage } from '@/utils/web-storage';
import { canonicalJson } from '@beeline/net/phone-inputs';
import { type PhoneCommandOperation, type PhoneOperationMap } from '@beeline/api-contract/phone';
import type { AgentMessageWriteResult } from '@beeline/api-contract/phone';

const web = webRuntimeStorage();
const namespace = 'beeline.commands.';
// Browser snapshots share one origin/principal lock and merge only this
// writer's changed intents. Closing a tab never discards an uncertain action.
const browserStorage = web?.storage;
const browserReady = () => !web || Boolean(browserStorage && typeof navigator !== 'undefined' && typeof navigator.locks?.request === 'function');
const storage = web ? undefined : new MMKV({ id: 'beeline-command-intents' });
let active: MobileCommandOwner | undefined;
const randomId = () => bytesToHex(getRandomBytes(32));
export interface CommandSocketBridge {
  commandState(): { generation: number; commandDedupV1: boolean; ready: boolean };
  subscribeCommandCapabilities?(listener: () => void): () => void;
  requestCommand(operation: CommandIntent['operation'], args: unknown, command: { v: 1; id: string }, options?: { timeoutMs?: number; signal?: AbortSignal; afterRoomDraw?: boolean }): Promise<RouterCommandReceipt>;
}
/** Internal pending marker uses the existing outbox's Sending treatment. */
export class CommandAwaitingConfirmation extends Error {}

class MobileCommandOwner {
  private suspended = false;
  private readonly lifetime = new AbortController();
  private readonly intents: CommandIntents;
  private readonly restored = new Set<string>();
  private readonly operations = new Map<string, Promise<unknown>>();
  private readonly listeners = new Set<(record: CommandIntent) => void>();
  constructor(readonly origin: string, readonly principal: string, private readonly socket: CommandSocketBridge) {
    this.origin = new URL(origin).origin;
    const partition = { origin: this.origin, principal };
    const key = encodeURIComponent(JSON.stringify([partition.origin, principal]));
    let previous = new Map<string, string>();
    this.intents = new CommandIntents({ save: async records => {
      if (this.suspended) throw new Error('Command owner suspended');
      const encoded = JSON.stringify(records);
      // One synchronous key replacement; browser quota failure must reject.
      if (web) {
        if (!browserReady()) throw new Error('Command storage unavailable');
        await navigator.locks.request(namespace + key, { mode: 'exclusive' }, () => {
          if (this.suspended) throw new Error('Command owner suspended');
          const saved = browserStorage!.getItem(namespace + key);
          const merged = new Map<string, CommandIntent>((saved ? JSON.parse(saved) as CommandIntent[] : []).map(item => [item.id, item]));
          for (const record of records) {
            if (previous.get(record.id) === JSON.stringify(record)) continue;
            const held = merged.get(record.id);
            // A tab opened before another writer's uncertain action cannot
            // mint a second payment/decision identity for those same bytes.
            if (!held && record.state === 'prepared' && !record.transient && [...merged.values()].some(item =>
                item.operation === record.operation && item.digest === record.digest &&
                !['committed', 'refused', 'cancelled'].includes(item.state)))
              throw new Error('This action is already pending in another tab; reload to check its result');
            if (held && (held.operation !== record.operation || held.digest !== record.digest || held.bytes !== record.bytes))
              throw new Error('Command identity changed in another tab');
            if (held && ['committed', 'refused', 'cancelled'].includes(held.state) && held.state !== record.state)
              throw new Error('Command settled in another tab; refresh to check its result');
            if (held?.sent && record.state === 'cancelled') throw new Error('Command already admitted in another tab');
            merged.set(record.id, record);
          }
          const terminal = [...merged.values()].filter(item => ['committed', 'refused', 'cancelled'].includes(item.state));
          const pending = [...merged.values()].filter(item => !['committed', 'refused', 'cancelled'].includes(item.state));
          if (pending.length > 100 || utf8ToBytes(JSON.stringify(pending)).length + pending.length * 128 > 2 * 1024 * 1024)
            throw new Error('Command outbox capacity');
          browserStorage!.setItem(namespace + key, JSON.stringify([...pending, ...terminal.slice(-100)]));
        });
        previous = new Map(records.map(record => [record.id, JSON.stringify(record)]));
      } else storage!.set(key, encoded);
    } }, async value => bytesToHex(sha256(utf8ToBytes(value))), randomId, Date.now);
    this.intents.setPartition(partition);
    const saved = web ? browserStorage?.getItem(namespace + key) : storage!.getString(key);
    if (saved) {
      this.intents.restore(JSON.parse(saved));
      for (const record of this.intents.view()) this.restored.add(record.id);
      previous = new Map(this.intents.view().map(record => [record.id, JSON.stringify(record)]));
    }
  }
  canPrepare(): boolean {
    const state = this.socket.commandState();
    return !this.suspended && browserReady() && state.ready && state.commandDedupV1;
  }
  prepare(admitted: AdmittedCommand): Promise<CommandIntent> { return this.intents.prepare(admitted); }
  /** Cold-start actions wait on the existing socket's negotiation event.
   * This deadline only ends the action; it never recovers a connection. */
  private async ready(options?: { timeoutMs?: number; signal?: AbortSignal }): Promise<void> {
    const check = () => this.socket.commandState();
    if (check().ready && check().commandDedupV1) return;
    if (!this.socket.subscribeCommandCapabilities) throw new CommandAwaitingConfirmation('Command delivery is unavailable.');
    await new Promise<void>((resolve, reject) => {
      let unsubscribe = () => {}, completed = false;
      const finish = (error?: Error) => {
        if (completed) return;
        completed = true;
        clearTimeout(timer); unsubscribe();
        options?.signal?.removeEventListener('abort', aborted);
        this.lifetime.signal.removeEventListener('abort', suspended);
        error ? reject(error) : resolve();
      };
      const changed = () => { if (check().ready) finish(check().commandDedupV1 ? undefined : new CommandAwaitingConfirmation('Command delivery is unavailable.')); };
      const aborted = () => finish(Object.assign(new Error('The request was aborted.'), { name: 'AbortError' }));
      const suspended = () => finish(new Error('Command owner suspended'));
      const timer = setTimeout(() => finish(new CommandAwaitingConfirmation('Command delivery is unavailable.')), options?.timeoutMs ?? 20_000);
      unsubscribe = this.socket.subscribeCommandCapabilities!(changed);
      if (completed) { unsubscribe(); return; }
      options?.signal?.addEventListener('abort', aborted, { once: true });
      this.lifetime.signal.addEventListener('abort', suspended, { once: true });
      if (this.suspended) suspended(); else if (options?.signal?.aborted) aborted(); else changed();
    });
  }
  /** Feature writes use the same immutable intent/receipt owner as prepared
   * messages. No raw operation executor is available to these callers. */
  async execute<Name extends PhoneCommandOperation>(operation: Name, input: PhoneOperationMap[Name]['input'],
    options?: { timeoutMs?: number; signal?: AbortSignal; afterRoomDraw?: boolean }): Promise<PhoneOperationMap[Name]['output']> {
    if (this.suspended) throw new Error('Command owner suspended');
    options?.signal?.throwIfAborted();
    if ((operation === 'sendRoomMessage' || operation === 'sendRoomReply') && !(input as { messageId?: string }).messageId)
      input = { ...input, messageId: randomId() };
    const bytes = canonicalJson(input);
    if (operation === 'sendRoomMessage' || operation === 'sendRoomReply') {
      const known = this.find((input as { messageId: string }).messageId);
      if (known?.state === 'committed' && known.operation === operation && known.bytes === bytes)
        return { messageId: known.id } as PhoneOperationMap[Name]['output'];
    }
    const record = await this.intents.prepare({ wire: { operation, input: bytes },
      isCurrent: () => !this.suspended });
    const existing = this.operations.get(record.id);
    if (existing) return existing as Promise<PhoneOperationMap[Name]['output']>;
    const work = (async () => {
      try {
        await this.ready(options);
        options?.signal?.throwIfAborted();
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError')
          await this.intents.cancel(record).catch(() => undefined); // An already-admitted action cannot be cancelled.
        throw error;
      }
      let receipt: RouterCommandReceipt | undefined;
      const connection = this.socket.commandState();
      if (!connection.ready || !connection.commandDedupV1) throw new CommandAwaitingConfirmation('Command delivery is unavailable.');
      const kind = record.state === 'prepared' ? 'initial' : 'retry';
      const next = await this.intents.dispatch(record, { kind, generation: connection.generation,
        commandDedupV1: connection.commandDedupV1, ...(kind === 'retry' ? { actionId: randomId() } : {}) } as Parameters<CommandIntents['dispatch']>[1],
        async (name, args, identity) => receipt = await this.socket.requestCommand(name, args, identity, options));
      this.notify(next);
      if (next.state !== 'committed') throw new CommandAwaitingConfirmation('The action is not confirmed yet.');
      if (operation === 'sendRoomMessage' || operation === 'sendRoomReply')
        return { messageId: record.id } as PhoneOperationMap[Name]['output'];
      if (!receipt || receipt.state === 'result-expired' || !Object.hasOwn(receipt, 'result')) throw new CommandAwaitingConfirmation('The action completed. Refresh to see its result.');
      return receipt.result as PhoneOperationMap[Name]['output'];
    })().finally(() => this.operations.delete(record.id));
    this.operations.set(record.id, work);
    return work;
  }

  find(id: string): CommandIntent | undefined { return this.intents.view().find(record => record.id === id); }
  suspend(): void { this.suspended = true; this.lifetime.abort(); this.intents.setPartition(undefined); }
  subscribe(listener: (record: CommandIntent) => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private notify(record: CommandIntent): void { for (const listener of this.listeners) listener(record); }
  async deliver(id: string, cause: 'send' | 'reconnect' = 'send'): Promise<AgentMessageWriteResult> {
    const record = this.find(id);
    if (!record) throw new Error('Command intent was not persisted');
    if (record.state === 'committed') return { messageId: record.id };
    const connection = this.socket.commandState();
    if (!connection.ready || !connection.commandDedupV1) throw new CommandAwaitingConfirmation();
    const kind = record.state === 'prepared' ? 'initial' : cause === 'reconnect' ? 'reconnect' : 'retry';
    const next = await this.intents.dispatch(record, { kind, generation: connection.generation,
      commandDedupV1: connection.commandDedupV1, ...(kind === 'retry' ? { actionId: randomId() } : {}) } as Parameters<CommandIntents['dispatch']>[1],
      (operation, args, command) => this.socket.requestCommand(operation, args, command));
    this.notify(next);
    if (next.state !== 'committed') throw new CommandAwaitingConfirmation();
    return { messageId: next.id };
  }
  /** Exactly one attempt per successfully negotiated connection generation.
   * Failure parks; this method contains no timer and never schedules itself. */
  async negotiated(): Promise<void> {
    const connection = this.socket.commandState();
    if (!connection.ready || !connection.commandDedupV1) return;
    await Promise.all(this.intents.view().filter(record => !(record.transient && record.bytes === 'null') && (['unknown','pending'].includes(record.state) || record.state === 'prepared' &&
      (this.restored.has(record.id)||record.operation==='deleteRoomSchedule'||record.operation==='deleteRoomSubscription')))
      .map(record => this.deliver(record.id, 'reconnect').catch(() => undefined)));
  }
  async cancel(id: string): Promise<void> {
    const record = this.find(id);
    if (record) this.notify(await this.intents.cancel(record));
  }
  async committedMessage(id: string): Promise<void> {
    const record = this.find(id);
    if (!record) return;
    const next = await this.intents.committedEffect({ origin: this.origin, principal: this.principal }, record.operation, id);
    if (next) this.notify(next);
  }
}
export function activateCommandOwner(origin: string, principal: string, socket: Partial<CommandSocketBridge>): MobileCommandOwner {
  active?.suspend();
  // A fresh owner restores its immutable partition and crash-SENDING as UNKNOWN.
  // It never reads another principal's command data.
  const next = new MobileCommandOwner(origin, principal, {
    commandState: () => socket.commandState?.() ?? { generation: 0, commandDedupV1: false, ready: false },
    ...(socket.subscribeCommandCapabilities ? { subscribeCommandCapabilities: (listener: () => void) => socket.subscribeCommandCapabilities!(listener) } : {}),
    requestCommand: (operation, args, command, options) => socket.requestCommand
      ? socket.requestCommand(operation, args, command, options) : Promise.reject(new Error('Command dedup unavailable')),
  });
  active = next;
  return next;
}
export function activeCommandOwner(): MobileCommandOwner | undefined { return active; }
export function suspendCommandOwner(): void { active?.suspend(); active = undefined; }
