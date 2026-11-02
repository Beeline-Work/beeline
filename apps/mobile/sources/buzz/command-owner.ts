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
  constructor(readonly origin: string, readonly principal: string, private readonly socket: CommandSocketBridge) {
    this.origin = new URL(origin).origin;
    const partition = { origin: this.origin, principal };
    const key = encodeURIComponent(JSON.stringify([partition.origin, principal]));
    this.intents = new CommandIntents({ save: async records => {
      if (this.suspended) throw new Error('Command owner suspended');
      const encoded = JSON.stringify(records);
      // One synchronous key replacement; browser quota failure must reject.
      if (web?.storage) web.storage.setItem(namespace + key, encoded);
      else storage.set(key, encoded);
    } }, async value => bytesToHex(sha256(utf8ToBytes(value))), randomId, Date.now);
    this.intents.setPartition(partition);
    const saved = storage.getString(key);
    if (saved) {
      this.intents.restore(JSON.parse(saved));
      for (const record of this.intents.view()) this.restored.add(record.id);
    }
  }
  canPrepare(): boolean {
    // A shared browser snapshot needs a cross-tab transaction/adoption proof
    // before that cohort may create durable commands. It keeps the legacy path.
    const state = this.socket.commandState();
    return !this.suspended && !web && state.ready && state.commandDedupV1;
  }
  prepare(admitted: AdmittedCommand): Promise<CommandIntent> { return this.intents.prepare(admitted); }
  find(id: string): CommandIntent | undefined { return this.intents.view().find(record => record.id === id); }
  suspend(): void { this.suspended = true; this.intents.setPartition(undefined); }
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
    await Promise.all(this.intents.view().filter(record => ['unknown','pending'].includes(record.state) || record.state === 'prepared' && this.restored.has(record.id))
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
    requestCommand: (operation, args, command, options) => socket.requestCommand
      ? socket.requestCommand(operation, args, command, options) : Promise.reject(new Error('Command dedup unavailable')),
  });
  active = next;
  return next;
}
export function activeCommandOwner(): MobileCommandOwner | undefined { return active; }
export function suspendCommandOwner(): void { active?.suspend(); active = undefined; }
