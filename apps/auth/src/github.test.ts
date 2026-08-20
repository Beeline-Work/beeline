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
        new Response(JSON.stringify({ id: 1234, login: 'octocat' }), { status: 200 }),
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
});
