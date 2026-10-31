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
    if (key.startsWith(RESPONSE_PREFIX)) responses.delete(key);
  }
}
