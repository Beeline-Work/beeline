import type { AttachmentReference } from '@beeline/buzz-client';
import type { RouterAuthorityCertificate } from '@beeline/api-contract/router-protocol';
import { artifactByteDigest } from './artifact-byte-digest';
import { loadBuzzIdentity } from '@/auth/buzz-identity-storage';
import { clientResetGeneration } from '@/sync/client-reset';
import { getBuzzRuntimeConfig } from './runtime-config';
import { mediaIdFromUrl } from './artifact';
import { createArtifactByteStore } from './artifact-byte-store';
import { ImmutableByteCache, type ImmutableByteAddress } from './immutable-byte-cache';
import { mediaCacheFences, mediaCertificateCurrent, mediaMetadataFor, retainMediaObjectDisplay, subscribeMediaCacheBoundary } from './media-cache-connection';
export type ArtifactByteOptions = Readonly<{ signal?: AbortSignal; preview?: boolean; thumbnail?: boolean }>;
type Details = { format: string; authority?: RouterAuthorityCertificate; objectId: string; parentId: string; size?: number };
const details = new Map<string, Details>();
const store = createArtifactByteStore(key => details.get(key) ?? { format: 'bin' });
const cache: ImmutableByteCache = new ImmutableByteCache(store, async (address, bytes, signal): Promise<boolean> => {
  const size = details.get(cache.key(address))?.size;
  return (size === undefined || bytes.byteLength === size) &&
    (!/^[a-f0-9]{64}$/.test(address.version) || await artifactByteDigest(bytes, signal) === address.version);
});
const listeners = new Set<(ids: ReadonlySet<string> | null) => void>();
const watchedIds = new Map<string, number>();
let epoch = 0;
let adopted: Promise<void> | undefined;
export class ArtifactPreviewUnavailable extends Error { constructor() { super('A bounded preview is unavailable.'); this.name = 'ArtifactPreviewUnavailable'; } }
function formatOf(mime: string): string {
  if (mime === 'application/pdf') return 'pdf';
  if (mime === 'image/jpeg') return 'jpg';
  if (mime === 'image/png') return 'png';
  if (mime === 'image/gif') return 'gif';
  if (mime === 'image/webp') return 'webp';
  if (mime === 'image/svg+xml') return 'svg';
  return mime.startsWith('text/') ? 'txt' : 'bin';
}
cache.subscribePurge(keys => {
  const ids = keys && new Set(keys.flatMap(key => { const held = details.get(key); return held ? [held.objectId, held.parentId] : []; }));
  for (const listener of listeners) listener(ids);
});
subscribeMediaCacheBoundary(event => {
  if (event.kind === 'identity') { epoch++; void cache.purge().catch(() => {}); details.clear(); adopted = undefined; }
  else if (event.kind === 'connection') { epoch++; cache.suspend(); }
  else {
    const keys = [...details].filter(([, value]) => !value.authority || value.authority.scopes.some(scope =>
      scope.authorityScope === event.authorityScope && BigInt(scope.epoch) <= BigInt(event.epoch))).map(([key]) => key);
    // Fence active replies/UI synchronously before asynchronous disk eviction.
    void cache.purgeKeys(keys).then(async () => {
      const disk = await store.revoke(event.authorityScope, event.epoch);
      if (disk.length) await cache.purgeKeys(disk);
    }).catch(() => {});
  }
});

function adoptFences(): Promise<void> {
  return adopted ??= (async () => { for (const [scope, version] of mediaCacheFences()) await store.revoke(scope, version); })().catch(() => {});
}

/** Called by the existing authenticated artifact byte leaf. No feature can
 * choose a URL, transport or arbitrary operation through this owner.
 */
