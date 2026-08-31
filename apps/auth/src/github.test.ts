import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateKeyPair, exportPKCS8 } from 'jose';
import { GitHubAppClient, GitHubOAuthClient } from './github.js';

afterEach(() => vi.unstubAllGlobals());

describe('GitHub-only account and repository access', () => {
  it('exchanges GitHub OAuth for a stable account identity used by the npub bind flow', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: 'user-token', token_type: 'bearer' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: 1234, login: 'octocat', name: 'The Octocat' }), {
          status: 200,
        }),
      );
    vi.stubGlobal('fetch', fetchMock);
    const client = new GitHubOAuthClient({ clientId: 'client-id', clientSecret: 'secret' });
    await expect(
      client.exchangeCode('code', 'https://relay.example/auth/github/callback'),
    ).resolves.toEqual({
      issuer: 'https://github.com',
      audience: 'client-id',
      subject: '1234',
      login: 'octocat',
      displayName: 'The Octocat',
      accessToken: 'user-token',
    });
  });

  it('mints a short-lived installation token and lists exactly that installation repositories', async () => {
    const { privateKey } = await generateKeyPair('RS256');
    const privateKeyPem = await exportPKCS8(privateKey);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ token: 'installation-token', expires_at: '2030-01-01T00:00:00Z' }),
          { status: 201 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            repositories: [
              {
                id: 9,
                name: 'beeline',
                full_name: 'acme/beeline',
                clone_url: 'https://github.com/acme/beeline.git',
                default_branch: 'main',
              },
            ],
          }),
          { status: 200 },
        ),
      );
    vi.stubGlobal('fetch', fetchMock);
    const app = new GitHubAppClient({ appId: '42', privateKey: privateKeyPem, slug: 'beeline' });
    await expect(app.listRepositories(77)).resolves.toEqual([
      expect.objectContaining({ fullName: 'acme/beeline', installationId: 77 }),
    ]);
    expect(fetchMock.mock.calls[0]![0]).toBe(
      'https://api.github.com/app/installations/77/access_tokens',
    );
  });

  it('asks GitHub to restrict a daemon token to the authorized repository id', async () => {
    const { privateKey } = await generateKeyPair('RS256');
    const privateKeyPem = await exportPKCS8(privateKey);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ token: 'scoped-token', expires_at: '2030-01-01T00:00:00Z' }),
          { status: 201 },
        ),
      );
    vi.stubGlobal('fetch', fetchMock);
    const app = new GitHubAppClient({ appId: '42', privateKey: privateKeyPem, slug: 'beeline' });

    await expect(app.installationToken(77, { repositoryIds: [9] })).resolves.toMatchObject({
      token: 'scoped-token',
    });
    expect(fetchMock.mock.calls[0]![1]).toMatchObject({
      method: 'POST',
      body: JSON.stringify({ repository_ids: [9] }),
    });
  });

  it('mints the installation grant without a read-only permission downgrade', async () => {
    const { privateKey } = await generateKeyPair('RS256');
    const privateKeyPem = await exportPKCS8(privateKey);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ token: 'ro-token', expires_at: '2030-01-01T00:00:00Z' }), {
          status: 201,
        }),
      );
    vi.stubGlobal('fetch', fetchMock);
    const app = new GitHubAppClient({ appId: '42', privateKey: privateKeyPem, slug: 'beeline' });

    await expect(
      app.installationToken(77, { repositoryIds: [9] }),
    ).resolves.toMatchObject({ token: 'ro-token' });
    // GitHub applies the App installation's declared contents + pull-request
    // permissions; the token remains pinned to this exact repository.
    expect(fetchMock.mock.calls[0]![1]).toMatchObject({
      method: 'POST',
      body: JSON.stringify({ repository_ids: [9] }),
    });
    const sentBody = JSON.parse(String(fetchMock.mock.calls[0]![1].body));
    expect(sentBody).not.toHaveProperty('permissions');
  });

  it('lists the installations visible to a GitHub user token', async () => {
    const { privateKey } = await generateKeyPair('RS256');
    const privateKeyPem = await exportPKCS8(privateKey);
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({ installations: [{ id: 77 }, { id: 78 }] }), {
        status: 200,
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const app = new GitHubAppClient({ appId: '42', privateKey: privateKeyPem, slug: 'beeline' });

    await expect(app.listUserInstallationIds('user-token')).resolves.toEqual([77, 78]);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.github.com/user/installations?per_page=100&page=1',
      expect.objectContaining({
        headers: expect.objectContaining({ authorization: 'Bearer user-token' }),
      }),
    );
  });

  it('lists every installation of the App with its own JWT, skipping suspended ones', async () => {
    const { privateKey } = await generateKeyPair('RS256');
    const privateKeyPem = await exportPKCS8(privateKey);
    // GET /app/installations answers a BARE JSON ARRAY of installation
    // objects — unlike GET /user/installations' {total_count, installations}
    // envelope. Page 1 is full so a second page is fetched; page 2 closes it.
    const pageOne = Array.from({ length: 100 }, (_, index) => ({
      id: index + 1,
      account: { id: 500, login: 'acme', type: 'Organization', avatar_url: 'https://a/p' },
      repository_selection: 'all',
    }));
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(pageOne), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            {
              id: 900,
              account: { id: 123, login: 'octocat', type: 'User' },
              repository_selection: 'selected',
            },
            {
              id: 901,
              suspended_at: '2026-08-01T00:00:00Z',
              account: { id: 789, login: 'gone', type: 'User' },
              repository_selection: 'all',
            },
          ]),
          { status: 200 },
        ),
      );
    vi.stubGlobal('fetch', fetchMock);
    const app = new GitHubAppClient({ appId: '42', privateKey: privateKeyPem, slug: 'beeline' });

    const installations = await app.listInstallations();
    expect(installations).toHaveLength(101);
    expect(installations.at(-1)).toEqual({
      installationId: 900,
      account: {
        id: '123',
        login: 'octocat',
        type: 'User',
        repositorySelection: 'selected',
      },
    });
    expect(installations.map(({ installationId }) => installationId)).not.toContain(901);
    expect(fetchMock.mock.calls[0]![0]).toBe(
      'https://api.github.com/app/installations?per_page=100&page=1',
    );
    expect(fetchMock.mock.calls[1]![0]).toBe(
      'https://api.github.com/app/installations?per_page=100&page=2',
    );
    // The App JWT authenticates the enumeration, never a user token.
    const authorization = (fetchMock.mock.calls[0]![1] as { headers: Record<string, string> })
      .headers.authorization;
    expect(authorization).toMatch(/^Bearer ey/);
    expect(authorization).not.toContain('user-token');
  });

  it('keeps callback membership checks short-circuiting once the installation is found', async () => {
    const { privateKey } = await generateKeyPair('RS256');
    const privateKeyPem = await exportPKCS8(privateKey);
    const installations = Array.from({ length: 100 }, (_, index) => ({ id: index + 1 }));
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({ installations }), {
        status: 200,
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const app = new GitHubAppClient({ appId: '42', privateKey: privateKeyPem, slug: 'beeline' });

    await expect(app.userCanAccessInstallation('user-token', 77)).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('creates a repository in the selected installation account with administration:write', async () => {
    const { privateKey } = await generateKeyPair('RS256');
    const privateKeyPem = await exportPKCS8(privateKey);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ token: 'installation-token', expires_at: '2030-01-01T00:00:00Z' }),
          { status: 201 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: 10,
            name: 'new-repo',
            full_name: 'acme/new-repo',
            clone_url: 'https://github.com/acme/new-repo.git',
            default_branch: 'main',
          }),
          { status: 201 },
        ),
      );
    vi.stubGlobal('fetch', fetchMock);
    const app = new GitHubAppClient({
      appId: '42',
      privateKey: privateKeyPem,
      slug: 'beeline-app',
    });
    await expect(
      app.createRepository(
        77,
        { login: 'acme', type: 'Organization' },
        { name: 'new-repo', private: true },
      ),
    ).resolves.toMatchObject({ installationId: 77, fullName: 'acme/new-repo' });
    expect(fetchMock.mock.calls[1]![0]).toBe('https://api.github.com/orgs/acme/repos');
  });

  it('parses GET /app/installations as the bare array GitHub actually returns, never an envelope', async () => {
    const { privateKey } = await generateKeyPair('RS256');
    const privateKeyPem = await exportPKCS8(privateKey);
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify([
          {
            id: 155845498,
            account: {
              id: 2_000_001,
              login: 'Beeline-Work',
              type: 'Organization',
            },
            repository_selection: 'selected',
          },
        ]),
        { status: 200 },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    const app = new GitHubAppClient({ appId: '42', privateKey: privateKeyPem, slug: 'beeline' });

    await expect(app.listInstallations()).resolves.toEqual([
      {
        installationId: 155845498,
        account: {
          id: '2000001',
          login: 'Beeline-Work',
          type: 'Organization',
          repositorySelection: 'selected',
        },
      },
    ]);
  });
});
