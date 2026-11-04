import type { MediaLink, MediaMetadata } from '@beeline/api-contract/media-metadata';
import type { RouterAuthorityCertificate } from '@beeline/api-contract/router-protocol';
import { subscribeClientReset } from '@/sync/client-reset';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
export type MediaCacheMetadata = MediaMetadata;
export type MediaCacheBoundary = Readonly<{ kind: 'connection' }> | Readonly<{ kind: 'identity' }> |
  Readonly<{ kind: 'revoke'; authorityScope: string; epoch: string; objectIds: readonly string[] }>;
type Connection = { origin: string; principal: string; generation: number; mediaMetadataV1: true; executeMetadata(objectId: string): Promise<MediaCacheMetadata>;
  executeLink?(objectId: string): Promise<MediaLink>; executePlayback?(objectId: string): Promise<MediaLink>;
  joinedMetadata?(objectId: string): void };
type Held = { metadata: MediaCacheMetadata; generation: number };
const listeners = new Set<(event: MediaCacheBoundary) => void>();
const displays = new Map<string, Set<object>>();
const recoveryListeners = new Set<() => void>();
let recoveryRevision = 0;
const held = new Map<string, Held>();
const flights = new Map<string, Promise<MediaCacheMetadata>>();
const playbacks = new Map<string, MediaCacheMetadata>();
const fences = new Map<string, string>();
let connection: Connection | undefined;
let transportMode: 'pending' | 'router' = 'pending';
let installedGeneration = -1;
let demandEpoch = 0;
const keyOf = (origin: string, principal: string, objectId: string) => JSON.stringify([new URL(origin).origin, principal, objectId]);
function notify(event: MediaCacheBoundary): void { for (const listener of listeners) listener(event); }
function authorized(value: RouterAuthorityCertificate): boolean {
  return !!value && Array.isArray(value.scopes) && value.scopes.length > 0 && value.scopes.length <= 8 && value.scopes.every((scope, index) =>
    !!scope && typeof scope.epoch === 'string' && /^(0|[1-9]\d{0,29})$/.test(scope.epoch) &&
    typeof scope.authorityScope === 'string' && scope.authorityScope.length > 0 && scope.authorityScope.length <= 256 &&
    (index === 0 || value.scopes[index - 1]!.authorityScope < scope.authorityScope) &&
    (!fences.has(scope.authorityScope) || BigInt(scope.epoch) > BigInt(fences.get(scope.authorityScope)!))) &&
    bytesToHex(sha256(utf8ToBytes(JSON.stringify(value.scopes)))) === value.digest;
}
const expiresAt = (value: MediaCacheMetadata) => Math.min(value.expiresAt, value.thumbnail?.expiresAt ?? Infinity);
function valid(value: MediaCacheMetadata, objectId: string): boolean {
  return value?.objectId === objectId && typeof value.sha256 === 'string' && /^[a-f0-9]{64}$/.test(value.sha256) &&
    Number.isSafeInteger(value.size) && value.size >= 0 && value.size <= 25 * 1024 * 1024 &&
    typeof value.mimeType === 'string' && value.mimeType.length <= 256 && Number.isSafeInteger(value.expiresAt) &&
    value.expiresAt > Date.now() && !!value.authority && authorized(value.authority) &&
    value.authority.scopes.some(scope => scope.authorityScope === `object:${objectId}`) &&
    (!value.thumbnail || value.thumbnail.size <= 16 * 1024 && value.thumbnail.size >= 0 &&
      Number.isSafeInteger(value.thumbnail.size) && /^[a-f0-9]{64}$/.test(value.thumbnail.sha256) &&
      /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(value.thumbnail.objectId) && typeof value.thumbnail.mimeType === 'string' &&
      ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(value.thumbnail.mimeType) &&
      Number.isSafeInteger(value.thumbnail.expiresAt) && value.thumbnail.expiresAt > Date.now() &&
      value.authority.scopes.some(scope => scope.authorityScope === `object:${value.thumbnail!.objectId}`));
}

/** Sole authenticated socket owner installs this closed metadata adapter only
 * after independent capability negotiation. No caller can manufacture support.
 */
export function installMediaCacheConnection(next: Connection | { generation: number; mediaMetadataV1: false }): void {
  if (next.generation <= installedGeneration) return;
  installedGeneration = next.generation; transportMode = next.mediaMetadataV1 ? 'router' : 'pending';
  connection = next.mediaMetadataV1 ? next : undefined; held.clear(); flights.clear(); playbacks.clear(); notify({ kind: 'connection' });
  if (next.mediaMetadataV1) { recoveryRevision++; for (const listener of recoveryListeners) listener(); }
}
/** Current mounted, actually visible byte/runnable displays only. Cache
 * inventories and hidden overscan rows never register here.
 */
export function retainMediaObjectDisplay(objectId: string): () => void {
  if (!displays.has(objectId) && displays.size >= 256) return () => {};
  const token = {}; const held = displays.get(objectId) ?? new Set<object>();
  held.add(token); displays.set(objectId, held);
  return () => { held.delete(token); if (!held.size && displays.get(objectId) === held) displays.delete(objectId); };
}
export function activeMediaObjectIds(): readonly string[] { return [...displays.keys()]; }
export function mediaRecoveryRevision(): number { return recoveryRevision; }
export function subscribeMediaRecovery(listener: () => void): () => void {
  recoveryListeners.add(listener); return () => { recoveryListeners.delete(listener); };
}
export function suspendMediaCacheConnection(): void {
  transportMode = 'pending'; connection = undefined; held.clear(); flights.clear(); playbacks.clear(); notify({ kind: 'connection' });
}
/** A real committed navigation change revokes visible byte/metadata ownership
 * while retaining the independently negotiated socket adapter.
 */
