import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { resetClientState } from '@/sync/client-reset';
const mocks = vi.hoisted(() => ({ disk: new Map<string, Uint8Array>(), origin: 'https://media.test', principal: 'ada' }));
vi.mock('@/auth/buzz-identity-storage', () => ({ loadBuzzIdentity: async () => ({ publicKey: mocks.principal }) }));
vi.mock('./runtime-config', () => ({ getBuzzRuntimeConfig: () => ({ monolithUrl: mocks.origin }) }));
vi.mock('./artifact-byte-store', () => ({ createArtifactByteStore: () => ({
  get: async (key: string) => mocks.disk.get(key) ?? null,
  set: async (key: string, bytes: Uint8Array) => { mocks.disk.set(key, bytes); },
  remove: async (key: string) => { mocks.disk.delete(key); }, clear: async () => { mocks.disk.clear(); },
  revoke: async () => [], localUri: async () => 'file:///synthetic/cache.png',
}) }));
import { readArtifactObject, subscribeArtifactBytesPurge } from './artifact-byte-owner';
import { installMediaCacheConnection, receiveMediaAuthorityRemoval, suspendMediaCacheConnection } from './media-cache-connection';
const id = '11111111-1111-4111-8111-111111111111';
const attachment = { url: `/v1/media/${id}`, name: 'photo.png', mimeType: 'image/png', size: 3, kind: 'artifact' as const };
const bytes = new Uint8Array([1, 2, 3]);
const drain = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
function install(capable = true, size = 3) {
  const scopes = [{ authorityScope: `object:${id}`, epoch: '1' }];
  installMediaCacheConnection({ generation: 1, mediaMetadataV1: capable, executeMetadata: async () => ({
    objectId: id, sha256: bytesToHex(sha256(bytes)), size, mimeType: 'image/png', expiresAt: Date.now() + 60_000,
    authority: { scopes, digest: bytesToHex(sha256(utf8ToBytes(JSON.stringify(scopes)))) },
  }) });
}
beforeEach(async () => { resetClientState(); await drain(); mocks.disk.clear(); mocks.origin = 'https://media.test'; mocks.principal = 'ada'; });
describe('the shared artifact byte owner', () => {
  it('preview, native view and save use one current immutable object flight and completion', async () => {
    install(); let resolve!: (value: Uint8Array) => void;
    const read = vi.fn(() => new Promise<Uint8Array>(done => { resolve = done; }));
    const requests = [readArtifactObject(attachment, read, { preview: true }), readArtifactObject(attachment, read), readArtifactObject(attachment, read)];
    await drain(); expect(read).toHaveBeenCalledTimes(1); resolve(bytes); await Promise.all(requests);
    expect((await readArtifactObject(attachment, read)).bytes).toEqual(bytes); expect(read).toHaveBeenCalledTimes(1);
  });
  it('legacy servers coalesce live requests but never reuse completed private bytes', async () => {
    install(false); const read = vi.fn(async () => bytes);
    await Promise.all([readArtifactObject(attachment, read), readArtifactObject(attachment, read)]);
    await readArtifactObject(attachment, read); expect(read).toHaveBeenCalledTimes(2);
  });
  it('capable disconnect never silently downgrades a later Open to legacy byte HTTP', async () => {
    install(); const read = vi.fn(async () => bytes); await readArtifactObject(attachment, read);
    suspendMediaCacheConnection();
    await expect(readArtifactObject(attachment, read)).rejects.toThrow('awaiting connection');
    expect(read).toHaveBeenCalledTimes(1);
    installMediaCacheConnection({ generation: 2, mediaMetadataV1: false });
    await readArtifactObject(attachment, read); expect(read).toHaveBeenCalledTimes(2);
  });
  it('refuses eager whole-document or unbounded legacy previews', async () => {
    install(false); const read = vi.fn(async () => bytes);
    await expect(readArtifactObject({ ...attachment, size: 32 * 1024 }, read, { preview: true })).rejects.toThrow('bounded preview');
    await expect(readArtifactObject(attachment, read, { preview: true, thumbnail: true })).rejects.toThrow('bounded preview');
    expect(read).not.toHaveBeenCalled();
  });
  it('a known large object cannot use a small legacy attachment size to start an eager preview', async () => {
    install(true, 32 * 1024); const read = vi.fn(async () => bytes);
    await expect(readArtifactObject(attachment, read, { preview: true })).rejects.toThrow('bounded preview');
    expect(read).not.toHaveBeenCalled();
  });
  it('committed object removal clears the existing source and fences bytes without a replacement read', async () => {
    install(); const read = vi.fn(async () => bytes); const clear = vi.fn();
    const stop = subscribeArtifactBytesPurge(attachment, clear);
    await readArtifactObject(attachment, read); receiveMediaAuthorityRemoval(`object:${id}`, '1');
    expect(clear).toHaveBeenCalledTimes(1);
    await expect(readArtifactObject(attachment, read)).rejects.toThrow('authority'); expect(read).toHaveBeenCalledTimes(1); stop();
  });
  it('a view that disappears while metadata is pending starts no byte transfer', async () => {
    install(); const controller = new AbortController(); const read = vi.fn(async () => bytes);
    const pending = readArtifactObject(attachment, read, { signal: controller.signal }); controller.abort();
    await expect(pending).rejects.toThrow(); expect(read).not.toHaveBeenCalled();
  });
});
