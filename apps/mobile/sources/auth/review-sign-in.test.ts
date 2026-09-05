import { beforeEach, describe, expect, it, vi } from 'vitest';

const order = vi.hoisted(() => [] as string[]);
const secure = vi.hoisted(() => new Map<string, string>());
vi.mock('expo-secure-store', () => ({
  getItemAsync: vi.fn(async (key: string) => secure.get(key) ?? null),
  setItemAsync: vi.fn(async (key: string, value: string) => {
    secure.set(key, value);
  }),
  deleteItemAsync: vi.fn(async (key: string) => {
    order.push(`secure-delete:${key}`);
    secure.delete(key);
  }),
}));
vi.mock('@/buzz/runtime-config', () => ({
  getBuzzRuntimeConfig: () => ({ monolithUrl: 'https://server.example', monolithEnabled: true }),
}));
vi.mock('@/auth/buzz-identity-storage', () => ({
  clearBuzzIdentity: vi.fn(async () => {
    order.push('clear-buzz-identity');
  }),
}));
vi.mock('@/auth/github-auth-session', () => ({
  clearPendingGitHubSignInState: vi.fn(async () => {
    order.push('clear-github-state');
  }),
}));
vi.mock('@/buzz/surface-storage', () => ({
  clearMobileSurfaceStorage: vi.fn(() => {
    order.push('clear-surface-cache');
  }),
}));

import { MonolithSession } from './monolith-session';
import { signInWithReviewSecret } from './review-sign-in';

const REVIEW_IDENTITY = 'r'.repeat(64);
const SECRET = 'play-review-secret-value-0001';

function reviewTokens() {
  return {
    accessToken: 'access-review',
    accessExpiresAt: Date.now() + 60_000,
    refreshToken: 'refresh-review',
    refreshExpiresAt: Date.now() + 86_400_000,
    identityId: REVIEW_IDENTITY,
  };
}

describe('redeeming a review link on a device', () => {
  beforeEach(() => {
    order.length = 0;
    secure.clear();
  });

  it('exchanges the secret for the same session a GitHub ticket issues', async () => {
    const fetcher = vi.fn(
      async () => new Response(JSON.stringify(reviewTokens()), { status: 200 }),
    );
    const session = new MonolithSession('https://server.example', fetcher as typeof fetch);
    await expect(signInWithReviewSecret(SECRET, session)).resolves.toBe(REVIEW_IDENTITY);
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://server.example/v1/auth/review/exchange');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ secret: SECRET });
    await expect(session.authorization()).resolves.toBe('access-review');
    expect(secure.get('buzzy.monolith.identity.v1')).toBe(REVIEW_IDENTITY);
  });

  it('signs an already-signed-in identity out first, cache included', async () => {
    secure.set('buzzy.monolith.refresh.v1', 'somebody-elses-refresh');
    secure.set('buzzy.monolith.identity.v1', 'e'.repeat(64));
    const session = new MonolithSession(
      'https://server.example',
      vi.fn(async () => new Response(JSON.stringify(reviewTokens()), { status: 200 })) as typeof fetch,
    );
    await signInWithReviewSecret(SECRET, session);
    // The old session is gone before the new one is written, so the device is
    // never half-way between two identities.
    expect(order.indexOf('secure-delete:buzzy.monolith.refresh.v1')).toBeLessThan(
      order.indexOf('clear-surface-cache'),
    );
    expect(order).toContain('clear-buzz-identity');
    expect(order).toContain('clear-github-state');
    expect(secure.get('buzzy.monolith.identity.v1')).toBe(REVIEW_IDENTITY);
  });

  it('leaves the device signed out when the server refuses the secret', async () => {
    secure.set('buzzy.monolith.refresh.v1', 'somebody-elses-refresh');
    secure.set('buzzy.monolith.identity.v1', 'e'.repeat(64));
    const session = new MonolithSession(
      'https://server.example',
      vi.fn(async () => new Response(JSON.stringify({ error: 'not_found' }), { status: 404 })) as typeof fetch,
    );
    await expect(signInWithReviewSecret(SECRET, session)).rejects.toThrow();
    expect(secure.has('buzzy.monolith.refresh.v1')).toBe(false);
    expect(secure.has('buzzy.monolith.identity.v1')).toBe(false);
  });
});