export async function readArtifactObject(attachment: AttachmentReference,
  read: (objectId: string, signal: AbortSignal, maxBytes: number) => Promise<Uint8Array>,
  options: ArtifactByteOptions = {}): Promise<{ bytes: Uint8Array; key: string; address: ImmutableByteAddress; mimeType: string; isCurrent(): boolean }> {
  if (attachment.expired) throw new Error('This file has expired.');
  const objectId = mediaIdFromUrl(attachment.url);
  if (!objectId) throw new Error('attachment is not a monolith media URL');
  const reset = clientResetGeneration(); const localEpoch = epoch;
  const origin = new URL(getBuzzRuntimeConfig().monolithUrl).origin;
  const identity = await loadBuzzIdentity();
  if (!identity || reset !== clientResetGeneration() || localEpoch !== epoch || options.signal?.aborted) throw new Error('The file belongs to another session.');
  const metadata = await mediaMetadataFor(origin, identity.publicKey, objectId);
  if (reset !== clientResetGeneration() || localEpoch !== epoch || options.signal?.aborted) throw new Error('The file is no longer visible.');
  const raster = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(attachment.mimeType);
  const source = options.thumbnail ? metadata?.thumbnail : options.preview && metadata && metadata.size > 16 * 1024
    ? raster ? metadata.thumbnail : undefined : metadata;
  if (options.thumbnail && !source) throw new ArtifactPreviewUnavailable();
  if (options.preview && metadata && !source) throw new ArtifactPreviewUnavailable();
  if (options.preview && (!source && (!Number.isSafeInteger(attachment.size) || attachment.size > 16 * 1024) || source && source.size > 16 * 1024))
    throw new ArtifactPreviewUnavailable();
  const id = source?.objectId ?? objectId;
  const mimeType = source?.mimeType ?? attachment.mimeType;
  const version = source?.sha256 ?? attachment.sha256 ?? id;
  const address = { origin, principal: identity.publicKey, objectId: id, version };
  const key = cache.key(address);
  if (!details.has(key) && details.size >= 512) {
    const expendable = [...details].find(([heldKey, value]) => !cache.hasFlight(heldKey) &&
      !watchedIds.has(value.objectId) && !watchedIds.has(value.parentId));
    if (!expendable) throw new Error('Too many files are visible.');
    details.delete(expendable[0]);
  }
  details.delete(key);
  details.set(key, { format: formatOf(mimeType), objectId: id, parentId: objectId, authority: metadata?.authority, size: source?.size });
  const current = () => reset === clientResetGeneration() && localEpoch === epoch &&
    new URL(getBuzzRuntimeConfig().monolithUrl).origin === origin && (!metadata || mediaCertificateCurrent(metadata));
  await adoptFences();
  const bytes = await cache.get(address, async signal => {
    const bytes = await read(id, signal, options.preview ? 16 * 1024 : 25 * 1024 * 1024);
    return bytes;
  }, { signal: options.signal, restoreAuthorized: !!metadata, reuseAuthorized: !!metadata, isCurrent: current,
    maxBytes: options.preview ? 16 * 1024 : 25 * 1024 * 1024 });
  if (!current() || options.signal?.aborted) throw new Error('The file is no longer visible.');
  return { bytes, key, address, mimeType, isCurrent: current };
}
export async function artifactObjectLocalUri(key: string): Promise<string> {
  const uri = await store.localUri(key);
  if (!uri) throw new Error('The file could not be saved to the local cache.');
  return uri;
}
export function subscribeArtifactBytesPurge(attachment: AttachmentReference, listener: () => void): () => void {
  const objectId = mediaIdFromUrl(attachment.url);
  const releaseDisplay = objectId ? retainMediaObjectDisplay(objectId) : () => {};
  if (objectId) watchedIds.set(objectId, (watchedIds.get(objectId) ?? 0) + 1);
  const receive = (ids: ReadonlySet<string> | null) => { if (!ids || objectId && ids.has(objectId)) listener(); };
  listeners.add(receive); return () => {
    if (!listeners.delete(receive)) return;
    releaseDisplay();
    if (objectId) {
      const count = (watchedIds.get(objectId) ?? 1) - 1;
      if (count) watchedIds.set(objectId, count); else watchedIds.delete(objectId);
    }
  };
}
