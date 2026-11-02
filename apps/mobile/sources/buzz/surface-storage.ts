import { MMKV } from 'react-native-mmkv';
import { webStringStorage } from '@/sync/browser-string-storage';
import {
  SurfaceResponseCache,
  type SurfaceCacheAddress,
} from '@beeline/buzz-client';
import { selectIdentities } from './identity-records';
import { stripRetiredAgentNotices } from './retired-agent-notices';
import { clearMessageOutboxStorage } from './message-outbox-storage';
export { configureMessageOutboxDelivery, getMessageOutbox, createRoomOutbox, resetMessageOutboxes } from './message-outbox-storage';
import { SurfaceRegistry } from './surface-registry';
import { deferRoomWrite } from './room-transition-work';
import { webRuntimeStorage } from '@/utils/web-storage';

const web = webRuntimeStorage();
const RESPONSE_NAMESPACE = 'beeline.surface.';
const responses = web ? webStringStorage(web.storage, RESPONSE_NAMESPACE) : new MMKV({ id: 'buzz-surface-responses' });
const RESPONSE_PREFIX = 'surface.';

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

export function clearMobileSurfaceStorage(): void {
  clearMessageOutboxStorage();
  mobileSurfaceCache.clear();
  for (const key of responses.getAllKeys()) {
    if (key.startsWith(RESPONSE_PREFIX) || key.startsWith('router.group.')) responses.delete(key);
  }
}

const ROUTER_GROUP_PREFIX = 'router.group.';
const ROUTER_FENCE_PREFIX = 'router.fence.';
const routerFenceListeners = new Set<(key: string, epoch: string) => void>();
const MAX_ROUTER_READER_BYTES = 32 * 1024 * 1024;

/** Router groups use the existing response store, with one encoded atomic
 * data+cut+authority envelope. Fences have a separate namespace outside LRU.
 * Private response restore remains hidden until fresh server authorization.
 */
export function routerLaneStorage(origin: string, principal: string) {
  const owner = encodeURIComponent(JSON.stringify([new URL(origin).origin, principal]));
  const groupPrefix = `${ROUTER_GROUP_PREFIX}${owner}.`;
  const fencePrefix = `${ROUTER_FENCE_PREFIX}${owner}.`;
  const groupKey = (key: string) => `${groupPrefix}${encodeURIComponent(key)}`;
  const fenceKey = (scope: string) => `${fencePrefix}${encodeURIComponent(scope)}`;
  return {
    write: async (key: string, encoded: string): Promise<void> => {
      const length = new TextEncoder().encode(encoded).length;
      if (length > 1024 * 1024) throw new Error('Router consistency group exceeds storage budget.');
      // Actual local storage writes are synchronous/atomic for this one key.
      if (web?.storage) web.storage.setItem(`${RESPONSE_NAMESPACE}${groupKey(key)}`, encoded);
      else responses.set(groupKey(key), encoded);
      const keys = responses.getAllKeys().filter(candidate => candidate.startsWith(groupPrefix));
      let total = keys.reduce((sum, candidate) => sum + new TextEncoder().encode(responses.getString(candidate) ?? '').length, 0);
      for (const candidate of keys) {
        if (total <= MAX_ROUTER_READER_BYTES) break;
        if (candidate === groupKey(key)) continue;
        total -= new TextEncoder().encode(responses.getString(candidate) ?? '').length;
        responses.delete(candidate);
      }
    },
    fence: async (scope: string, epoch: string): Promise<void> => {
      const key = fenceKey(scope);
      const previous = responses.getString(key);
      if (previous && /^\d+$/.test(previous) && BigInt(previous) >= BigInt(epoch)) return;
      if (web?.storage) web.storage.setItem(`${RESPONSE_NAMESPACE}${key}`, epoch);
      else responses.set(key, epoch);
      // A received fence dominates all older coherent envelopes, even after
      // process death. Purge matching groups without restoring their content.
      for (const candidate of responses.getAllKeys()) {
        if (!candidate.startsWith(groupPrefix)) continue;
        const encoded = responses.getString(candidate);
        if (!encoded) continue;
        try {
          const envelope = JSON.parse(encoded) as { entries?: { snapshot?: { authority?: { scopes?: { authorityScope: string; epoch?: string }[] } } }[] };
          if (envelope.entries?.some(entry => entry.snapshot?.authority?.scopes?.some(authority => authority.authorityScope === scope &&
            (!authority.epoch || !/^\d+$/.test(authority.epoch) || BigInt(authority.epoch) <= BigInt(epoch)))))
            responses.delete(candidate);
        } catch { responses.delete(candidate); }
      }
    },
    remove: async (_key: string): Promise<void> => {
      // Group membership may span several datum keys. The fence operation
      // above purges every matching group in one storage event, not by LRU key.
    },
    subscribeFences: (listener: (scope: string, epoch: string) => void): (() => void) => {
      const receive = (key: string, epoch: string) => {
        if (!key.startsWith(fencePrefix) || !/^\d+$/.test(epoch)) return;
        try { listener(decodeURIComponent(key.slice(fencePrefix.length)), epoch); } catch { /* Invalid foreign key. */ }
      };
      routerFenceListeners.add(receive);
      for (const key of responses.getAllKeys()) {
        const epoch = responses.getString(key);
        if (epoch) receive(key, epoch);
      }
      return () => { routerFenceListeners.delete(receive); };
    },
  };
}

if (web?.storage && typeof window.addEventListener === 'function') {
  const shared = web.storage;
  window.addEventListener('storage', event => {
    if (event.storageArea !== shared || !event.key?.startsWith(`${RESPONSE_NAMESPACE}${ROUTER_FENCE_PREFIX}`) || !event.newValue) return;
    const key = event.key.slice(RESPONSE_NAMESPACE.length);
    for (const listener of routerFenceListeners) listener(key, event.newValue);
  });
}
