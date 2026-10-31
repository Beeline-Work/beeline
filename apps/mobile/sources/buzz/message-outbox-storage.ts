import { MMKV } from 'react-native-mmkv';
import { webStringStorage } from '@/sync/browser-string-storage';
import { webRuntimeStorage } from '@/utils/web-storage';
import type { Identity } from '@beeline/buzz-client';
import { MessageOutbox, type MessageOutboxRecord } from './message-outbox';
import type { NostrEvent } from '@beeline/nostr';
import type { AgentMessageWriteResult } from '@beeline/api-contract/phone';

const web = webRuntimeStorage();
const mutations = web ? webStringStorage(web.storage, 'beeline.outbox.') : new MMKV({ id: 'buzz-surface-outbox' });
const OUTBOX_PREFIX = 'outbox.';

function relayScope(relayOrigin: string): string {
  try {
    return encodeURIComponent(new URL(relayOrigin).origin);
  } catch {
    return encodeURIComponent(relayOrigin);
  }
}

const appOutboxes = new Map<string, MessageOutbox>();
const roomHandles = new Map<string, ReturnType<typeof roomOutboxHandle>>();
let delivery: { send(event: NostrEvent): Promise<AgentMessageWriteResult>; rejection(error: unknown): string | undefined };
export function configureMessageOutboxDelivery(next: typeof delivery): void { delivery = next; }

export function getMessageOutbox(relayOrigin: string, identity: Pick<Identity, 'publicKey'>): MessageOutbox {
  const prefix = `${OUTBOX_PREFIX}${relayScope(relayOrigin)}.${identity.publicKey}.`;
  const key = `${prefix}app`;
  let owner = appOutboxes.get(key);
  if (owner) return owner;
  owner = new MessageOutbox({
    load: async () => {
      const records: MessageOutboxRecord[] = [];
      // Read the former Room keys once, save the app key before deleting them.
      const oldKeys = mutations.getAllKeys().filter(candidate => candidate.startsWith(prefix) && candidate !== key);
      for (const storedKey of [...oldKeys, key]) {
        try { records.push(...JSON.parse(mutations.getString(storedKey) ?? '[]')); } catch { /* Ignore malformed local data. */ }
      }
      return records;
    },
    save: async records => {
      if (records.length) mutations.set(key, JSON.stringify(records));
      else mutations.delete(key);
      for (const old of mutations.getAllKeys()) if (old.startsWith(prefix) && old !== key) mutations.delete(old);
    },
    send: event => delivery.send(event),
    rejection: error => delivery.rejection(error),
  });
  appOutboxes.set(key, owner);
  return owner;
}

function roomOutboxHandle(owner: MessageOutbox, roomId: string) {
  return {
    restore: () => owner.restore(),
    list: () => owner.list(roomId),
    get: (id: string) => owner.get(id),
    enqueue: owner.enqueue.bind(owner),
    fail: owner.fail.bind(owner),
    remove: owner.remove.bind(owner),
    reconcile: owner.reconcile.bind(owner),
    send: owner.send.bind(owner),
    state: owner.state.bind(owner),
    acknowledgeFailures: () => owner.acknowledgeFailures(roomId),
    subscribe: owner.subscribe,
  };
}

/** A Room selector over the app-wide owner; it never starts a second sender. */
export function createRoomOutbox(relayOrigin: string, identity: Pick<Identity, 'publicKey'>, roomId: string) {
  const key = JSON.stringify([relayScope(relayOrigin), identity.publicKey, roomId]);
  let handle = roomHandles.get(key);
  if (!handle) {
    handle = roomOutboxHandle(getMessageOutbox(relayOrigin, identity), roomId);
    roomHandles.set(key, handle);
  }
  return handle;
}

export function resetMessageOutboxes(): void {
  for (const owner of appOutboxes.values()) owner.dispose();
  appOutboxes.clear();
  roomHandles.clear();
}

export function clearMessageOutboxStorage(): void {
  resetMessageOutboxes();
  for (const key of mutations.getAllKeys()) {
    if (key.startsWith(OUTBOX_PREFIX)) mutations.delete(key);
  }
}
