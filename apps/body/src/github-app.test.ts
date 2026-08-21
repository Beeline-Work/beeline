import { afterEach, describe, expect, it, vi } from 'vitest';
import { exportPKCS8, generateKeyPair } from 'jose';
import { newIdentity } from '@beeline/gate';
import { GitHubAppRuntime } from './github-app.js';

afterEach(() => vi.unstubAllGlobals());

describe('daemon GitHub App runtime', () => {
  it('uses and caches short-lived installation tokens to follow repository renames', async () => {
    const pair = await generateKeyPair('RS256');
    const privateKey = await exportPKCS8(pair.privateKey);
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ token: 'ghs_short_lived', expires_at: '2030-01-01T01:00:00Z' }),
          { status: 201 },
        ),
      )
      .mockImplementation(
        async () =>
          new Response(
            JSON.stringify({
              full_name: 'acme/renamed-widget',
              clone_url: 'https://github.com/acme/renamed-widget.git',
            }),
            { status: 200 },
          ),
      );
    vi.stubGlobal('fetch', fetchMock);
    const runtime = new GitHubAppRuntime({
      appId: '123',
      privateKey,
      now: () => Date.parse('2030-01-01T00:00:00Z'),
    });
    const binding = {
      key: 'github:42',
      name: 'widget',
      remote: 'git://github.com/acme/widget',
      githubInstallationId: 77,
      localOnly: false,
    };

    await expect(runtime.resolveIdentity(binding)).resolves.toEqual({
      name: 'acme/renamed-widget',
      remote: 'git://github.com/acme/renamed-widget',
      cloneUrl: 'https://github.com/acme/renamed-widget.git',
    });
    await expect(runtime.resolveIdentity(binding)).resolves.toMatchObject({
      name: 'acme/renamed-widget',
    });
    expect(
      fetchMock.mock.calls.filter(([url]) => String(url).includes('/access_tokens')),
    ).toHaveLength(1);
    expect(
      fetchMock.mock.calls.filter(([url]) => String(url).includes('/repos/acme/widget')),
    ).toHaveLength(2);
  });

  it('uses the auth service token broker when the daemon has no App private key', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            token: 'repo-scoped-token',
            expires_at: '2030-01-01T01:00:00Z',
            installation_id: 77,
            full_name: 'acme/widget',
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            full_name: 'acme/widget',
            clone_url: 'https://github.com/acme/widget.git',
          }),
          { status: 200 },
        ),
      );
    vi.stubGlobal('fetch', fetchMock);
    const identity = newIdentity('agent');
    const runtime = GitHubAppRuntime.fromEnvironment(
      {},
      { baseUrl: 'https://relay.example', identity },
    )!;

    await expect(
      runtime.resolveIdentity(
        {
          key: 'github:42',
          name: 'acme/widget',
          remote: 'git://github.com/acme/widget',
          githubInstallationId: 77,
          localOnly: false,
        },
        'room-1',
      ),
    ).resolves.toMatchObject({ name: 'acme/widget' });
    expect(fetchMock.mock.calls[0]![0]).toBe('https://relay.example/auth/github/room-token');
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]?.body))).toMatchObject({
      pubkey: identity.publicKey,
      room_id: 'room-1',
    });
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]?.body)).relay_authorizations).toHaveLength(
      16,
    );
  });

  it('propagates the auth service Room refusal to repository discovery', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: 'room_repository_unauthorized',
            message: 'agent is not authorized for this Room repository',
          }),
          { status: 403, headers: { 'content-type': 'application/json' } },
        ),
      ),
    );
    const identity = newIdentity('agent');
    const runtime = GitHubAppRuntime.fromEnvironment(
      {},
      { baseUrl: 'https://relay.example', identity },
    )!;

    await expect(
      runtime.resolveIdentity(
        {
          key: 'github:42',
          name: 'acme/widget',
          remote: 'git://github.com/acme/widget',
          githubInstallationId: 77,
          localOnly: false,
        },
        'room-1',
      ),
    ).rejects.toMatchObject({
      name: 'OidcBindError',
      code: 'room_repository_unauthorized',
      status: 403,
    });
  });
});
