import { beforeEach, describe, expect, it, vi } from 'vitest';

const secure = vi.hoisted(() => new Map<string, string>());
vi.mock('expo-secure-store', () => ({
  getItemAsync: vi.fn(async (key: string) => secure.get(key) ?? null),
  setItemAsync: vi.fn(async (key: string, value: string) => {
    secure.set(key, value);
  }),
  deleteItemAsync: vi.fn(async (key: string) => {
    secure.delete(key);
  }),
}));
vi.mock('@/buzz/runtime-config', () => ({
  getBuzzRuntimeConfig: () => ({ monolithUrl: 'https://server.example' }),
}));

import { MonolithSession, MonolithSessionRequiredError } from './monolith-session';

const tokens = (generation: number) => ({
  accessToken: `access-${generation}`,
  accessExpiresAt: Date.now() + 60_000,
  refreshToken: `refresh-${generation}`,
  refreshExpiresAt: Date.now() + 86400_000,
  identityId: 'a'.repeat(64),
});

describe('monolith phone session', () => {
  beforeEach(() => secure.clear());

  it('exchanges once and reuses the memory-only access token', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify(tokens(1)), { status: 200 }));
    const session = new MonolithSession('https://server.example', fetcher as typeof fetch);
    await expect(session.exchangeGitHubTicket('ticket')).resolves.toBe('a'.repeat(64));
    await expect(session.authorization()).resolves.toBe('access-1');
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(secure.get('buzzy.monolith.refresh.v1')).toBe('refresh-1');
  });

  it('rotates a persisted refresh token once across concurrent callers', async () => {
    secure.set('buzzy.monolith.refresh.v1', 'refresh-old');
    const fetcher = vi.fn(async () => new Response(JSON.stringify(tokens(2)), { status: 200 }));
    const session = new MonolithSession('https://server.example', fetcher as typeof fetch);
    await expect(Promise.all([session.authorization(), session.authorization()])).resolves.toEqual([
      'access-2',
      'access-2',
    ]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(secure.get('buzzy.monolith.refresh.v1')).toBe('refresh-2');
  });

  it('clears a rejected refresh so launch routes to one sign-in', async () => {
    secure.set('buzzy.monolith.refresh.v1', 'stale');
    const session = new MonolithSession(
      'https://server.example',
      vi.fn(async () => new Response('{}', { status: 401 })) as typeof fetch,
    );
    await expect(session.authorization()).rejects.toBeInstanceOf(MonolithSessionRequiredError);
    expect(secure.has('buzzy.monolith.refresh.v1')).toBe(false);
  });
});
