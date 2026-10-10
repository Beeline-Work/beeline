import { MMKV } from 'react-native-mmkv';
import { webStringStorage } from '@/sync/browser-string-storage';
import {
  SignedEventOutbox,
  SurfaceResponseCache,
  type Identity,
  type RoomView,
  type SignedOutboxRecord,
  type SurfaceCacheAddress,
} from '@beeline/buzz-client';
import { stripRetiredAgentNotices } from './retired-agent-notices';
import { isUnsignedMonolithMessage } from './unsigned-monolith-message';
import { SurfaceRegistry } from './surface-registry';
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
    keys: async () =>
      responses.getAllKeys().flatMap((key) => {
        const decoded = decodedStorageKey(key);
        return decoded === null ? [] : [decoded];
      }),
  },
  stripRetiredAgentNotices,
);
export const mobileSurfaceCache = new SurfaceRegistry(durableSurfaceCache, stripRetiredAgentNotices);

// Another tab's sign-out removes the shared responses; drop this tab's hot
// copies so it neither shows nor writes them back.
if (web?.storage && typeof window.addEventListener === 'function') {
  const shared = web.storage;
  window.addEventListener('storage', (event) => {
    if (event.storageArea !== shared) return;
    if (event.key === null || (event.newValue === null && event.key.startsWith(RESPONSE_NAMESPACE)))
      mobileSurfaceCache.clear();
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

function outboxKey(relayOrigin: string, viewerPubkey: string, roomId: string): string {
  return `${OUTBOX_PREFIX}${relayScope(relayOrigin)}.${viewerPubkey}.${encodeURIComponent(roomId)}`;
}

/** The key before outboxes were scoped to a relay. */
function unscopedOutboxKey(viewerPubkey: string, roomId: string): string {
  return `${OUTBOX_PREFIX}${viewerPubkey}.${encodeURIComponent(roomId)}`;
}

/** One mutation-lifetime owner per mounted composer. It stores exact prepared frames only. */
export function createRoomOutbox(
  relayOrigin: string,
  identity: Pick<Identity, 'publicKey'>,
  roomId: string,
) {
  const key = outboxKey(relayOrigin, identity.publicKey, roomId);
  const unscopedKey = unscopedOutboxKey(identity.publicKey, roomId);
  return new SignedEventOutbox(
    {
      load: async () => {
        let encoded = mutations.getString(key);
        if (!encoded) {
          // Unsent messages from before the relay scope move to the relay that
          // first opens their Room, as they did before.
          encoded = mutations.getString(unscopedKey);
          if (encoded) {
            mutations.set(key, encoded);
            mutations.delete(unscopedKey);
          }
        }
        if (!encoded) return [];
        try {
          return JSON.parse(encoded) as SignedOutboxRecord[];
        } catch {
          mutations.delete(key);
          return [];
        }
      },
      save: async (records) => {
        if (records.length === 0) mutations.delete(key);
        else mutations.set(key, JSON.stringify(records));
      },
    },
    {
      acceptUnsignedEvent: isUnsignedMonolithMessage,
    },
  );
}

export function clearMobileSurfaceStorage(): void {
  mobileSurfaceCache.clear();
  for (const key of responses.getAllKeys()) {
    if (key.startsWith(RESPONSE_PREFIX)) responses.delete(key);
  }
  for (const key of mutations.getAllKeys()) {
    if (key.startsWith(OUTBOX_PREFIX)) mutations.delete(key);
  }
}

/** Convenience type used only at the render boundary; cached values stay verbatim RoomView. */
export type CachedRoomSurface = RoomView;
