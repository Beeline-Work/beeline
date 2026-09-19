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

import {
  MONOLITH_REQUEST_TIMEOUT_MS,
  MonolithRequestTimeoutError,
  MonolithSession,
  MonolithSessionRequiredError,
} from './monolith-session';

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

  it('reconnects using the existing session without replacing it, including on account mismatch', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify(tokens(1)), { status: 200 }));
    const session = new MonolithSession('https://server.example', fetcher as typeof fetch);
    await session.exchangeGitHubTicket('sign-in');
    fetcher.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await session.reconnectGitHubTicket('fresh');
    expect(fetcher).toHaveBeenLastCalledWith(
      'https://server.example/v1/auth/github/reconnect',
      expect.objectContaining({
        headers: expect.objectContaining({ authorization: 'Bearer access-1' }),
        body: JSON.stringify({ oidcToken: 'fresh' }),
      }),
    );
    fetcher.mockResolvedValueOnce(new Response('{}', { status: 409 }));
    await expect(session.reconnectGitHubTicket('other')).rejects.toThrow('already linked');
    expect(await session.authorization()).toBe('access-1');
    expect(secure.get('buzzy.monolith.refresh.v1')).toBe('refresh-1');
  });

  it('announces a ready identity for GitHub and review sign-in, changes and sign-out, but not refresh', async () => {
    let next = tokens(1);
    const fetcher = vi.fn(async () => new Response(JSON.stringify(next), { status: 200 }));
    const session = new MonolithSession('https://server.example', fetcher as typeof fetch);
    const changed = vi.fn();
    const unsubscribe = session.subscribeIdentityChange(changed);
    await session.exchangeGitHubTicket('ticket');
    expect(changed).toHaveBeenCalledOnce();
    expect(await session.identityId()).toBe(next.identityId);
    // Refreshing credentials for the same account is not another sign-in.
    next = { ...next, accessExpiresAt: Date.now() - 1 };
    await session.exchangeGitHubTicket('another-ticket');
    expect(changed).toHaveBeenCalledTimes(2);
    next = tokens(2);
    await session.authorization();
    expect(changed).toHaveBeenCalledTimes(2);
    next = { ...tokens(2), identityId: 'b'.repeat(64) };
    await session.exchangeReviewSecret('review');
    expect(changed).toHaveBeenCalledTimes(3);
    expect(await session.identityId()).toBe(next.identityId);
    await session.clear();
    expect(changed).toHaveBeenCalledTimes(4);
    expect(await session.identityId()).toBeNull();
    unsubscribe();
    await session.exchangeGitHubTicket('last-ticket');
    expect(changed).toHaveBeenCalledTimes(4);
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

  it('keeps the rotated refresh credential in memory for later access renewals', async () => {
    const storage = {
      getItemAsync: vi.fn(async (key: string) =>
        key === 'buzzy.monolith.refresh.v1' ? 'refresh-old' : null,
      ),
      setItemAsync: vi.fn(async () => undefined),
      deleteItemAsync: vi.fn(async () => undefined),
    };
    let generation = 1;
    const fetcher = vi.fn(async () => {
      const issued = {
        ...tokens(generation),
        accessExpiresAt: Date.now() + 31_000,
      };
      generation += 1;
      return new Response(JSON.stringify(issued), { status: 200 });
    });
    const session = new MonolithSession(
      'https://server.example',
      fetcher as typeof fetch,
      async () => storage,
    );

    await expect(session.authorization()).resolves.toBe('access-1');
    vi.useFakeTimers();
    try {
      await vi.advanceTimersByTimeAsync(2_000);
      await expect(session.authorization()).resolves.toBe('access-2');
    } finally {
      vi.useRealTimers();
    }

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(
      storage.getItemAsync.mock.calls.filter(([key]) => key === 'buzzy.monolith.refresh.v1'),
    ).toHaveLength(1);
    expect(fetcher.mock.calls[1]?.[1]?.body).toBe(JSON.stringify({ refreshToken: 'refresh-1' }));
  });

  it('evicts the rotated in-memory refresh credential on clear, so later reads require sign-in', async () => {
    secure.set('buzzy.monolith.refresh.v1', 'refresh-old');
    const fetcher = vi.fn(async () => new Response(JSON.stringify(tokens(1)), { status: 200 }));
    const session = new MonolithSession('https://server.example', fetcher as typeof fetch);

    // Warm the rotated refresh token into memory via a successful renewal.
    await expect(session.authorization()).resolves.toBe('access-1');
    expect(secure.get('buzzy.monolith.refresh.v1')).toBe('refresh-1');

    await session.clear();

    await expect(session.authorization()).rejects.toBeInstanceOf(MonolithSessionRequiredError);
    // The cleared session must not fall back to the rotated in-memory token:
    // no extra refresh call, and the only refresh used the pre-rotation token.
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]?.[1]?.body).toBe(JSON.stringify({ refreshToken: 'refresh-old' }));
  });

  it('aborts a hung phone read only when it opts into the bounded deadline', async () => {
    let hang = false;
    const fetcher = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        if (!hang) return Promise.resolve(new Response(JSON.stringify(tokens(1)), { status: 200 }));
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('Aborted', 'AbortError')),
          );
        });
      },
    );
    const session = new MonolithSession('https://server.example', fetcher as typeof fetch);
    await session.exchangeGitHubTicket('ticket');
    hang = true;
    vi.useFakeTimers();
    try {
      const bounded = session.fetch('https://server.example/v1/phone/workspaces', {}, {
        timeoutMs: MONOLITH_REQUEST_TIMEOUT_MS,
      });
      const assertion = expect(bounded).rejects.toBeInstanceOf(MonolithRequestTimeoutError);
      await vi.advanceTimersByTimeAsync(15_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it('leaves a request without timeoutMs unbounded, so large uploads are never aborted', async () => {
    let hang = false;
    let aborted = false;
    const fetcher = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        if (!hang) return Promise.resolve(new Response(JSON.stringify(tokens(1)), { status: 200 }));
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            aborted = true;
            reject(new DOMException('Aborted', 'AbortError'));
          });
        });
      },
    );
    const session = new MonolithSession('https://server.example', fetcher as typeof fetch);
    await session.exchangeGitHubTicket('ticket');
    hang = true;
    vi.useFakeTimers();
    try {
      let settled = false;
      void session
        .fetch('https://server.example/v1/phone/media', { method: 'POST' })
        .then(
          () => {
            settled = true;
          },
          () => {
            settled = true;
          },
        );
      await vi.advanceTimersByTimeAsync(60_000);
      expect(settled).toBe(false);
      expect(aborted).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears a rejected refresh so launch routes to one sign-in', async () => {
    secure.set('buzzy.monolith.refresh.v1', 'stale');
    const fetcher = vi.fn(async () => new Response('{}', { status: 401 }));
    const session = new MonolithSession('https://server.example', fetcher as typeof fetch);
    await expect(session.authorization()).rejects.toBeInstanceOf(MonolithSessionRequiredError);
    expect(secure.has('buzzy.monolith.refresh.v1')).toBe(false);
    await expect(session.authorization()).rejects.toBeInstanceOf(MonolithSessionRequiredError);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
