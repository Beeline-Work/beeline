import { generateKeypair } from '@beeline/nostr';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getGitHubRoomEvents,
  getGitHubRoomInstallationToken,
  listGitHubRepositories,
  startGitHubInstallation,
} from './github-auth.js';

const identity = generateKeypair();

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('GitHub auth routes', () => {
  it('uses the installation and repository-access routes with fresh NIP-98 auth', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            authorization_url: 'https://github.com/apps/beeline/installations/new',
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            installed: true,
            installations: [
              {
                installationId: 7,
                accountId: '1',
                accountLogin: 'acme',
                accountType: 'Organization',
                repositorySelection: 'selected',
                status: 'active',
                repositoryCount: 1,
                manageUrl: 'https://github.com/organizations/acme/settings/installations/7',
              },
            ],
            repositories: [
              {
                id: 42,
                installationId: 7,
                name: 'widget',
                fullName: 'acme/widget',
                remote: 'https://github.com/acme/widget.git',
                defaultBranch: 'main',
              },
            ],
          }),
          { status: 200 },
        ),
      );
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      startGitHubInstallation(
        'https://relay.example',
        identity,
        'https://relay.example/auth/github/mobile-callback',
        7,
      ),
    ).resolves.toContain('github.com/apps/beeline');
    await expect(
      listGitHubRepositories('https://relay.example', identity, { refresh: true }),
    ).resolves.toMatchObject({
      installed: true,
      installations: [{ accountLogin: 'acme', repositoryCount: 1 }],
      repositories: [{ installationId: 7, fullName: 'acme/widget' }],
    });
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      installation_id: 7,
    });
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain('refresh=1');
    for (const [, init] of fetchMock.mock.calls) {
      expect((init?.headers as Record<string, string>).authorization).toMatch(/^Nostr /);
    }
  });

  it('requests a Room-scoped token without letting the daemon choose a repository', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          token: 'room-token',
          expires_at: '2030-01-01T00:00:00Z',
          installation_id: 7,
          full_name: 'acme/widget',
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      getGitHubRoomInstallationToken('https://relay.example', identity, 'room-1'),
    ).resolves.toMatchObject({ token: 'room-token', fullName: 'acme/widget' });
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      pubkey: identity.publicKey,
      room_id: 'room-1',
    });
    expect(
      JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)).relay_authorizations,
    ).toHaveLength(16);
    expect((fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string>).authorization).toMatch(
      /^Nostr /,
    );
  });

  it('never downgrades a corner installation token to read-only', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          token: 'room-token',
          expires_at: '2030-01-01T00:00:00Z',
          installation_id: 77,
          full_name: 'acme/widget',
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      getGitHubRoomInstallationToken('https://relay.example', identity, 'room-1'),
    ).resolves.toMatchObject({ token: 'room-token' });
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).not.toHaveProperty('read_only');
  });

  it('fetches Room repository events with since/wait options and validates the response', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          full_name: 'acme/widget',
          head: 3,
          cursor: 2,
          events: [
            {
              id: 2,
              type: 'star',
              action: 'created',
              actor: 'lena',
              summary: 'lena starred acme/widget',
              received_at: '2026-01-01T00:00:00Z',
            },
          ],
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      getGitHubRoomEvents('https://relay.example', identity, 'room-1', {
        since: 1,
        waitMs: 25_000,
      }),
    ).resolves.toMatchObject({ fullName: 'acme/widget', cursor: 2, events: [{ id: 2 }] });
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      pubkey: identity.publicKey,
      room_id: 'room-1',
      since: 1,
      wait_ms: 25_000,
    });
  });

  it('preserves a Room-events authority refusal as an OidcBindError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: 'room_membership_required',
            message: 'agent is not a member of this Room',
          }),
          { status: 403, headers: { 'content-type': 'application/json' } },
        ),
      ),
    );

    await expect(
      getGitHubRoomEvents('https://relay.example', identity, 'room-1'),
    ).rejects.toMatchObject({ name: 'OidcBindError', code: 'room_membership_required' });
  });

  it('preserves a Room-token broker 403 as a non-retryable OidcBindError', async () => {
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

    await expect(
      getGitHubRoomInstallationToken('https://relay.example', identity, 'room-1'),
    ).rejects.toMatchObject({
      name: 'OidcBindError',
      code: 'room_repository_unauthorized',
      status: 403,
      retryable: false,
    });
  });
});
