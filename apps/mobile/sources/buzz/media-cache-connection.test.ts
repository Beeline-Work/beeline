import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import type { MediaMetadata } from '@beeline/api-contract/media-metadata';
import { resetClientState } from '@/sync/client-reset';
import { installMediaCacheConnection, mediaCertificateCurrent, mediaMetadataFor, receiveMediaAuthorityRemoval,
  invalidateMediaCacheDemand, requestMediaLink, requestMediaPlayback, subscribeMediaCacheBoundary, suspendMediaCacheConnection } from './media-cache-connection';
const id = '11111111-1111-4111-8111-111111111111';
const thumbId = '22222222-2222-4222-8222-222222222222';
const origin = 'https://media.example.test';
type Mutable<T> = { -readonly [K in keyof T]: T[K] extends object ? Mutable<T[K]> : T[K] };
const now = 1_800_000_000_000;
function metadata(epoch = '1', thumbnail = false): Mutable<MediaMetadata> {
  const scopes = [id, ...(thumbnail ? [thumbId] : [])].map(value => ({ authorityScope: `object:${value}`, epoch }));
  return { objectId: id, size: 3, mimeType: 'image/png', sha256: 'a'.repeat(64), expiresAt: now + 60_000,
    authority: { scopes, digest: bytesToHex(sha256(utf8ToBytes(JSON.stringify(scopes)))) },
    ...(thumbnail ? { thumbnail: { objectId: thumbId, size: 2, mimeType: 'image/png', sha256: 'b'.repeat(64), expiresAt: now + 1000 } } : {}) };
}
beforeEach(() => { resetClientState(); vi.spyOn(Date, 'now').mockReturnValue(now); });
afterEach(() => { resetClientState(); vi.restoreAllMocks(); });
describe('independently negotiated current media authority', () => {
  it('does not dispatch metadata on a legacy server or on install/suspend boundaries', async () => {
    const executeMetadata = vi.fn(async () => metadata());
    installMediaCacheConnection({ generation: 1, mediaMetadataV1: false });
    await expect(mediaMetadataFor(origin, 'ada', id)).rejects.toThrow('awaiting connection');
    suspendMediaCacheConnection(); expect(executeMetadata).not.toHaveBeenCalled();
  });
  it('authority unavailability parks a capable route until an explicit new negotiation', async () => {
    const executeMetadata = vi.fn(async () => metadata());
    installMediaCacheConnection({ origin, principal: 'ada', generation: 1, mediaMetadataV1: true, executeMetadata });
    await mediaMetadataFor(origin, 'ada', id); suspendMediaCacheConnection();
    await expect(mediaMetadataFor(origin, 'ada', id)).rejects.toThrow('awaiting connection');
    expect(executeMetadata).toHaveBeenCalledTimes(1);
    installMediaCacheConnection({ generation: 2, mediaMetadataV1: false });
    await expect(mediaMetadataFor(origin, 'ada', id)).rejects.toThrow('awaiting connection');
  });
  it('shares explicit metadata demand, partitions principal/origin and suspends held certificates', async () => {
    const value = metadata(); const executeMetadata = vi.fn(async () => value);
    installMediaCacheConnection({ origin, principal: 'ada', generation: 1, mediaMetadataV1: true, executeMetadata });
    const [a, b] = await Promise.all([mediaMetadataFor(origin, 'ada', id), mediaMetadataFor(origin, 'ada', id)]);
    expect(a).toBe(b); expect(executeMetadata).toHaveBeenCalledTimes(1); expect(mediaCertificateCurrent(value)).toBe(true);
    await mediaMetadataFor(origin, 'grace', id); await mediaMetadataFor('https://other.test', 'ada', id);
    expect(executeMetadata).toHaveBeenCalledTimes(3);
    suspendMediaCacheConnection(); expect(mediaCertificateCurrent(value)).toBe(false); expect(executeMetadata).toHaveBeenCalledTimes(3);
  });
  it.each([
    ['expired thumbnail', (v: Mutable<MediaMetadata>) => { v.thumbnail!.expiresAt = now; }],
    ['fractional expiry', (v: Mutable<MediaMetadata>) => { v.thumbnail!.expiresAt = now + 0.5; }],
    ['foreign object id', (v: Mutable<MediaMetadata>) => { v.thumbnail!.objectId = 'foreign'; }],
    ['markup thumbnail', (v: Mutable<MediaMetadata>) => { v.thumbnail!.mimeType = 'image/svg+xml'; }],
    ['oversized thumbnail', (v: Mutable<MediaMetadata>) => { v.thumbnail!.size = 16 * 1024 + 1; }],
    ['invalid digest', (v: Mutable<MediaMetadata>) => { v.authority.digest = '0'.repeat(64); }],
    ['malformed scopes', (v: Mutable<MediaMetadata>) => { (v.authority as unknown as { scopes: unknown }).scopes = null; }],
    ['missing object domain', (v: Mutable<MediaMetadata>) => {
      v.authority.scopes = [{ authorityScope: 'room:foreign', epoch: '1' }];
      v.authority.digest = bytesToHex(sha256(utf8ToBytes(JSON.stringify(v.authority.scopes))));
    }],
  ])('rejects %s without authorizing bytes', async (_name, corrupt) => {
    const value = metadata('1', true); corrupt(value);
    installMediaCacheConnection({ origin, principal: 'ada', generation: 1, mediaMetadataV1: true, executeMetadata: async () => value });
    await expect(mediaMetadataFor(origin, 'ada', id)).rejects.toThrow('authority'); expect(mediaCertificateCurrent(value)).toBe(false);
  });
  it('held and in-flight joins consume the exact unused owner permit without dispatching a second read', async () => {
    let resolve!: (value: MediaMetadata) => void; const joinedMetadata = vi.fn();
    const executeMetadata = vi.fn(() => new Promise<MediaMetadata>(done => { resolve = done; }));
    installMediaCacheConnection({ origin, principal: 'ada', generation: 1, mediaMetadataV1: true, executeMetadata, joinedMetadata });
    const first = mediaMetadataFor(origin, 'ada', id); expect(joinedMetadata).not.toHaveBeenCalled();
    const second = mediaMetadataFor(origin, 'ada', id); expect(joinedMetadata).toHaveBeenCalledTimes(1);
    resolve(metadata()); await Promise.all([first, second]); await mediaMetadataFor(origin, 'ada', id);
    expect(joinedMetadata).toHaveBeenCalledTimes(2); expect(joinedMetadata).toHaveBeenNthCalledWith(1, id);
    expect(executeMetadata).toHaveBeenCalledTimes(1);
  });
  it('uses the earlier parent/thumbnail expiry at each explicit demand without a refresh timer', async () => {
    const value = metadata('1', true); const executeMetadata = vi.fn(async () => value);
    installMediaCacheConnection({ origin, principal: 'ada', generation: 1, mediaMetadataV1: true, executeMetadata });
    await mediaMetadataFor(origin, 'ada', id); vi.mocked(Date.now).mockReturnValue(now + 1001);
    expect(mediaCertificateCurrent(value)).toBe(false); expect(executeMetadata).toHaveBeenCalledTimes(1);
    await expect(mediaMetadataFor(origin, 'ada', id)).rejects.toThrow('authority'); expect(executeMetadata).toHaveBeenCalledTimes(2);
  });
  it('fences pending old authority while preserving a newer current grant', async () => {
    let resolve!: (value: MediaMetadata) => void;
    const executeMetadata = vi.fn(() => new Promise<MediaMetadata>(done => { resolve = done; }));
    installMediaCacheConnection({ origin, principal: 'ada', generation: 1, mediaMetadataV1: true, executeMetadata });
    const pending = mediaMetadataFor(origin, 'ada', id); receiveMediaAuthorityRemoval(`object:${id}`, '1'); resolve(metadata());
    await expect(pending).rejects.toThrow('authority');
    const newer = metadata('3'); executeMetadata.mockResolvedValue(newer);
    await mediaMetadataFor(origin, 'ada', id); receiveMediaAuthorityRemoval(`object:${id}`, '2');
    expect(mediaCertificateCurrent(newer)).toBe(true);
  });
  it('holds runnable authority so a Room removal identifies the existing private frame', async () => {
    const value = metadata(); const roomScope = 'room:33333333-3333-4333-8333-333333333333';
    value.authority.scopes.push({ authorityScope: roomScope, epoch: '1' });
    value.authority.digest = bytesToHex(sha256(utf8ToBytes(JSON.stringify(value.authority.scopes))));
    const executeMetadata = vi.fn(async () => value); const executePlayback = vi.fn(async () => ({ url: 'https://games.test/play/object', expiresIn: 60 }));
    const boundary = vi.fn(); const stop = subscribeMediaCacheBoundary(boundary);
    installMediaCacheConnection({ origin, principal: 'ada', generation: 1, mediaMetadataV1: true, executeMetadata, executePlayback });
    await requestMediaPlayback(id); receiveMediaAuthorityRemoval(roomScope, '1');
    expect(boundary).toHaveBeenLastCalledWith({ kind: 'revoke', authorityScope: roomScope, epoch: '1', objectIds: [id] });
    expect(executeMetadata).toHaveBeenCalledTimes(1); expect(executePlayback).toHaveBeenCalledTimes(1); stop();
  });
  it('does not let a disconnected metadata reply become current and emits no replacement request', async () => {
    const boundary = vi.fn(); const stop = subscribeMediaCacheBoundary(boundary);
    let resolve!: (value: MediaMetadata) => void;
    const executeMetadata = vi.fn(() => new Promise<MediaMetadata>(done => { resolve = done; }));
    installMediaCacheConnection({ origin, principal: 'ada', generation: 1, mediaMetadataV1: true, executeMetadata });
    const pending = mediaMetadataFor(origin, 'ada', id); suspendMediaCacheConnection(); resolve(metadata());
    await expect(pending).rejects.toThrow('authority'); expect(executeMetadata).toHaveBeenCalledTimes(1);
    expect(boundary.mock.calls.map(([event]) => event.kind)).toEqual(['connection', 'connection']); stop();
  });
});


