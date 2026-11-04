import { expect, it, vi } from 'vitest';
import { MonolithSession, MonolithSessionRequiredError } from './monolith-session';
import { watchSessionRequired } from './session-required';

it('routes a mounted screen to sign-in after confirmed credential removal, not transient failures', async () => {
  let change!: () => void;
  const identityId = vi.fn().mockResolvedValue('saved-identity');
  const onRequired = vi.fn();
  const stop = watchSessionRequired(onRequired, {
    identityId, subscribeIdentityChange: listener => { change = listener; return vi.fn(); },
  });
  change(); await Promise.resolve();
  expect(onRequired).not.toHaveBeenCalled();
  identityId.mockRejectedValueOnce(new Error('storage unavailable'));
  change(); await Promise.resolve();
  expect(onRequired).not.toHaveBeenCalled();
  identityId.mockResolvedValue(null);
  change(); await Promise.resolve();
  expect(onRequired).toHaveBeenCalledOnce();
  stop();
});

it('ignores a delayed signed-out read after a newer sign-in or unmount', async () => {
  let change!: () => void;
  let resolve!: (identity: string | null) => void;
  const identityId = vi.fn().mockImplementationOnce(() => new Promise(r => { resolve = r; }))
    .mockResolvedValue('new-identity');
  const onRequired = vi.fn();
  const stop = watchSessionRequired(onRequired, {
    identityId, subscribeIdentityChange: listener => { change = listener; return vi.fn(); },
  });
  change(); change(); resolve(null); await Promise.resolve();
  expect(onRequired).not.toHaveBeenCalled();
  identityId.mockResolvedValue(null);
  change(); stop(); await Promise.resolve();
  expect(onRequired).not.toHaveBeenCalled();
});

it('does not interrupt review redemption after its deliberate sign-out', async () => {
  let change!: () => void;
  let resolve!: (identity: string | null) => void;
  let route = '/beeline/channels';
  const onRequired = vi.fn();
  const stop = watchSessionRequired(onRequired, {
    identityId: () => new Promise(r => { resolve = r; }),
    subscribeIdentityChange: listener => { change = listener; return vi.fn(); },
  }, () => !route.startsWith('/review/'));
  change();
  route = '/review/proof-secret';
  resolve(null); await Promise.resolve();
  expect(onRequired).not.toHaveBeenCalled();
  route = '/beeline/channels';
  change(); resolve(null); await Promise.resolve();
  expect(onRequired).toHaveBeenCalledOnce();
  stop();
});

it('catches a confirmed refresh 401 that happened before the route mounted', async () => {
  const values = new Map([
    ['buzzy.monolith.refresh.v1', 'revoked-device'],
    ['buzzy.monolith.identity.v1', 'saved-viewer'],
  ]);
  const session = new MonolithSession('https://server.example',
    vi.fn(async () => new Response(null, { status: 401 })), async () => ({
      getItemAsync: async key => values.get(key) ?? null,
      setItemAsync: async (key, value) => { values.set(key, value); },
      deleteItemAsync: async key => { values.delete(key); },
    }));
  await expect(session.authorization()).rejects.toBeInstanceOf(MonolithSessionRequiredError);
  const navigate = vi.fn();
  const stop = watchSessionRequired(navigate, session);
  expect(navigate).toHaveBeenCalledOnce();
  stop();
});

it('routes a refresh 401 promptly even when native credential deletion has not finished', async () => {
  const values = new Map([
    ['buzzy.monolith.refresh.v1', 'revoked-device'],
    ['buzzy.monolith.identity.v1', 'saved-viewer'],
  ]);
  let release!: () => void;
  const deleting = new Promise<void>(resolve => { release = resolve; });
  let started!: () => void;
  const deletionStarted = new Promise<void>(resolve => { started = resolve; });
  const session = new MonolithSession('https://server.example',
    vi.fn(async () => new Response(null, { status: 401 })), async () => ({
      getItemAsync: async key => values.get(key) ?? null,
      setItemAsync: async (key, value) => { values.set(key, value); },
      deleteItemAsync: async key => { started(); await deleting; values.delete(key); },
    }));
  const navigate = vi.fn();
  const stop = watchSessionRequired(navigate, session);
  const authorization = session.authorization().catch(error => error);
  try {
    await deletionStarted;
    expect(navigate).toHaveBeenCalledOnce();
    // The sign-in page must not restore the revoked identity from a native
    // value whose deletion is still pending and bounce back to Rooms.
    await expect(session.identityId()).resolves.toBeNull();
  } finally {
    release(); await authorization; stop();
  }
});

it('a successful new sign-in releases the remembered revocation signal', async () => {
  const values = new Map([
    ['buzzy.monolith.refresh.v1', 'revoked-device'],
    ['buzzy.monolith.identity.v1', 'saved-viewer'],
  ]);
  const fetcher = vi.fn().mockResolvedValueOnce(new Response(null, { status: 401 }))
    .mockResolvedValueOnce(Response.json({ accessToken: 'new-access', accessExpiresAt: Date.now() + 60_000,
      refreshToken: 'new-refresh', refreshExpiresAt: Date.now() + 86_400_000, identityId: 'new-viewer' }));
  const session = new MonolithSession('https://server.example', fetcher, async () => ({
    getItemAsync: async key => values.get(key) ?? null,
    setItemAsync: async (key, value) => { values.set(key, value); },
    deleteItemAsync: async key => { values.delete(key); },
  }));
  await expect(session.authorization()).rejects.toBeInstanceOf(MonolithSessionRequiredError);
  await session.exchangeGitHubTicket('new-ticket');
  const navigate = vi.fn();
  const stop = watchSessionRequired(navigate, session);
  expect(navigate).not.toHaveBeenCalled();
  await expect(session.authorization()).resolves.toBe('new-access');
  stop();
});
