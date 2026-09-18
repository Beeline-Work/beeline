import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  monolithUrl: 'https://server.usebeeline.app',
  authorization: vi.fn(),
  fetch: vi.fn(),
  openExternalUrl: vi.fn(),
  writeAsStringAsync: vi.fn(),
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

import { artifactImageSource, artifactMediaUrl } from './artifact-link';

const ID = '9f0f6a50-1111-4222-8333-444455556666';

function attachment(url: string) {
  return { url, name: 'photo.jpg', mimeType: 'image/jpeg', kind: 'artifact' as const };
}

beforeEach(() => {
  mocks.authorization.mockReset();
  mocks.fetch.mockReset();
  mocks.authorization.mockResolvedValue('access-token');
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
});
