vi.mock('@/buzz/router-owner', () => ({ routerOwnerArtifactAction: vi.fn() }));
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  monolithUrl: 'https://server.usebeeline.app',
  mediaMode: { value: 'router' as 'pending' | 'router' },
  bytes: new Uint8Array(), playback: vi.fn(), link: vi.fn(),
  authorization: vi.fn(),
  fetch: vi.fn(),
  openExternalUrl: vi.fn(),
  writeAsStringAsync: vi.fn(),
  platformOS: { value: 'ios' as 'ios' | 'android' | 'web' },
}));

vi.mock('react-native', () => ({
  Platform: {
    get OS() {
      return mocks.platformOS.value;
    },
  },
}));
vi.mock('@/buzz/runtime-config', () => ({
  getBuzzRuntimeConfig: () => ({ monolithUrl: mocks.monolithUrl }),
}));
vi.mock('@/auth/monolith-session', () => ({
  monolithSession: { authorization: mocks.authorization, fetch: mocks.fetch },
}));
vi.mock('@/auth/buzz-identity-storage', () => ({ loadBuzzIdentity: async () => ({ publicKey: 'synthetic-reader' }) }));
vi.mock('./media-cache-connection', async () => {
  const {sha256}=await import('@noble/hashes/sha2.js');const {bytesToHex}=await import('@noble/hashes/utils.js');
  return {retainMediaObjectDisplay:()=>()=>{},mediaTransportMode:()=>mocks.mediaMode.value,
    requestMediaPlayback:mocks.playback,requestMediaLink:mocks.link,
    mediaMetadataAvailable:()=>true,mediaMetadataFor:async(_origin:string,_principal:string,objectId:string)=>({
      objectId,sha256:bytesToHex(sha256(mocks.bytes)),size:mocks.bytes.length,mimeType:'image/jpeg',
      expiresAt:Date.now()+60000,authority:{digest:'synthetic',scopes:[]}}),
    mediaCertificateCurrent:()=>true,mediaCacheFences:()=>[],subscribeMediaCacheBoundary:()=>()=>{}};
});
vi.mock('./artifact-byte-store', () => ({ createArtifactByteStore: () => ({ get: async () => null, set: async () => {}, remove: async () => {}, clear: async () => {}, revoke: async () => [], localUri: async () => 'file:///cache/immutable-photo.jpg' }) }));
vi.mock('@/sync/transport/monolith-operation', () => ({ monolithPhoneOperation: vi.fn() }));
vi.mock('@/modal', () => ({ Modal: { alert: vi.fn() } }));
vi.mock('@/utils/open-external-url', () => ({ openExternalUrl: mocks.openExternalUrl }));
vi.mock('expo-file-system/legacy', () => ({
  cacheDirectory: 'file:///cache/',
  writeAsStringAsync: mocks.writeAsStringAsync,
  EncodingType: { Base64: 'base64' },
}));

import {
  artifactBase64,
  artifactImageSource,
  artifactMediaUrl,
  openArtifactInBrowser,
  runnableArtifactUrl,
  releaseArtifactImageSource,
} from './artifact-link';

const ID = '9f0f6a50-1111-4222-8333-444455556666';

function attachment(url: string) {
  return { url, name: 'photo.jpg', mimeType: 'image/jpeg', kind: 'artifact' as const };
}

/** A session response carrying the given bytes, as `fetchArtifactBytes` reads one. */
function bytesResponse(bytes: Uint8Array) {
  mocks.bytes=bytes;
  return {
    ok: true,
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  };
}

beforeEach(() => {
  mocks.authorization.mockReset();
  mocks.fetch.mockReset();
  mocks.authorization.mockResolvedValue('access-token');
  mocks.platformOS.value = 'ios';
  mocks.mediaMode.value = 'router';mocks.playback.mockReset();mocks.link.mockReset();
});

describe('the artifact media url is rebuilt against the monolith origin', () => {
  it('prefixes a stored relative path', () => {
    expect(artifactMediaUrl(attachment(`/v1/media/${ID}`))).toBe(`${mocks.monolithUrl}/v1/media/${ID}`);
  });

  it('sends an absolute monolith url to the configured origin, not the stored host', () => {
    expect(artifactMediaUrl(attachment(`https://other.example/v1/media/${ID}`))).toBe(
      `${mocks.monolithUrl}/v1/media/${ID}`,
    );
  });

  it('refuses a stored url that is not a monolith media path', () => {
    expect(() => artifactMediaUrl(attachment('https://evil.example/steal'))).toThrow(
      /not a monolith media URL/,
    );
  });
});

