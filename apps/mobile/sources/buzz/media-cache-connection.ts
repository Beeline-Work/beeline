import type { MediaLink, MediaMetadata } from '@beeline/api-contract/media-metadata';
import { subscribeClientReset } from '@/sync/client-reset';
import { monolithPhoneOperation } from '@/sync/transport/monolith-operation';

export type MediaCacheBoundary = Readonly<{ kind: 'identity' }>;
const listeners = new Set<(event: MediaCacheBoundary) => void>();
const flights = new Map<string, Promise<MediaMetadata>>();
const replies = new WeakMap<MediaMetadata, number>();
let epoch = 0;

export function requestMediaLink(objectId: string): Promise<MediaLink> {
  return monolithPhoneOperation('readMediaLink', { objectId });
}
export function requestMediaPlayback(objectId: string): Promise<MediaLink> {
  return monolithPhoneOperation('readMediaPlayback', { objectId });
}
export function subscribeMediaCacheBoundary(listener: (event: MediaCacheBoundary) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Concurrent displays share the same ordinary authenticated metadata read. */
export function mediaMetadataFor(origin: string, principal: string, objectId: string): Promise<MediaMetadata> {
  const key = JSON.stringify([origin, principal, objectId]);
  const held = flights.get(key);
  if (held) return held;
  const started = epoch;
  const flight = monolithPhoneOperation('readMediaMetadata', { objectId }).then(value => {
    if (started !== epoch) throw new Error('The file belongs to another session.');
    replies.set(value, started);
    return value;
  });
  flights.set(key, flight);
  const finish = () => { if (flights.get(key) === flight) flights.delete(key); };
  flight.then(finish, finish);
  return flight;
}
export function mediaMetadataCurrent(metadata: MediaMetadata): boolean {
  return replies.get(metadata) === epoch && metadata.expiresAt > Date.now() && (!metadata.thumbnail || metadata.thumbnail.expiresAt > Date.now());
}
subscribeClientReset(() => {
  epoch++;
  flights.clear();
  for (const listener of listeners) listener({ kind: 'identity' });
});
