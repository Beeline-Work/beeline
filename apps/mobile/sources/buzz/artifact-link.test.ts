import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  monolithUrl: 'https://server.usebeeline.app',
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
  releaseArtifactImageSource,
} from './artifact-link';

const ID = '9f0f6a50-1111-4222-8333-444455556666';

function attachment(url: string) {
  return { url, name: 'photo.jpg', mimeType: 'image/jpeg', kind: 'artifact' as const };
}

/** A session response carrying the given bytes, as `fetchArtifactBytes` reads one. */
function bytesResponse(bytes: Uint8Array) {
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
  it('carries the bearer token only to the configured origin', async () => {
    const source = await artifactImageSource(attachment(`https://evil.example/v1/media/${ID}`));
    expect(source).toEqual({
      uri: `${mocks.monolithUrl}/v1/media/${ID}`,
      headers: { authorization: 'Bearer access-token' },
    });
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
    vi.stubGlobal('URL', { ...URL, createObjectURL, revokeObjectURL: vi.fn() });
    mocks.fetch.mockResolvedValue(bytesResponse(new Uint8Array([137, 80, 78, 71])));
    const source = await artifactImageSource(attachment(`/v1/media/${ID}`));
    expect(source).toEqual({ uri: 'blob:https://app.usebeeline.app/artifact-1' });
    expect(source.headers).toBeUndefined();
    expect(created[0]!.type).toBe('image/jpeg');
    expect(mocks.fetch).toHaveBeenCalledWith(
      `${mocks.monolithUrl}/v1/media/${ID}`,
      {},
      { timeoutMs: 20_000 },
    );
    vi.unstubAllGlobals();
  });

  it('frees the object URL it minted and leaves a native uri alone', () => {
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', { ...URL, createObjectURL: vi.fn(), revokeObjectURL });
    releaseArtifactImageSource({ uri: 'blob:https://app.usebeeline.app/artifact-1' });
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:https://app.usebeeline.app/artifact-1');
    releaseArtifactImageSource({ uri: `${mocks.monolithUrl}/v1/media/${ID}` });
    releaseArtifactImageSource(null);
    expect(revokeObjectURL).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
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