describe('the authenticated image source', () => {
  it('gives native the shared local bytes and never a separate bearer Image request', async () => {
    mocks.fetch.mockResolvedValue(bytesResponse(new Uint8Array([1, 2, 3])));
    const source = await artifactImageSource(attachment(`https://evil.example/v1/media/${ID}`));
    expect(source).toEqual({ uri: 'file:///cache/immutable-photo.jpg' });
    expect(mocks.fetch).toHaveBeenCalledWith(`${mocks.monolithUrl}/v1/media/${ID}`, { signal: expect.any(AbortSignal) }, { timeoutMs: 20_000 });
    expect(mocks.authorization).not.toHaveBeenCalled();
  });

  it('never hands the token to a host the stored url named', async () => {
    await expect(artifactImageSource(attachment('https://evil.example/anything'))).rejects.toThrow(
      /not a monolith media URL/,
    );
    expect(mocks.authorization).not.toHaveBeenCalled();
  });

  // On web an `<img>` cannot carry an authorization header, so the desktop
  // pane used to have no way to paint an artifact image at all. The bytes come
  // through the session instead and reach the DOM as an object URL.
  it('on web hands the DOM an object URL built from session bytes, not a bare link', async () => {
    mocks.platformOS.value = 'web';
    const created: Blob[] = [];
    const createObjectURL = vi.fn((blob: Blob) => {
      created.push(blob);
      return 'blob:https://app.usebeeline.app/artifact-1';
    });
    vi.spyOn(URL, 'createObjectURL').mockImplementation(createObjectURL);
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    mocks.fetch.mockResolvedValue(bytesResponse(new Uint8Array([137, 80, 78, 71])));
    const source = await artifactImageSource(attachment(`/v1/media/${ID}`));
    expect(source).toEqual({ uri: 'blob:https://app.usebeeline.app/artifact-1' });
    expect(source.headers).toBeUndefined();
    expect(created[0]!.type).toBe('image/jpeg');
    expect(mocks.fetch).toHaveBeenCalledWith(
      `${mocks.monolithUrl}/v1/media/${ID}`,
      { signal: expect.any(AbortSignal) },
      { timeoutMs: 20_000 },
    );
    vi.restoreAllMocks();
  });

  it('frees the object URL it minted and leaves a native uri alone', () => {
    const revokeObjectURL = vi.fn();
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(revokeObjectURL);
    releaseArtifactImageSource({ uri: 'blob:https://app.usebeeline.app/artifact-1' });
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:https://app.usebeeline.app/artifact-1');
    releaseArtifactImageSource({ uri: `${mocks.monolithUrl}/v1/media/${ID}` });
    releaseArtifactImageSource(null);
    expect(revokeObjectURL).toHaveBeenCalledTimes(1);
    vi.restoreAllMocks();
  });
});

describe('the PDF bytes as a string for the hosts that take one', () => {
  it('encodes the file through the session, padding the tail', async () => {
    mocks.fetch.mockResolvedValue(bytesResponse(new TextEncoder().encode('%PDF-1.4')));
    expect(await artifactBase64(attachment(`/v1/media/${ID}`))).toBe('JVBERi0xLjQ=');
  });

  it('refuses to encode anything the stored url pointed off-origin at', async () => {
    await expect(artifactBase64(attachment('https://evil.example/steal'))).rejects.toThrow(
      /not a monolith media URL/,
    );
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
});


describe('runnable capability URL', () => {
  it('mints through the configured session origin and rejects application-host execution', async () => {
    for (const origin of ['https://server.usebeeline.app', 'https://usebeeline.app', 'https://games.usebeeline.app', 'http://games.example.net']) {
      mocks.playback.mockResolvedValue({url:`${origin}/play/${ID}`});
      await expect(runnableArtifactUrl(attachment(`/v1/media/${ID}`))).rejects.toThrow(/not isolated/);
    }
    const url = `https://beeline-games.fly.dev/play/${ID}?token=opaque`;
    mocks.playback.mockResolvedValue({url});
    expect(await runnableArtifactUrl(attachment(`https://evil.example/v1/media/${ID}`))).toBe(url);
    expect(mocks.playback).toHaveBeenLastCalledWith(ID);expect(mocks.fetch).not.toHaveBeenCalled();
  });
});

it('a parked metadata route cannot downgrade link/play actions to legacy HTTP', async () => {
  mocks.mediaMode.value = 'pending';
  await expect(openArtifactInBrowser(attachment(`/v1/media/${ID}`))).rejects.toThrow('awaiting connection');
  await expect(runnableArtifactUrl(attachment(`/v1/media/${ID}`))).rejects.toThrow('awaiting connection');
  expect(mocks.fetch).not.toHaveBeenCalled();
});