it('F07/F23: preview, browser link and playable artifact join one current metadata flight', async () => {
  let finish!: (value: MediaMetadata) => void;
  const executeMetadata = vi.fn(() => new Promise<MediaMetadata>(resolve => { finish = resolve; }));
  const joinedMetadata = vi.fn();
  const executeLink = vi.fn(async () => ({ url: 'https://files.test/object', expiresIn: 60 }));
  const executePlayback = vi.fn(async () => ({ url: 'https://games.test/play/object', expiresIn: 60 }));
  installMediaCacheConnection({ origin, principal: 'ada', generation: 1, mediaMetadataV1: true, executeMetadata, joinedMetadata, executeLink, executePlayback });
  const preview = mediaMetadataFor(origin, 'ada', id), link = requestMediaLink(id), play = requestMediaPlayback(id);
  expect(executeMetadata).toHaveBeenCalledTimes(1);
  expect(joinedMetadata).toHaveBeenCalledTimes(2);
  expect(executeLink).not.toHaveBeenCalled(); expect(executePlayback).not.toHaveBeenCalled();
  finish(metadata()); await Promise.all([preview, link, play]);
  expect(executeMetadata).toHaveBeenCalledTimes(1);
  expect(executeLink).toHaveBeenCalledTimes(1); expect(executePlayback).toHaveBeenCalledTimes(1);
});

it.each(['revoke', 'navigate', 'disconnect'] as const)('F23: %s fences a signed link reply without an automatic repeat', async boundary => {
  let finish!: (value: { url: string; expiresIn: number }) => void;
  const executeMetadata = vi.fn(async () => metadata());
  const executeLink = vi.fn(() => new Promise<{ url: string; expiresIn: number }>(resolve => { finish = resolve; }));
  installMediaCacheConnection({ origin, principal: 'ada', generation: 1, mediaMetadataV1: true, executeMetadata, executeLink });
  const link = requestMediaLink(id); const assertion = expect(link).rejects.toThrow('authority');
  await vi.waitFor(() => expect(executeLink).toHaveBeenCalledTimes(1));
  if (boundary === 'revoke') receiveMediaAuthorityRemoval(`object:${id}`, '1');
  if (boundary === 'navigate') invalidateMediaCacheDemand();
  if (boundary === 'disconnect') suspendMediaCacheConnection();
  finish({ url: 'https://files.test/stale', expiresIn: 60 }); await assertion;
  expect(executeMetadata).toHaveBeenCalledTimes(1); expect(executeLink).toHaveBeenCalledTimes(1);
});
