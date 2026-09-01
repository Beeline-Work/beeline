import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GitHubAppClient, GitHubOAuthClient } from '@beeline/auth/github';
import { migrate } from './database.js';
import { PgliteDatabase } from './test-support.js';
import { GitHubOperations } from './github-operations.js';

const HUMAN = 'a'.repeat(64);

describe('GitHub phone operations', () => {
  let database: PgliteDatabase;
  beforeEach(async () => {
    database = new PgliteDatabase();
    await migrate(database);
    await database.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Owner')`, [
      HUMAN,
    ]);
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    await database.close();
  });
  it('completes a one-use PKCE account bind and stores only an encrypted user token', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === 'https://github.test/token')
        return new Response(JSON.stringify({ access_token: 'secret-user-token' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      if (url === 'https://api.github.test/user')
        return new Response(JSON.stringify({ id: 42, login: 'owner', name: 'Owner Name' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const oauth = new GitHubOAuthClient({
      clientId: 'client',
      clientSecret: 'secret',
      authorizationEndpoint: 'https://github.test/authorize',
      tokenEndpoint: 'https://github.test/token',
      apiBaseUrl: 'https://api.github.test',
    });
    const app = new GitHubAppClient({ appId: '1', slug: 'beeline-test', privateKey: 'not-used' });
    const operations = new GitHubOperations(database, oauth, app, 'secret');
    const started = await operations.beginIdentity(HUMAN, {
      redirectUri: 'beeline://callback',
      state: 'verifier-state',
    });
    expect(new URL(started.url).searchParams.get('code_challenge_method')).toBe('S256');
    await expect(
      operations.completeIdentity(
        HUMAN,
        { challenge: 'oauth-code', proof: 'verifier-state' },
        false,
      ),
    ).resolves.toEqual({ personId: HUMAN, recovered: false });
    const token = await database.query<{ encrypted_token: string }>(
      `SELECT encrypted_token FROM github_user_tokens WHERE subject='42'`,
    );
    expect(token.rows[0]?.encrypted_token).not.toContain('secret-user-token');
    await expect(
      operations.completeIdentity(
        HUMAN,
        { challenge: 'oauth-code', proof: 'verifier-state' },
        false,
      ),
    ).rejects.toThrow('not found or expired');
  });
  it('reuses the cached provider proof for an explicit identity recovery', async () => {
    const previous = 'c'.repeat(64);
    await database.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Previous')`, [
      previous,
    ]);
    await database.query(
      `INSERT INTO identity_external_links(provider,subject,identity_id,issuer,audience) VALUES('github','42',$1,'https://github.com','client')`,
      [previous],
    );
    const fetchMock = vi.fn(async (input: string | URL | Request) =>
      String(input).endsWith('/token')
        ? new Response(JSON.stringify({ access_token: 'secret-user-token' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        : new Response(JSON.stringify({ id: 42, login: 'owner', name: 'Owner' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const oauth = new GitHubOAuthClient({
      clientId: 'client',
      clientSecret: 'secret',
      authorizationEndpoint: 'https://github.test/authorize',
      tokenEndpoint: 'https://github.test/token',
      apiBaseUrl: 'https://api.github.test',
    });
    const operations = new GitHubOperations(
      database,
      oauth,
      new GitHubAppClient({ appId: '1', slug: 'beeline-test', privateKey: 'not-used' }),
      'secret',
    );
    await operations.beginIdentity(HUMAN, {
      redirectUri: 'beeline://callback',
      state: 'recovery-state',
    });
    await expect(
      operations.completeIdentity(
        HUMAN,
        { challenge: 'oauth-code', proof: 'recovery-state' },
        false,
      ),
    ).rejects.toThrow('already linked');
    await expect(
      operations.completeIdentity(
        HUMAN,
        { challenge: 'oauth-code', proof: 'recovery-state' },
        true,
      ),
    ).resolves.toEqual({ personId: HUMAN, recovered: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(
      (
        await database.query<{ identity_id: string }>(
          `SELECT identity_id FROM identity_external_links WHERE subject='42'`,
        )
      ).rows[0]?.identity_id,
    ).toBe(HUMAN);
  });

  it('returns the mobile completion shape after persisting an installation and its repositories', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) =>
        String(input) === 'https://github.test/token'
          ? new Response(JSON.stringify({ access_token: 'secret-user-token' }), { status: 200 })
          : new Response(JSON.stringify({ id: 42, login: 'owner', name: 'Owner' }), {
              status: 200,
            }),
      ),
    );
    const oauth = new GitHubOAuthClient({
      clientId: 'client',
      clientSecret: 'secret',
      authorizationEndpoint: 'https://github.test/authorize',
      tokenEndpoint: 'https://github.test/token',
      apiBaseUrl: 'https://api.github.test',
    });
    const app = {
      installationUrl: vi.fn(
        (state: string) => `https://github.test/install?state=${encodeURIComponent(state)}`,
      ),
      userCanAccessInstallation: vi.fn(async () => true),
      installationAccount: vi.fn(async () => ({
        id: '42',
        login: 'owner',
        type: 'User' as const,
        repositorySelection: 'all' as const,
      })),
      listRepositories: vi.fn(async () => [
        {
          id: 9,
          installationId: 77,
          name: 'beeline',
          fullName: 'owner/beeline',
          remote: 'https://github.com/owner/beeline.git',
          defaultBranch: 'main',
        },
      ]),
    } as unknown as GitHubAppClient;
    const operations = new GitHubOperations(database, oauth, app, 'secret');
    await operations.beginIdentity(HUMAN, {
      redirectUri: 'beeline://github-callback',
      state: 'callback-state',
    });
    await operations.completeIdentity(
      HUMAN,
      { challenge: 'oauth-code', proof: 'callback-state' },
      false,
    );
    const started = await operations.beginInstallation(HUMAN, {
      redirectUri: 'beeline://github-installation',
    });
    const state = new URL(started.url).searchParams.get('state');

    await expect(operations.completeInstallation(state!, 77)).resolves.toBe(
      'beeline://github-installation?installed=1',
    );
    expect(
      (
        await database.query<{ full_name: string }>(
          `SELECT full_name FROM github_repositories WHERE installation_id=77 AND active`,
        )
      ).rows,
    ).toEqual([{ full_name: 'owner/beeline' }]);
  });

  it('reconciles installations missing from the monolith database via the App JWT listing', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === 'https://github.test/token') {
        return new Response(JSON.stringify({ access_token: 'secret-user-token' }), { status: 200 });
      }
      if (url === 'https://api.github.test/user') {
        return new Response(JSON.stringify({ id: 42, login: 'owner', name: 'Owner' }), {
          status: 200,
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const oauth = new GitHubOAuthClient({
      clientId: 'client',
      clientSecret: 'secret',
      authorizationEndpoint: 'https://github.test/authorize',
      tokenEndpoint: 'https://github.test/token',
      apiBaseUrl: 'https://api.github.test',
    });
    const app = {
      listUserInstallationIds: vi.fn(async () => [78]),
      listInstallations: vi.fn(async () => [
        {
          installationId: 77,
          account: {
            id: '42',
            login: 'owner',
            type: 'User' as const,
            repositorySelection: 'all' as const,
          },
        },
        {
          installationId: 78,
          account: {
            id: '84',
            login: 'Beeline-Work',
            type: 'Organization' as const,
            repositorySelection: 'selected' as const,
          },
        },
        {
          installationId: 79,
          account: {
            id: '126',
            login: 'someone-else',
            type: 'Organization' as const,
            repositorySelection: 'all' as const,
          },
        },
      ]),
      installationAccount: vi.fn(async (installationId: number) =>
        installationId === 77
          ? {
              id: '42',
              login: 'owner',
              type: 'User' as const,
              repositorySelection: 'all' as const,
            }
          : {
              id: '84',
              login: 'Beeline-Work',
              type: 'Organization' as const,
              repositorySelection: 'selected' as const,
            },
      ),
      listRepositories: vi.fn(async (installationId: number) => [
        {
          id: installationId + 100,
          installationId,
          name: `repo-${installationId}`,
          fullName: `${installationId === 77 ? 'owner' : 'Beeline-Work'}/repo-${installationId}`,
          remote: `https://github.com/example/repo-${installationId}.git`,
          defaultBranch: 'main',
        },
      ]),
    } as unknown as GitHubAppClient;
    const operations = new GitHubOperations(database, oauth, app, 'secret');
    await operations.beginIdentity(HUMAN, {
      redirectUri: 'beeline://github-callback',
      state: 'reconcile-state',
    });
    await operations.completeIdentity(
      HUMAN,
      { challenge: 'oauth-code', proof: 'reconcile-state' },
      false,
    );

    const sealedUserToken = (
      await database.query<{ encrypted_token: string }>(
        `DELETE FROM github_user_tokens WHERE subject='42' RETURNING encrypted_token`,
      )
    ).rows[0]?.encrypted_token;
    const resolveSealedUserToken = vi.fn(async () => sealedUserToken);
    const reconciler = new GitHubOperations(
      database,
      oauth,
      app,
      'secret',
      resolveSealedUserToken,
    );

    await reconciler.refresh(HUMAN);

    expect(app.listInstallations).toHaveBeenCalledOnce();
    expect(resolveSealedUserToken).toHaveBeenCalledWith('42');
    expect(app.listUserInstallationIds).toHaveBeenCalledWith('secret-user-token');
    expect(
      (
        await database.query<{ installation_id: string }>(
          `SELECT installation_id FROM github_installations ORDER BY installation_id`,
        )
      ).rows.map((row) => Number(row.installation_id)),
    ).toEqual([77, 78]);
    expect(
      (
        await database.query<{ full_name: string }>(
          `SELECT full_name FROM github_repositories ORDER BY full_name`,
        )
      ).rows.map((row) => row.full_name),
    ).toEqual(['Beeline-Work/repo-78', 'owner/repo-77']);
  });

  it('applies installation repository removal and revocation webhooks to the monolith catalog', async () => {
    await database.query(
      `INSERT INTO github_installations(installation_id,owner_id,account_id,account_login,account_type,repository_selection,status) VALUES(77,$1,'42','owner','User','selected','active')`,
      [HUMAN],
    );
    await database.query(
      `INSERT INTO github_repositories(repository_id,installation_id,full_name,default_branch) VALUES(101,77,'owner/removed','main')`,
    );
    const app = {
      installationAccount: vi.fn(async () => ({
        id: '42',
        login: 'owner',
        type: 'User' as const,
        repositorySelection: 'selected' as const,
      })),
      listRepositories: vi.fn(async () => []),
    } as unknown as GitHubAppClient;
    const operations = new GitHubOperations(
      database,
      {} as GitHubOAuthClient,
      app,
      'secret',
    );

    await operations.processWebhook('installation_repositories', {
      action: 'removed',
      installation: { id: 77 },
      repositories_removed: [{ id: 101, full_name: 'owner/removed' }],
    });
    expect(
      (
        await database.query<{ active: boolean }>(
          `SELECT active FROM github_repositories WHERE repository_id=101`,
        )
      ).rows[0]?.active,
    ).toBe(false);

    await database.query(
      `UPDATE github_repositories SET active=true WHERE repository_id=101`,
    );
    await operations.processWebhook('installation', {
      action: 'deleted',
      installation: { id: 77 },
    });
    expect(
      (
        await database.query<{ status: string }>(
          `SELECT status FROM github_installations WHERE installation_id=77`,
        )
      ).rows[0]?.status,
    ).toBe('revoked');
    expect(
      (
        await database.query<{ active: boolean }>(
          `SELECT active FROM github_repositories WHERE repository_id=101`,
        )
      ).rows[0]?.active,
    ).toBe(false);
  });
});