export function invalidateMediaCacheDemand(): void {
  demandEpoch++; held.clear(); flights.clear(); playbacks.clear(); notify({ kind: 'connection' });
}
export async function requestMediaLink(objectId: string): Promise<MediaLink> {
  const owner = connection; const epoch = demandEpoch;
  if (!owner?.mediaMetadataV1 || !owner.executeLink) throw new Error('File action is unavailable.');
  const metadata = await mediaMetadataFor(owner.origin, owner.principal, objectId);
  if (connection !== owner || epoch !== demandEpoch || !metadata || !valid(metadata, objectId)) throw new Error('File authority could not be verified.');
  const result = await owner.executeLink(objectId);
  if (connection !== owner || epoch !== demandEpoch || !valid(metadata, objectId)) throw new Error('File authority could not be verified.');
  return result;
}
export async function requestMediaPlayback(objectId: string): Promise<MediaLink> {
  const owner = connection; const epoch = demandEpoch;
  if (!owner?.mediaMetadataV1 || !owner.executePlayback) throw new Error('File action is unavailable.');
  // The actual Run/Reopen action admits both reads synchronously. A signed
  // capability alone is insufficient proof for keeping a private frame alive.
  const metadata = await mediaMetadataFor(owner.origin, owner.principal, objectId);
  if (connection !== owner || epoch !== demandEpoch || !metadata || !valid(metadata, objectId)) throw new Error('File authority could not be verified.');
  const result = await owner.executePlayback(objectId);
  if (connection !== owner || epoch !== demandEpoch || !valid(metadata, objectId)) throw new Error('File authority could not be verified.');
  playbacks.set(objectId, metadata);
  while (playbacks.size > 16) playbacks.delete(playbacks.keys().next().value!);
  return result;
}
export function receiveMediaAuthorityRemoval(authorityScope: string, epoch: string): void {
  if (!/^\d{1,30}$/.test(epoch)) return;
  const previous = fences.get(authorityScope);
  if (previous && BigInt(previous) >= BigInt(epoch)) return;
  fences.set(authorityScope, epoch);
  const objectIds = new Set<string>();
  for (const [key, value] of held) if (value.metadata.authority.scopes.some(scope =>
    scope.authorityScope === authorityScope && BigInt(scope.epoch) <= BigInt(epoch))) { objectIds.add(value.metadata.objectId); held.delete(key); }
  for (const [id, metadata] of playbacks) if (metadata.authority.scopes.some(scope =>
    scope.authorityScope === authorityScope && BigInt(scope.epoch) <= BigInt(epoch))) { objectIds.add(id); playbacks.delete(id); }
  notify({ kind: 'revoke', authorityScope, epoch, objectIds: [...objectIds] });
}
export function subscribeMediaCacheBoundary(listener: (event: MediaCacheBoundary) => void): () => void {
  listeners.add(listener); return () => { listeners.delete(listener); };
}

/** Explicit visible/open/save demand only. A valid held certificate permits
 * completed byte reuse; legacy capability absence never does.
 */
export function mediaMetadataFor(origin: string, principal: string, objectId: string): Promise<MediaCacheMetadata> {
  const owner = connection;
  const epoch = demandEpoch;
  if (!owner?.mediaMetadataV1) return Promise.reject(new Error('File authority is awaiting connection.'));
  const key = keyOf(origin, principal, objectId);
  const cached = held.get(key);
  if (cached?.generation === owner.generation && expiresAt(cached.metadata) > Date.now() && authorized(cached.metadata.authority)) {
    owner.joinedMetadata?.(objectId); return Promise.resolve(cached.metadata);
  }
  let flight = flights.get(key);
  if (flight) owner.joinedMetadata?.(objectId);
  if (!flight) {
    if (flights.size >= 64) return Promise.reject(new Error('Too many file metadata requests.'));
    flight = owner.executeMetadata(objectId).then(value => {
      if (connection !== owner || epoch !== demandEpoch || !valid(value, objectId)) throw new Error('File authority could not be verified.');
      held.set(key, { metadata: value, generation: owner.generation });
      while (held.size > 128) held.delete(held.keys().next().value!);
      return value;
    });
    flights.set(key, flight);
    void flight.finally(() => { if (flights.get(key) === flight) flights.delete(key); }).catch(() => {});
  }
  return flight;
}
export function mediaCertificateCurrent(metadata: MediaCacheMetadata): boolean {
  return !!connection?.mediaMetadataV1 && expiresAt(metadata) > Date.now() && [...held.values()].some(value => value.metadata === metadata &&
    value.generation === connection!.generation) && authorized(metadata.authority);
}
subscribeClientReset(() => {
  transportMode = 'pending'; installedGeneration = -1;
  connection = undefined; held.clear(); flights.clear(); playbacks.clear(); displays.clear(); fences.clear(); notify({ kind: 'identity' });
});
/** Local durable-fence adoption by a lazily loaded byte adapter. */
export function mediaCacheFences(): readonly (readonly [string, string])[] { return [...fences]; }

export function mediaMetadataAvailable(): boolean { return connection?.mediaMetadataV1 === true; }
export function mediaTransportMode(): 'pending' | 'router' { return transportMode; }
