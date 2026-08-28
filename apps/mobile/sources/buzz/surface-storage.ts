import { MMKV } from 'react-native-mmkv';
import {
  SignedEventOutbox,
  SurfaceResponseCache,
  type Identity,
  type RoomView,
  type SignedOutboxRecord,
  type SurfaceCacheAddress,
} from '@beeline/buzz-client';
import { stripRetiredAgentNotices } from './retired-agent-notices';

const responses = new MMKV({ id: 'buzz-surface-responses' });
const mutations = new MMKV({ id: 'buzz-surface-outbox' });
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

export const mobileSurfaceCache = new SurfaceResponseCache(
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

export function surfaceAddress(
  relayOrigin: string,
  viewerPubkey: string,
  endpoint: string,
  params?: SurfaceCacheAddress['params'],
): SurfaceCacheAddress {
  return { relayOrigin, viewerPubkey, endpoint, ...(params ? { params } : {}) };
}

function outboxKey(viewerPubkey: string, roomId: string): string {
  return `${OUTBOX_PREFIX}${viewerPubkey}.${encodeURIComponent(roomId)}`;
}

/** One mutation-lifetime owner per mounted composer. It stores exact signed frames only. */
export function createRoomOutbox(identity: Pick<Identity, 'publicKey'>, roomId: string) {
  const key = outboxKey(identity.publicKey, roomId);
  return new SignedEventOutbox({
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
      if (records.length === 0) mutations.delete(key);
      else mutations.set(key, JSON.stringify(records));
    },
  });
}

export async function evictMobileSurfaceViewer(relayOrigin: string, viewerPubkey: string) {
  await mobileSurfaceCache.evictViewer(relayOrigin, viewerPubkey);
  for (const key of mutations.getAllKeys()) {
    if (key.startsWith(`${OUTBOX_PREFIX}${viewerPubkey}.`)) mutations.delete(key);
  }
}

export function clearMobileSurfaceStorage(): void {
  for (const key of responses.getAllKeys()) {
    if (key.startsWith(RESPONSE_PREFIX)) responses.delete(key);
  }
  for (const key of mutations.getAllKeys()) {
    if (key.startsWith(OUTBOX_PREFIX)) mutations.delete(key);
  }
}

/** Convenience type used only at the render boundary; cached values stay verbatim RoomView. */
export type CachedRoomSurface = RoomView;
