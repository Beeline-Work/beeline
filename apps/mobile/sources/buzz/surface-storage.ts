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
import { selectIdentities } from './identity-records';
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
  },
  stripRetiredAgentNotices,
);
export const mobileSurfaceCache = new SurfaceRegistry(
  durableSurfaceCache, stripRetiredAgentNotices, selectIdentities);

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

function outboxKey(relayOrigin: string, viewerPubkey: string, roomId: string): string {
  return `${OUTBOX_PREFIX}${relayScope(relayOrigin)}.${viewerPubkey}.${encodeURIComponent(roomId)}`;
}

/** One mutation-lifetime owner per mounted composer. It stores exact prepared frames only. */
export function createRoomOutbox(
  relayOrigin: string,
  identity: Pick<Identity, 'publicKey'>,
  roomId: string,
) {
  const key = outboxKey(relayOrigin, identity.publicKey, roomId);
  return new SignedEventOutbox(
    {
      load: async () => {
        const encoded = mutations.getString(key);
        if (!encoded) return [];
        try {
          return JSON.parse(encoded) as SignedOutboxRecord[];
        } catch {
          mutations.delete(key);
          return [];
        }
      },
      save: async (records) => {
        const encoded = records.length === 0 ? undefined : JSON.stringify(records);
        if (encoded === undefined) mutations.delete(key);
        else mutations.set(key, encoded);
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
