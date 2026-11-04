import { CommandIntents, type CommandIntent, type AdmittedCommand } from '@beeline/net/owner';
import type { RouterCommandReceipt } from '@beeline/api-contract/router-command';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { getRandomBytes } from 'expo-crypto';
import { MMKV } from 'react-native-mmkv';
import { webRuntimeStorage } from '@/utils/web-storage';
import { webStringStorage } from '@/sync/browser-string-storage';
import type { AgentMessageWriteResult } from '@beeline/api-contract/phone';

const web = webRuntimeStorage();
const namespace = 'beeline.commands.';
const storage = web ? webStringStorage(web.storage, namespace) : new MMKV({ id: 'beeline-command-intents' });
let active: MobileCommandOwner | undefined;
const randomId = () => bytesToHex(getRandomBytes(32));
const storageReady = () => !web || !!web.storage && typeof navigator !== 'undefined' &&
  typeof navigator.locks?.request === 'function';
const intentKey = (record: CommandIntent) => JSON.stringify([record.operation, record.id]);
const terminal = (record: CommandIntent) => ['committed', 'refused', 'cancelled'].includes(record.state);
export interface CommandSocketBridge {
  commandState(): { generation: number; commandDedupV1: boolean; ready: boolean };
  requestCommand(operation: CommandIntent['operation'], args: unknown, command: { v: 1; id: string }, options?: { timeoutMs?: number }): Promise<RouterCommandReceipt>;
}
/** Internal pending marker uses the existing outbox's Sending treatment. */
export class CommandAwaitingConfirmation extends Error {}

export class MobileCommandOwner {
  private suspended = false;
  private readonly intents: CommandIntents;
  private readonly restored = new Set<string>();
  private readonly listeners = new Set<(record: CommandIntent) => void>();
  private readonly storageKey: string;
  constructor(readonly origin: string, readonly principal: string, private readonly socket: CommandSocketBridge) {
    this.origin = new URL(origin).origin;
    const partition = { origin: this.origin, principal };
    const key = encodeURIComponent(JSON.stringify([partition.origin, principal]));
    this.storageKey = key;
    const saved = storage.getString(key);
    const initial: CommandIntent[] = saved ? JSON.parse(saved) : [];
    let observed = new Map(initial.map(record => [intentKey(record), JSON.stringify(record)]));
    this.intents = new CommandIntents({ save: async records => {
      if (this.suspended) throw new Error('Command owner suspended');
      if (!web) { storage.set(key, JSON.stringify(records)); return; }
      if (!storageReady()) throw new Error('Atomic command storage is unavailable');
      // Each tab changes only its own records. Preserve other tabs' intents
      // and terminal outcomes while replacing the shared snapshot atomically.
      const changes = records.filter(record => observed.get(intentKey(record)) !== JSON.stringify(record));
      await navigator.locks.request(namespace + key, { mode: 'exclusive' }, () => {
        if (this.suspended) throw new Error('Command owner suspended');
        const shared: CommandIntent[] = JSON.parse(web.storage!.getItem(namespace + key) ?? '[]');
        const merged = new Map(shared.map(record => [intentKey(record), record]));
        for (const record of changes) {
          const prior = merged.get(intentKey(record));
          if (prior && (prior.bytes !== record.bytes || prior.digest !== record.digest))
            throw new Error('Command storage identity changed');
          if (record.state === 'sending' && prior && terminal(prior))
            throw new Error('Command ended before dispatch');
          if (record.state === 'cancelled' && prior?.sent)
            throw new Error('Command already admitted to transport');
          if (!prior || !terminal(prior)) merged.set(intentKey(record), record);
        }
        const pending = [...merged.values()].filter(record => !terminal(record));
        if (pending.length > 100 || pending.reduce((bytes, record) =>
          bytes + utf8ToBytes(JSON.stringify(record)).length + 128, 0) > 2 * 1024 * 1024)
          throw new Error('Command storage capacity');
        const completed = [...merged.values()].filter(terminal).sort((a, b) => a.preparedAt - b.preparedAt);
        for (const record of completed.slice(0, Math.max(0, completed.length - 100))) merged.delete(intentKey(record));
        web.storage!.setItem(namespace + key, JSON.stringify([...merged.values()]));
      });
      observed = new Map(records.map(record => [intentKey(record), JSON.stringify(record)]));
    } }, async value => bytesToHex(sha256(utf8ToBytes(value))), randomId, Date.now);
    this.intents.setPartition(partition);
    if (saved) {
      this.intents.restore(initial);
      // Another browser tab can still own an unsent Undo window. Adopt its
      // sent intents, but leave that gesture's prepared command with its owner.
      for (const record of this.intents.view()) if (!web || record.sent) this.restored.add(record.id);
    }
  }
  canPrepare(): boolean {
    const state = this.socket.commandState();
    return !this.suspended && storageReady() && state.ready && state.commandDedupV1;
  }
  prepare(admitted: AdmittedCommand): Promise<CommandIntent> { this.adopt(); return this.intents.prepare(admitted); }
  find(id: string): CommandIntent | undefined { return this.intents.view().find(record => record.id === id); }
  suspend(): void { this.suspended = true; this.intents.setPartition(undefined); }
  subscribe(listener: (record: CommandIntent) => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private notify(record: CommandIntent): void { for (const listener of this.listeners) listener(record); }
  private adopt(): void {
    if (!web || this.suspended) return;
    const saved = storage.getString(this.storageKey);
    if (saved) this.intents.adopt(JSON.parse(saved));
  }
  async deliver(id: string, cause: 'send' | 'reconnect' = 'send'): Promise<AgentMessageWriteResult> {
    this.adopt();
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
    this.adopt();
    const connection = this.socket.commandState();
    if (!connection.ready || !connection.commandDedupV1) return;
    await Promise.all(this.intents.view().filter(record => ['unknown','pending'].includes(record.state) || record.state === 'prepared' &&
      (this.restored.has(record.id)||record.operation==='deleteRoomSchedule'||record.operation==='deleteRoomSubscription'))
      .map(record => this.deliver(record.id, 'reconnect').catch(() => undefined)));
  }
  async cancel(id: string): Promise<void> {
    this.adopt();
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
    requestCommand: (operation, args, command, options) => socket.requestCommand
      ? socket.requestCommand(operation, args, command, options) : Promise.reject(new Error('Command dedup unavailable')),
  });
  active = next;
  return next;
}
export function activeCommandOwner(): MobileCommandOwner | undefined { return active; }
export function suspendCommandOwner(): void { active?.suspend(); active = undefined; }
