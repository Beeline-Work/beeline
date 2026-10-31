import { MMKV } from 'react-native-mmkv';
import { webStringStorage } from '@/sync/browser-string-storage';
import {
  SurfaceResponseCache,
  type Identity,
  type SurfaceCacheAddress,
} from '@beeline/buzz-client';
import { selectIdentities } from './identity-records';
import { stripRetiredAgentNotices } from './retired-agent-notices';
import { MessageOutbox, type MessageOutboxRecord } from './message-outbox';
import type { NostrEvent } from '@beeline/nostr';
import type { AgentMessageWriteResult } from '@beeline/api-contract/phone';
import { SurfaceRegistry } from './surface-registry';
import { deferRoomWrite } from './room-transition-work';
import { webRuntimeStorage } from '@/utils/web-storage';

const web = webRuntimeStorage();
const RESPONSE_NAMESPACE = 'beeline.surface.';
const responses = web ? webStringStorage(web.storage, RESPONSE_NAMESPACE) : new MMKV({ id: 'buzz-surface-responses' });
const mutations = web ? webStringStorage(web.storage, 'beeline.outbox.') : new MMKV({ id: 'buzz-surface-outbox' });
const RESPONSE_PREFIX = 'surface.';
const OUTBOX_PREFIX = 'outbox.';

function storageKey(key: string): string {
  return `${RESPONSE_PREFIX}${encodeURIComponent(key)}`;
}

function decodedStorageKey(key: string): string | null {
  if (!key.startsWith(RESPONSE_PREFIX)) return null;
  try {
    return decodeURIComponent(key.slice(RESPONSE_PREFIX.length));
  } catch {
    return null;
  }
}

const durableSurfaceCache = new SurfaceResponseCache(
  {
    get: async (key) => responses.getString(storageKey(key)) ?? null,
    set: async (key, value) => {
      responses.set(storageKey(key), value);
    },
    remove: async (key) => {
      responses.delete(storageKey(key));
    },
  },
  stripRetiredAgentNotices,
);
export const mobileSurfaceCache = new SurfaceRegistry(
  durableSurfaceCache, stripRetiredAgentNotices, selectIdentities,
  (key, work) => /^\/room\/[^/]+$/.test(String((JSON.parse(key) as unknown[])[3]))
    ? deferRoomWrite(key, work) : work());

function storedValue(encoded: string | null): unknown {
  if (encoded === null) return undefined;
  try {
    return JSON.parse(encoded) as unknown;
  } catch {
    return undefined;
  }
}

// Another tab's write or removal of one response reaches this tab's copy of
// that response only. Clearing the whole storage drops every hot copy, so
// this tab neither shows nor writes back what the other tab removed.
if (web?.storage && typeof window.addEventListener === 'function') {
  const shared = web.storage;
  window.addEventListener('storage', (event) => {
    if (event.storageArea !== shared) return;
    if (event.key === null) {
      mobileSurfaceCache.clear();
      return;
    }
    if (!event.key.startsWith(RESPONSE_NAMESPACE)) return;
    const key = decodedStorageKey(event.key.slice(RESPONSE_NAMESPACE.length));
    if (key !== null) mobileSurfaceCache.adoptStored(key, storedValue(event.newValue));
  });
}

export function surfaceAddress(
  relayOrigin: string,
  viewerPubkey: string,
  endpoint: string,
  params?: SurfaceCacheAddress['params'],
): SurfaceCacheAddress {
  return { relayOrigin, viewerPubkey, endpoint, ...(params ? { params } : {}) };
}

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

export function clearMobileSurfaceStorage(): void {
  resetMessageOutboxes();
  mobileSurfaceCache.clear();
  for (const key of responses.getAllKeys()) {
    if (key.startsWith(RESPONSE_PREFIX)) responses.delete(key);
  }
  for (const key of mutations.getAllKeys()) {
    if (key.startsWith(OUTBOX_PREFIX)) mutations.delete(key);
  }
}
