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

/** MMKV already provides the response synchronously. Restore it on the tap
 * stack so the first Room render has its complete validated DTO. */
export function restoreStoredSurface<T>(address: SurfaceCacheAddress, guard: (value: unknown) => value is T): T | null {
  return mobileSurfaceCache.restoreStored(address, guard,
    (key) => storedValue(responses.getString(storageKey(key)) ?? null));
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
const ROUTER_FLOOR_PREFIX = 'router.floor.';
const ROUTER_DENY_PREFIX = 'router.deny.';
const routerFenceListeners = new Set<(key: string, epoch: string) => void>();
const routerFloorListeners = new Set<(key: string, epoch: string) => void>();
const MAX_ROUTER_READER_BYTES = 32 * 1024 * 1024;
const epochValue = (value: string): string | undefined => /^\d{1,30}$/.test(value) ? BigInt(value).toString() : undefined;
type StoredAuthority = { authorityScope: string; epoch: string };
/** Native MMKV critical sections are synchronous in the sole JS owner. Web
 * needs an origin-scoped cross-tab lock for compare+persist+scrub atomicity.
 * Other legacy response consumers retain their existing storage behavior.
 */
export function routerAuthorityStorageReady(): boolean {
  return web === null || !!web.storage && typeof navigator !== 'undefined' && typeof navigator.locks?.request === 'function';
}
/** The existing durable command owner has a proven single native writer.
 * Browser command cohorts remain legacy until cross-tab intent adoption. */
export function routerCommandStorageReady():boolean{return web===null;}

/** Router groups use the existing response store, with one encoded atomic
 * data+cut+authority envelope. Denials and minimum floors live outside LRU.
 * Floors use immutable epoch keys: competing tabs cannot overwrite a higher
 * floor with a lower read/modify/write result. Older keys compact only after
 * the dominating epoch key is durable.
 */
export function routerLaneStorage(origin: string, principal: string) {
  const canonicalOrigin = new URL(origin).origin;
  const owner = encodeURIComponent(JSON.stringify([canonicalOrigin, principal]));
  const groupPrefix = `${ROUTER_GROUP_PREFIX}${owner}.`;
  const fencePrefix = `${ROUTER_FENCE_PREFIX}${owner}.`;
  const floorPrefix = `${ROUTER_FLOOR_PREFIX}${owner}.`;
  const denyPrefix = `${ROUTER_DENY_PREFIX}${owner}.`;
  const floorSeen = new Map<string, string>();
  const fenceSeen = new Map<string, string>();
  const groupKey = (key: string) => `${groupPrefix}${encodeURIComponent(key)}`;
  const fenceKey = (scope: string) => `${fencePrefix}${encodeURIComponent(scope)}`;
  const floorBase = (scope: string) => `${floorPrefix}${encodeURIComponent(scope)}.`;
  const denyBase = (scope: string) => `${denyPrefix}${encodeURIComponent(scope)}.`;
  const transaction = <T>(work: () => T): Promise<T> => {
    if (!web) { try { return Promise.resolve(work()); } catch (error) { return Promise.reject(error); } }
    if (!routerAuthorityStorageReady()) return Promise.reject(new Error('Cross-tab authority storage is unavailable.'));
    try { return navigator.locks.request(`beeline.router.authority.${owner}`, { mode: 'exclusive' }, work); }
    catch (error) { return Promise.reject(error); }
  };
  // Authority storage never swallows denied reads/writes: an unreadable fence
  // cannot be interpreted as permission to save a stale private envelope.
  const read = (key: string) => web?.storage ? web.storage.getItem(`${RESPONSE_NAMESPACE}${key}`) ?? undefined : responses.getString(key);
  const write = (key: string, value: string) => {
    if (web?.storage) web.storage.setItem(`${RESPONSE_NAMESPACE}${key}`, value); else responses.set(key, value);
  };
  const remove = (key: string) => {
    if (web?.storage) web.storage.removeItem(`${RESPONSE_NAMESPACE}${key}`); else responses.delete(key);
  };
  const keys = (): string[] => {
    if (!web?.storage) return responses.getAllKeys();
    const result: string[] = [];
    for (let index = 0; index < web.storage.length; index++) {
      const key = web.storage.key(index);
      if (key?.startsWith(RESPONSE_NAMESPACE)) result.push(key.slice(RESPONSE_NAMESPACE.length));
    }
    return result;
  };
  const maximum = (map: Map<string, string>, scope: string, epoch: string) => {
    const previous = map.get(scope);
    if (!previous || BigInt(previous) < BigInt(epoch)) map.set(scope, epoch);
    return map.get(scope)!;
  };
  const metadataRecord = (prefix: string, key: string): { scope: string; epoch: string } | undefined => {
    if (!key.startsWith(prefix)) return;
    const suffix = key.slice(prefix.length); const split = suffix.lastIndexOf('.');
    if (split < 1) return;
    const epoch = epochValue(suffix.slice(split + 1)); if (epoch === undefined) return;
    try {
      const scope = decodeURIComponent(suffix.slice(0, split));
      return scope && scope.length <= 256 ? { scope, epoch } : undefined;
    } catch { return; }
  };
  const floorRecord = (key: string) => metadataRecord(floorPrefix, key);
  const floors = (): ReadonlyMap<string, string> => {
    for (const key of keys()) {
      const record = floorRecord(key);
      // The immutable key is itself the durable lower bound; a corrupted
      // redundant value must never lower that bound.
      if (record) maximum(floorSeen, record.scope, record.epoch);
    }
    return floorSeen;
  };
  const denials = (): ReadonlyMap<string, string> => {
    for (const key of keys()) {
      const record = metadataRecord(denyPrefix, key);
      if (record) maximum(fenceSeen, record.scope, record.epoch);
      else if (key.startsWith(fencePrefix)) {
        const value = read(key); const epoch = value === undefined ? undefined : epochValue(value);
        if (epoch === undefined) continue;
        try { maximum(fenceSeen, decodeURIComponent(key.slice(fencePrefix.length)), epoch); } catch { /* Invalid legacy key. */ }
      }
    }
    return fenceSeen;
  };
  const authorities = (encoded: string): readonly StoredAuthority[] => {
    const value: unknown = JSON.parse(encoded);
    if (!value || typeof value !== 'object') throw new Error('Invalid router consistency group.');
    const envelope = value as { schema?: unknown; identity?: { origin?: unknown; principal?: unknown }; entries?: unknown };
    if (envelope.schema !== 1 || envelope.identity?.origin !== canonicalOrigin || envelope.identity?.principal !== principal ||
        !Array.isArray(envelope.entries) || !envelope.entries.length || envelope.entries.length > 256)
      throw new Error('Invalid router consistency group.');
    return envelope.entries.flatMap(entry => {
      const scopes = entry?.snapshot?.authority?.scopes;
      if (!Array.isArray(scopes) || !scopes.length || scopes.length > 8) throw new Error('Invalid router authority.');
      return scopes.map((scope: unknown) => {
        if (!scope || typeof scope !== 'object') throw new Error('Invalid router authority.');
        const item = scope as Partial<StoredAuthority>;
        if (typeof item.authorityScope !== 'string' || !item.authorityScope || item.authorityScope.length > 256 ||
            typeof item.epoch !== 'string') throw new Error('Invalid router authority.');
        const epoch = epochValue(item.epoch); if (epoch === undefined) throw new Error('Invalid router authority.');
        return { authorityScope: item.authorityScope, epoch };
      });
    });
  };
  const scrub = (scope: string, epoch: string, inclusive: boolean) => {
    for (const key of keys()) {
      if (!key.startsWith(groupPrefix)) continue;
      const encoded = read(key); if (!encoded) continue;
      try {
        if (authorities(encoded).some(authority => authority.authorityScope === scope &&
            (inclusive ? BigInt(authority.epoch) <= BigInt(epoch) : BigInt(authority.epoch) < BigInt(epoch)))) remove(key);
      } catch { remove(key); }
    }
  };
  const check = (scopes: readonly StoredAuthority[]) => {
    const minima = floors(); denials();
    for (const scope of scopes) {
      const stored = read(fenceKey(scope.authorityScope));
      const denial = stored === undefined ? fenceSeen.get(scope.authorityScope) : epochValue(stored);
      if (stored !== undefined && denial === undefined) throw new Error('Invalid stored authority fence.');
      if (denial !== undefined) maximum(fenceSeen, scope.authorityScope, denial);
      const denied = fenceSeen.get(scope.authorityScope); const minimum = minima.get(scope.authorityScope);
      if (denied !== undefined && BigInt(scope.epoch) <= BigInt(denied) || minimum !== undefined && BigInt(scope.epoch) < BigInt(minimum))
        throw new Error('Router authority is older than its durable fence.');
    }
  };
  return {
    write: async (key: string, encoded: string): Promise<void> => transaction(() => {
      const scopes = authorities(encoded); check(scopes);
      const target = groupKey(key); write(target, encoded);
      try { check(scopes); }
      catch (error) {
        // A competing tab may already have installed a newer same-key group.
        if (read(target) === encoded) remove(target);
        throw error;
      }
      const held = keys().filter(candidate => candidate.startsWith(groupPrefix));
      let total = held.reduce((sum, candidate) => sum + new TextEncoder().encode(read(candidate) ?? '').length, 0);
      for (const candidate of held) {
        if (total <= MAX_ROUTER_READER_BYTES) break;
        if (candidate === target) continue;
        total -= new TextEncoder().encode(read(candidate) ?? '').length; remove(candidate);
      }
    }),
    fence: async (scope: string, value: string): Promise<void> => transaction(() => {
      const epoch = epochValue(value); if (!scope || scope.length > 256 || epoch === undefined) throw new Error('Invalid authority fence.');
      const key = fenceKey(scope); const stored = read(key);
      const previous = stored === undefined ? undefined : epochValue(stored);
      if (stored !== undefined && previous === undefined) throw new Error('Invalid stored authority fence.');
      denials();
      const candidate = maximum(fenceSeen, scope, epoch);
      if (read(`${denyBase(scope)}${candidate}`) === undefined) write(`${denyBase(scope)}${candidate}`, candidate);
      const next = denials().get(scope)!;
      if (read(key) !== next) write(key, next);
      scrub(scope, next, true);
      for (const key of keys()) {
        const record = metadataRecord(denyPrefix, key);
        if (record?.scope === scope && BigInt(record.epoch) < BigInt(next)) remove(key);
      }
    }),
    floor: async (scope: string, value: string): Promise<void> => transaction(() => {
      const epoch = epochValue(value); if (!scope || scope.length > 256 || epoch === undefined) throw new Error('Invalid authority floor.');
      const previous = floors().get(scope);
      const current = maximum(floorSeen, scope, previous !== undefined && BigInt(previous) > BigInt(epoch) ? previous : epoch);
      if (read(`${floorBase(scope)}${current}`) === undefined) write(`${floorBase(scope)}${current}`, current);
      // A competing tab may have persisted a higher epoch during this write.
      const next = floors().get(scope) ?? current;
      scrub(scope, next, false);
      for (const key of keys()) {
        const record = floorRecord(key);
        if (record?.scope === scope && BigInt(record.epoch) < BigInt(next)) remove(key);
      }
    }),
    remove: async (key: string): Promise<void> => transaction(() => {
      // Only the canonical consistency-group key can erase an envelope.
      // Legacy datum-key removals deliberately miss: removing one member must
      // never erase a different atomic group's data/coverage.
      let address: unknown;
      try { address = JSON.parse(key); } catch { return; }
      if (!Array.isArray(address) || address.length !== 3 || address[0] !== canonicalOrigin ||
          address[1] !== principal || typeof address[2] !== 'string' || !address[2]) return;
      remove(groupKey(key));
    }),
    subscribeFences: (listener: (scope: string, epoch: string) => void): (() => void) => {
      const receive = (key: string, value: string) => {
        try {
          const record = metadataRecord(denyPrefix, key);
          if (!record && !key.startsWith(fencePrefix)) return;
          const epoch = record?.epoch ?? epochValue(value); if (epoch === undefined) return;
          const scope = record?.scope ?? decodeURIComponent(key.slice(fencePrefix.length));
          if (!scope || scope.length > 256) return;
          maximum(fenceSeen, scope, epoch); const next = denials().get(scope)!;
          void transaction(() => scrub(scope, denials().get(scope) ?? next, true)).catch(() => {});
          listener(scope, next);
        } catch { /* Invalid foreign key. */ }
      };
      routerFenceListeners.add(receive);
      for (const [scope, epoch] of denials()) {
        void transaction(() => scrub(scope, denials().get(scope) ?? epoch, true)).catch(() => {});
        listener(scope, epoch);
      }
      return () => { routerFenceListeners.delete(receive); };
    },
    subscribeFloors: (listener: (scope: string, epoch: string) => void): (() => void) => {
      const receive = (key: string, _value: string) => {
        const record = floorRecord(key); if (!record) return;
        maximum(floorSeen, record.scope, record.epoch); const next = floors().get(record.scope)!;
        void transaction(() => scrub(record.scope, floors().get(record.scope) ?? next, false)).catch(() => {});
        listener(record.scope, next);
      };
      routerFloorListeners.add(receive);
      for (const [scope, epoch] of floors()) {
        void transaction(() => scrub(scope, floors().get(scope) ?? epoch, false)).catch(() => {});
        listener(scope, epoch);
      }
      return () => { routerFloorListeners.delete(receive); };
    },
  };
}

if (web?.storage && typeof window.addEventListener === 'function') {
  const shared = web.storage;
  window.addEventListener('storage', event => {
    if (event.storageArea !== shared || !event.key?.startsWith(RESPONSE_NAMESPACE) || event.newValue === null) return;
    const key = event.key.slice(RESPONSE_NAMESPACE.length);
    if (key.startsWith(ROUTER_FENCE_PREFIX) || key.startsWith(ROUTER_DENY_PREFIX))
      for (const listener of routerFenceListeners) listener(key, event.newValue);
    if (key.startsWith(ROUTER_FLOOR_PREFIX)) for (const listener of routerFloorListeners) listener(key, event.newValue);
  });
}
