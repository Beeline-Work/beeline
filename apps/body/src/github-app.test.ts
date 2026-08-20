import { afterEach, describe, expect, it, vi } from 'vitest';
import { exportPKCS8, generateKeyPair } from 'jose';
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
});
