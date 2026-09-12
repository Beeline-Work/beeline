import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateKeyPair, exportPKCS8 } from 'jose';
import { GitHubAppClient, GitHubHttpError, GitHubOAuthClient } from '@beeline/auth/github';
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
  it('uses the Room exact-repository token to list and dispatch on the stored default branch', async () => {
    const workspace = '11111111-1111-4111-8111-111111111111';
    const room = '22222222-2222-4222-8222-222222222222';
    await database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Hive')`, [workspace]);
    await database.query(
      `INSERT INTO github_installations(installation_id,owner_id,account_id,account_login,account_type,repository_selection,status)
       VALUES(77,$1,'42','owner','User','selected','active')`,
      [HUMAN],
    );
    await database.query(
      `INSERT INTO github_repositories(repository_id,installation_id,full_name,default_branch)
       VALUES(101,77,'owner/widgets','trunk')`,
    );
    await database.query(
      `INSERT INTO rooms(id,workspace_id,name,repository_key,repository_remote,github_installation_id)
       VALUES($1,$2,'General','github:101','git://github.com/owner/widgets',77)`,
      [room, workspace],
    );
    const app = {
      installationToken: vi.fn(async () => ({
        token: 'room-token',
        expiresAt: '2030-01-01T00:00:00Z',
      })),
      listDispatchableWorkflows: vi.fn(async () => [
        { id: 12, name: 'Release', lastRunAt: 1_789_214_400, conclusion: 'success' },
      ]),
      dispatchWorkflow: vi.fn(async () => undefined),
    } as unknown as GitHubAppClient;
    const operations = new GitHubOperations(database, {} as GitHubOAuthClient, app, 'secret');

    await expect(operations.listRoomWorkflows(room)).resolves.toEqual({
      defaultBranch: 'trunk',
      workflows: [{ name: 'Release', lastRunAt: 1_789_214_400, conclusion: 'success' }],
    });
    await expect(operations.dispatchRoomWorkflow(room, 'Release')).resolves.toBeUndefined();
    expect(app.installationToken).toHaveBeenNthCalledWith(1, 77, { repositoryIds: [101] });
    expect(app.installationToken).toHaveBeenNthCalledWith(2, 77, { repositoryIds: [101] });
    expect(app.listDispatchableWorkflows).toHaveBeenCalledWith(
      'room-token',
      'owner/widgets',
      'trunk',
    );
    expect(app.dispatchWorkflow).toHaveBeenCalledWith('room-token', 'owner/widgets', 12, 'trunk');
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

  async function boundInstallationOperations(
    app: Pick<
      GitHubAppClient,
      'installationUrl' | 'userCanAccessInstallation' | 'installationAccount' | 'listRepositories'
    >,
    state = 'org-callback-state',
  ) {
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
    const operations = new GitHubOperations(database, oauth, app as GitHubAppClient, 'secret');
    await operations.beginIdentity(HUMAN, {
      redirectUri: 'beeline://github-callback',
      state,
    });
    await operations.completeIdentity(HUMAN, { challenge: 'oauth-code', proof: state }, false);
    const started = await operations.beginInstallation(HUMAN, {
      redirectUri: 'beeline://github-installation',
    });
    return { operations, installState: new URL(started.url).searchParams.get('state')! };
  }

  const orgInstallationApp = (
    access: 'throw-404' | 'deny' | 'allow',
    accountType: 'User' | 'Organization' = 'Organization',
  ) =>
    ({
      installationUrl: vi.fn(
        (state: string) => `https://github.test/install?state=${encodeURIComponent(state)}`,
      ),
      userCanAccessInstallation: vi.fn(async () => {
        if (access === 'throw-404') {
          throw new GitHubHttpError('GitHub user installations', 404);
        }
        return access === 'allow';
      }),
      installationAccount: vi.fn(async () => ({
        id: accountType === 'Organization' ? '84' : '42',
        login: accountType === 'Organization' ? 'acme' : 'owner',
        type: accountType,
        repositorySelection: 'selected' as const,
      })),
      listRepositories: vi.fn(async () => [
        {
          id: 9,
          installationId: 78,
          name: 'widgets',
          fullName: accountType === 'Organization' ? 'acme/widgets' : 'owner/widgets',
          remote: 'https://github.com/acme/widgets.git',
          defaultBranch: 'main',
        },
      ]),
    }) as unknown as Pick<
      GitHubAppClient,
      'installationUrl' | 'userCanAccessInstallation' | 'installationAccount' | 'listRepositories'
    >;

  it('completes an organization installation even when the user-token listing cannot verify it', async () => {
    const app = orgInstallationApp('throw-404');
    const { operations, installState } = await boundInstallationOperations(app);

    await expect(operations.completeInstallation(installState, 78)).resolves.toBe(
      'beeline://github-installation?installed=1',
    );
    expect(
      (
        await database.query<{
          account_type: string;
          account_login: string;
          status: string;
        }>(
          `SELECT account_type,account_login,status FROM github_installations WHERE installation_id=78`,
        )
      ).rows,
    ).toEqual([{ account_type: 'Organization', account_login: 'acme', status: 'active' }]);
    expect(
      (
        await database.query<{ full_name: string }>(
          `SELECT full_name FROM github_repositories WHERE installation_id=78 AND active`,
        )
      ).rows,
    ).toEqual([{ full_name: 'acme/widgets' }]);
  });

  it('refuses an organization installation the user listing definitively denies', async () => {
    const app = orgInstallationApp('deny');
    const { operations, installState } = await boundInstallationOperations(app, 'org-deny-state');

    await expect(operations.completeInstallation(installState, 78)).rejects.toThrow(
      'GitHub installation access denied',
    );
    expect(
      (
        await database.query(
          `SELECT installation_id FROM github_installations WHERE installation_id=78`,
        )
      ).rows,
    ).toEqual([]);
  });

  it('still refuses a user installation when the user-token listing throws', async () => {
    const app = orgInstallationApp('throw-404', 'User');
    const { operations, installState } = await boundInstallationOperations(app, 'user-404-state');

    await expect(operations.completeInstallation(installState, 78)).rejects.toThrow(
      'GitHub user installations failed: HTTP 404',
    );
    expect(
      (
        await database.query(
          `SELECT installation_id FROM github_installations WHERE installation_id=78`,
        )
      ).rows,
    ).toEqual([]);
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
      // Installation 79 is omitted from that listing, so membership decides
      // it — and this user is in no organization but the listed one.
      organizationMembership: vi.fn(async () => 'none' as const),
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
    const reconciler = new GitHubOperations(database, oauth, app, 'secret', resolveSealedUserToken);

    await reconciler.refresh(HUMAN);

    expect(app.listInstallations).toHaveBeenCalledOnce();
    expect(resolveSealedUserToken).toHaveBeenCalledWith('42');
    expect(app.listUserInstallationIds).toHaveBeenCalledWith('secret-user-token');
    expect(app.organizationMembership).toHaveBeenCalledWith('secret-user-token', 'someone-else');
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
    const operations = new GitHubOperations(database, {} as GitHubOAuthClient, app, 'secret');

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

    await database.query(`UPDATE github_repositories SET active=true WHERE repository_id=101`);
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

  describe('user token rotation', () => {
    let privateKeyPem: string;
    beforeAll(async () => {
      const { privateKey } = await generateKeyPair('RS256');
      privateKeyPem = await exportPKCS8(privateKey);
    });
    const INSTALLATION_ENTRY = {
      id: 77,
      account: { id: 42, login: 'owner', type: 'User', avatar_url: 'https://avatars.test/owner' },
      repository_selection: 'selected',
    };
    const REPOSITORY_ENTRY = {
      id: 101,
      name: 'widgets',
      full_name: 'owner/widgets',
      clone_url: 'https://github.test/owner/widgets',
      default_branch: 'main',
    };

    async function bindIdentity(database: PgliteDatabase) {
      const tokenBodies: Array<Record<string, unknown>> = [];
      const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url === 'https://github.test/token') {
          const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
          tokenBodies.push(body);
          if (body.grant_type === 'refresh_token')
            return new Response(
              JSON.stringify({
                access_token: 'fresh-user-token',
                refresh_token: 'refresh-2',
                expires_in: 28800,
                token_type: 'bearer',
              }),
              { status: 200, headers: { 'content-type': 'application/json' } },
            );
          return new Response(
            JSON.stringify({
              access_token: 'secret-user-token',
              refresh_token: 'refresh-1',
              expires_in: 3600,
              token_type: 'bearer',
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        if (url === 'https://api.github.test/user')
          return new Response(JSON.stringify({ id: 42, login: 'owner', name: 'Owner' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        if (url === 'https://api.github.test/app/installations?per_page=100&page=1')
          return new Response(JSON.stringify([INSTALLATION_ENTRY]), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        if (url === 'https://api.github.test/user/installations?per_page=100&page=1') {
          const authorization = (init?.headers as Record<string, string>).authorization;
          if (authorization !== 'Bearer fresh-user-token')
            return new Response(JSON.stringify({ message: 'Bad credentials' }), {
              status: 401,
              headers: { 'content-type': 'application/json' },
            });
          return new Response(
            JSON.stringify({ total_count: 1, installations: [INSTALLATION_ENTRY] }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        if (url === 'https://api.github.test/app/installations/77')
          return new Response(JSON.stringify(INSTALLATION_ENTRY), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        if (url === 'https://api.github.test/app/installations/77/access_tokens')
          return new Response(
            JSON.stringify({ token: 'installation-token', expires_at: '2030-01-01T00:00:00Z' }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        if (url === 'https://api.github.test/installation/repositories?per_page=100&page=1')
          return new Response(JSON.stringify({ repositories: [REPOSITORY_ENTRY] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        throw new Error(`unexpected fetch ${url}`);
      });
      vi.stubGlobal('fetch', fetchMock);
      return { tokenBodies, fetchMock };
    }

    function operationsFor(database: PgliteDatabase) {
      const oauth = new GitHubOAuthClient({
        clientId: 'client',
        clientSecret: 'secret',
        authorizationEndpoint: 'https://github.test/authorize',
        tokenEndpoint: 'https://github.test/token',
        apiBaseUrl: 'https://api.github.test',
      });
      const app = new GitHubAppClient({
        appId: '1',
        slug: 'beeline-test',
        privateKey: privateKeyPem,
        apiBaseUrl: 'https://api.github.test',
      });
      return new GitHubOperations(database, oauth, app, 'secret');
    }

    it('rotates an expired user token with its refresh grant before listing installations', async () => {
      const operations = operationsFor(database);
      const { tokenBodies, fetchMock } = await bindIdentity(database);
      await operations.beginIdentity(HUMAN, {
        redirectUri: 'beeline://callback',
        state: 'rotation-state',
      });
      await expect(
        operations.completeIdentity(
          HUMAN,
          { challenge: 'oauth-code', proof: 'rotation-state' },
          false,
        ),
      ).resolves.toEqual({ personId: HUMAN, recovered: false });
      // The 8-hour expiry has passed: the next refresh must rotate first.
      await database.query(
        `UPDATE github_user_tokens SET expires_at = now() - interval '1 minute' WHERE subject='42'`,
      );
      tokenBodies.length = 0;
      await expect(operations.refresh(HUMAN)).resolves.toEqual({});
      expect(tokenBodies).toEqual([expect.objectContaining({ grant_type: 'refresh_token' })]);
      expect(tokenBodies[0]).toMatchObject({ refresh_token: 'refresh-1' });
      const stored = (
        await database.query<{
          expires_at: string | Date;
          expires_in: number;
        }>(`SELECT encrypted_refresh_token, expires_at FROM github_user_tokens WHERE subject='42'`)
      ).rows[0];
      expect(stored?.encrypted_refresh_token).toBeDefined();
      expect(new Date(stored!.expires_at).getTime()).toBeGreaterThan(Date.now());
      expect(
        (
          await database.query<{ installation_id: number | string }>(
            `SELECT installation_id FROM github_installations WHERE owner_id=$1`,
            [HUMAN],
          )
        ).rows[0]?.installation_id,
      ).toEqual(77);
      // The installation listing must use the rotated token, not the expired one.
      const userInstallations = fetchMock.mock.calls.find(([input]) =>
        String(input).includes('/user/installations'),
      );
      expect((userInstallations?.[1]?.headers as Record<string, string>).authorization).toBe(
        'Bearer fresh-user-token',
      );
    });

    const OMITTED_ORG_INSTALLATION = {
      id: 88,
      account: { id: 500, login: 'acme', type: 'Organization' },
      repository_selection: 'all',
    };

    /**
     * An organization install the App serves but GET /user/installations never
     * mentions — the blindness that hides org repositories from the picker.
     * `membership` is what GitHub answers for this user's own membership in
     * that org.
     */
    async function withOmittedOrgInstallation(
      fetchMock: Awaited<ReturnType<typeof bindIdentity>>['fetchMock'],
      membership: Response,
    ) {
      const original = fetchMock.getMockImplementation()!;
      fetchMock.mockImplementation(async (input, init) => {
        const url = String(input);
        const json = (body: unknown, status = 200) =>
          new Response(JSON.stringify(body), {
            status,
            headers: { 'content-type': 'application/json' },
          });
        if (url === 'https://api.github.test/app/installations?per_page=100&page=1')
          return json([INSTALLATION_ENTRY, OMITTED_ORG_INSTALLATION]);
        if (url === 'https://api.github.test/app/installations/88')
          return json(OMITTED_ORG_INSTALLATION);
        if (url === 'https://api.github.test/app/installations/88/access_tokens')
          return json({ token: 'org-token', expires_at: '2030-01-01T00:00:00Z' });
        if (url === 'https://api.github.test/user/memberships/orgs/acme') {
          // Same rule the user listing enforces: the expired token proves
          // nothing, so a membership asked with it must not be believed.
          const authorization = (init?.headers as Record<string, string>).authorization;
          return authorization === 'Bearer fresh-user-token'
            ? membership.clone()
            : json({ message: 'Bad credentials' }, 401);
        }
        return original(input, init);
      });
    }

    async function ownedInstallationIds(owner: string): Promise<number[]> {
      const rows = await database.query<{ installation_id: string }>(
        `SELECT installation_id FROM github_installations WHERE owner_id=$1 ORDER BY installation_id`,
        [owner],
      );
      return rows.rows.map((row) => Number(row.installation_id));
    }

    it('claims an organization installation the user listing omits once membership confirms it', async () => {
      const operations = operationsFor(database);
      const { fetchMock } = await bindIdentity(database);
      await operations.beginIdentity(HUMAN, {
        redirectUri: 'beeline://callback',
        state: 'org-membership',
      });
      await operations.completeIdentity(
        HUMAN,
        { challenge: 'code', proof: 'org-membership' },
        false,
      );
      await database.query(
        `UPDATE github_user_tokens SET expires_at=now()-interval '1 minute' WHERE subject='42'`,
      );
      await withOmittedOrgInstallation(
        fetchMock,
        new Response(JSON.stringify({ state: 'active', role: 'member' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );

      await expect(operations.refresh(HUMAN)).resolves.toEqual({});
      await expect(ownedInstallationIds(HUMAN)).resolves.toEqual([77, 88]);
    });

    it('leaves an omitted organization installation unclaimed when membership denies it', async () => {
      const operations = operationsFor(database);
      const { fetchMock } = await bindIdentity(database);
      await operations.beginIdentity(HUMAN, {
        redirectUri: 'beeline://callback',
        state: 'org-non-member',
      });
      await operations.completeIdentity(
        HUMAN,
        { challenge: 'code', proof: 'org-non-member' },
        false,
      );
      await database.query(
        `UPDATE github_user_tokens SET expires_at=now()-interval '1 minute' WHERE subject='42'`,
      );
      // GitHub answers 404 for a non-member: a definitive no, so the listing's
      // omission stands and nothing is claimed.
      await withOmittedOrgInstallation(
        fetchMock,
        new Response(JSON.stringify({ message: 'Not Found' }), {
          status: 404,
          headers: { 'content-type': 'application/json' },
        }),
      );

      await expect(operations.refresh(HUMAN)).resolves.toEqual({});
      await expect(ownedInstallationIds(HUMAN)).resolves.toEqual([77]);
    });

    it('never takes an organization installation another identity already owns', async () => {
      const other = 'b'.repeat(64);
      await database.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Other')`, [
        other,
      ]);
      await database.query(
        `INSERT INTO github_installations(installation_id,owner_id,account_id,account_login,account_type,repository_selection,status) VALUES(88,$1,'500','acme','Organization','all','active')`,
        [other],
      );
      const operations = operationsFor(database);
      const { fetchMock } = await bindIdentity(database);
      await operations.beginIdentity(HUMAN, {
        redirectUri: 'beeline://callback',
        state: 'org-owned-elsewhere',
      });
      await operations.completeIdentity(
        HUMAN,
        { challenge: 'code', proof: 'org-owned-elsewhere' },
        false,
      );
      await database.query(
        `UPDATE github_user_tokens SET expires_at=now()-interval '1 minute' WHERE subject='42'`,
      );
      await withOmittedOrgInstallation(
        fetchMock,
        new Response(JSON.stringify({ state: 'active', role: 'member' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );

      await expect(operations.refresh(HUMAN)).resolves.toEqual({});
      await expect(ownedInstallationIds(HUMAN)).resolves.toEqual([77]);
      await expect(ownedInstallationIds(other)).resolves.toEqual([88]);
    });

    it('keeps a valid linked account healthy across repeated refreshes without a replacement grant', async () => {
      const operations = operationsFor(database);
      const { tokenBodies, fetchMock } = await bindIdentity(database);
      await operations.beginIdentity(HUMAN, {
        redirectUri: 'beeline://callback',
        state: 'repeated-renewal',
      });
      await operations.completeIdentity(
        HUMAN,
        { challenge: 'code', proof: 'repeated-renewal' },
        false,
      );
      const originalFetch = fetchMock.getMockImplementation()!;
      fetchMock.mockImplementation(async (input, init) => {
        if (String(input) === 'https://github.test/token') {
          const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
          tokenBodies.push(body);
          if (body.grant_type === 'refresh_token') {
            return new Response(
              JSON.stringify({ access_token: 'fresh-user-token', expires_in: 28800 }),
              { status: 200, headers: { 'content-type': 'application/json' } },
            );
          }
        }
        return originalFetch(input, init);
      });
      tokenBodies.length = 0;

      for (let refresh = 0; refresh < 2; refresh += 1) {
        await database.query(
          `UPDATE github_user_tokens SET expires_at=now()-interval '1 minute' WHERE subject='42'`,
        );
        await expect(operations.refresh(HUMAN)).resolves.toEqual({});
      }

      expect(tokenBodies).toEqual([
        expect.objectContaining({ grant_type: 'refresh_token', refresh_token: 'refresh-1' }),
        expect.objectContaining({ grant_type: 'refresh_token', refresh_token: 'refresh-1' }),
      ]);
      expect(
        (
          await database.query<{ stale_at: string | null }>(
            `SELECT stale_at FROM github_user_tokens WHERE subject='42'`,
          )
        ).rows[0]?.stale_at,
      ).toBeNull();
    });

    it('preserves a refresh credential after a temporary rotation failure and recovers next time', async () => {
      const operations = operationsFor(database);
      const { fetchMock } = await bindIdentity(database);
      await operations.beginIdentity(HUMAN, {
        redirectUri: 'beeline://callback',
        state: 'transient',
      });
      await operations.completeIdentity(HUMAN, { challenge: 'code', proof: 'transient' }, false);
      await database.query(
        `UPDATE github_user_tokens SET expires_at=now()-interval '1 minute' WHERE subject='42'`,
      );
      fetchMock.mockRejectedValueOnce(new Error('connection reset'));
      await expect(operations.refresh(HUMAN)).rejects.toThrow('connection reset');
      expect(
        (await database.query(`SELECT stale_at FROM github_user_tokens WHERE subject='42'`)).rows[0]
          ?.stale_at,
      ).toBeNull();
      await expect(operations.refresh(HUMAN)).resolves.toEqual({});
    });

    it('does not mistake an installation-list outage for an expired sign-in without a refresh grant', async () => {
      const operations = operationsFor(database);
      const { fetchMock } = await bindIdentity(database);
      await operations.beginIdentity(HUMAN, { redirectUri: 'beeline://callback', state: 'outage' });
      await operations.completeIdentity(HUMAN, { challenge: 'code', proof: 'outage' }, false);
      await database.query(
        `UPDATE github_user_tokens SET encrypted_refresh_token=NULL WHERE subject='42'`,
      );
      const original = fetchMock.getMockImplementation()!;
      let unavailable = true;
      fetchMock.mockImplementation(async (input, init) => {
        if (!String(input).includes('/user/installations')) return original(input, init);
        return unavailable
          ? new Response('{}', { status: 503 })
          : new Response(JSON.stringify({ total_count: 1, installations: [INSTALLATION_ENTRY] }), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            });
      });
      await expect(operations.refresh(HUMAN)).rejects.toThrow('HTTP 503');
      expect(
        (await database.query(`SELECT stale_at FROM github_user_tokens WHERE subject='42'`)).rows[0]
          ?.stale_at,
      ).toBeNull();
      unavailable = false;
      await expect(operations.refresh(HUMAN)).resolves.toEqual({});
    });

    it('preserves reconnect required for an expired legacy credential across a user-installations outage', async () => {
      const operations = operationsFor(database);
      const { fetchMock } = await bindIdentity(database);
      await operations.beginIdentity(HUMAN, {
        redirectUri: 'beeline://callback',
        state: 'legacy-expired-outage',
      });
      await operations.completeIdentity(
        HUMAN,
        { challenge: 'code', proof: 'legacy-expired-outage' },
        false,
      );
      await database.query(
        `UPDATE github_user_tokens SET encrypted_refresh_token=NULL,expires_at=now()-interval '1 minute',stale_at=NULL WHERE subject='42'`,
      );
      const originalFetch = fetchMock.getMockImplementation()!;
      let unavailable = false;
      fetchMock.mockImplementation(async (input, init) =>
        unavailable && String(input).includes('/user/installations')
          ? new Response(JSON.stringify({ message: 'unavailable' }), {
              status: 503,
              headers: { 'content-type': 'application/json' },
            })
          : originalFetch(input, init),
      );

      await expect(operations.refresh(HUMAN)).resolves.toEqual({ githubReconnectNeeded: true });
      unavailable = true;
      await expect(operations.refresh(HUMAN)).resolves.toEqual({ githubReconnectNeeded: true });
      unavailable = false;
      await expect(operations.refresh(HUMAN)).resolves.toEqual({ githubReconnectNeeded: true });
      expect(
        (
          await database.query<{ stale_at: string | null }>(
            `SELECT stale_at FROM github_user_tokens WHERE subject='42'`,
          )
        ).rows[0]?.stale_at,
      ).toBeNull();
    });

    it('keeps reconnect required after GitHub permanently rejects the refresh grant', async () => {
      const operations = operationsFor(database);
      const { fetchMock } = await bindIdentity(database);
      await operations.beginIdentity(HUMAN, {
        redirectUri: 'beeline://callback',
        state: 'rejected',
      });
      await operations.completeIdentity(HUMAN, { challenge: 'code', proof: 'rejected' }, false);
      await database.query(
        `UPDATE github_user_tokens SET expires_at=now()-interval '1 minute' WHERE subject='42'`,
      );
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 }),
      );
      await expect(operations.refresh(HUMAN)).resolves.toEqual({ githubReconnectNeeded: true });
      await expect(operations.refresh(HUMAN)).resolves.toEqual({ githubReconnectNeeded: true });
      expect(
        (
          await database.query<{ encrypted_refresh_token: string | null }>(
            `SELECT encrypted_refresh_token FROM github_user_tokens WHERE subject='42'`,
          )
        ).rows[0]?.encrypted_refresh_token,
      ).toBeNull();
    });

    it('keeps reconnect required when a rejected grant meets a user-installations outage', async () => {
      const operations = operationsFor(database);
      const { fetchMock } = await bindIdentity(database);
      await operations.beginIdentity(HUMAN, {
        redirectUri: 'beeline://callback',
        state: 'rejected-outage',
      });
      await operations.completeIdentity(
        HUMAN,
        { challenge: 'code', proof: 'rejected-outage' },
        false,
      );
      await database.query(
        `UPDATE github_user_tokens SET encrypted_refresh_token=NULL,stale_at=now() WHERE subject='42'`,
      );
      const originalFetch = fetchMock.getMockImplementation()!;
      fetchMock.mockImplementation(async (input, init) =>
        String(input).includes('/user/installations')
          ? new Response(JSON.stringify({ message: 'unavailable' }), {
              status: 503,
              headers: { 'content-type': 'application/json' },
            })
          : originalFetch(input, init),
      );

      await expect(operations.refresh(HUMAN)).resolves.toEqual({ githubReconnectNeeded: true });
    });

    it('recovers a historically stale credential that still has a refresh grant', async () => {
      const operations = operationsFor(database);
      const { tokenBodies } = await bindIdentity(database);
      await operations.beginIdentity(HUMAN, {
        redirectUri: 'beeline://callback',
        state: 'historical-stale',
      });
      await operations.completeIdentity(
        HUMAN,
        { challenge: 'code', proof: 'historical-stale' },
        false,
      );
      await database.query(
        `UPDATE github_user_tokens SET stale_at=now(),expires_at=now()-interval '1 minute' WHERE subject='42'`,
      );
      tokenBodies.length = 0;

      await expect(operations.refresh(HUMAN)).resolves.toEqual({});
      expect(tokenBodies).toEqual([
        expect.objectContaining({ grant_type: 'refresh_token', refresh_token: 'refresh-1' }),
      ]);
      expect(
        (await database.query(`SELECT stale_at FROM github_user_tokens WHERE subject='42'`)).rows[0]
          ?.stale_at,
      ).toBeNull();
    });

    it('degrades to stored installations with a reconnect flag when refresh is impossible', async () => {
      const operations = operationsFor(database);
      const { fetchMock } = await bindIdentity(database);
      await operations.beginIdentity(HUMAN, {
        redirectUri: 'beeline://callback',
        state: 'degrade-state',
      });
      await operations.completeIdentity(
        HUMAN,
        { challenge: 'oauth-code', proof: 'degrade-state' },
        false,
      );
      // The stored token expired and no refresh grant was persisted (legacy row).
      await database.query(
        `UPDATE github_user_tokens SET encrypted_refresh_token = NULL, expires_at = now() - interval '1 minute' WHERE subject='42'`,
      );
      // Previously synced installation/repositories answer the picker from storage.
      await database.query(
        `INSERT INTO github_installations(installation_id,owner_id,account_id,account_login,account_type,repository_selection,status) VALUES(77,$1,'42','owner','User','selected','active')`,
        [HUMAN],
      );
      await database.query(
        `INSERT INTO github_repositories(repository_id,installation_id,full_name,default_branch) VALUES(101,77,'owner/widgets','main')`,
      );
      const originalFetch = fetchMock.getMockImplementation()!;
      fetchMock.mockImplementation(async (input, init) =>
        String(input) === 'https://api.github.test/app/installations/77'
          ? new Response(JSON.stringify({ message: 'unavailable' }), {
              status: 503,
              headers: { 'content-type': 'application/json' },
            })
          : originalFetch(input, init),
      );
      await expect(operations.refresh(HUMAN)).resolves.toEqual({ githubReconnectNeeded: true });
      // The stored installation and repositories are still recorded — the picker answers.
      expect(
        (
          await database.query<{ installation_id: string }>(
            `SELECT installation_id FROM github_installations WHERE installation_id=77`,
          )
        ).rows[0]?.installation_id,
      ).toBe(77);
      expect(
        (
          await database.query<{ full_name: string }>(
            `SELECT full_name FROM github_repositories WHERE repository_id=101`,
          )
        ).rows[0]?.full_name,
      ).toBe('owner/widgets');
    });

    it('keeps reconnect required when the App catalog is unavailable after credential rejection', async () => {
      const operations = operationsFor(database);
      const { fetchMock } = await bindIdentity(database);
      await operations.beginIdentity(HUMAN, {
        redirectUri: 'beeline://callback',
        state: 'catalog-outage',
      });
      await operations.completeIdentity(
        HUMAN,
        { challenge: 'code', proof: 'catalog-outage' },
        false,
      );
      await database.query(
        `UPDATE github_user_tokens SET encrypted_refresh_token=NULL,expires_at=now()-interval '1 minute' WHERE subject='42'`,
      );
      await database.query(
        `INSERT INTO github_installations(installation_id,owner_id,account_id,account_login,account_type,repository_selection,status) VALUES(77,$1,'42','owner','User','selected','active')`,
        [HUMAN],
      );
      const originalFetch = fetchMock.getMockImplementation()!;
      fetchMock.mockImplementation(async (input, init) =>
        String(input) === 'https://api.github.test/app/installations?per_page=100&page=1'
          ? new Response(JSON.stringify({ message: 'unavailable' }), {
              status: 503,
              headers: { 'content-type': 'application/json' },
            })
          : originalFetch(input, init),
      );

      await expect(operations.refresh(HUMAN)).resolves.toEqual({ githubReconnectNeeded: true });
    });

    it('retries once with a rotated token when the stored token is answered 401', async () => {
      const operations = operationsFor(database);
      const { fetchMock } = await bindIdentity(database);
      await operations.beginIdentity(HUMAN, {
        redirectUri: 'beeline://callback',
        state: 'retry-state',
      });
      await operations.completeIdentity(
        HUMAN,
        { challenge: 'oauth-code', proof: 'retry-state' },
        false,
      );
      // The stored token is not yet expired by GitHub's clock but is dead server-side.
      const userInstallationsCalls: number[] = [];
      const originalFetch = fetchMock.getMockImplementation()!;
      fetchMock.mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url === 'https://api.github.test/user/installations?per_page=100&page=1') {
          const authorization = (init?.headers as Record<string, string>).authorization;
          if (authorization === 'Bearer fresh-user-token')
            return new Response(
              JSON.stringify({ total_count: 1, installations: [INSTALLATION_ENTRY] }),
              { status: 200, headers: { 'content-type': 'application/json' } },
            );
          userInstallationsCalls.push(1);
          return new Response(JSON.stringify({ message: 'Bad credentials' }), {
            status: 401,
            headers: { 'content-type': 'application/json' },
          });
        }
        return originalFetch(input, init);
      });
      await expect(operations.refresh(HUMAN)).resolves.toEqual({});
      expect(userInstallationsCalls.length).toBe(1);
      const successfulUserInstallationsCall = fetchMock.mock.calls
        .filter(([input]) => String(input).includes('/user/installations'))
        .at(-1);
      expect(
        (successfulUserInstallationsCall?.[1]?.headers as Record<string, string>).authorization,
      ).toBe('Bearer fresh-user-token');
    });

    const ORG_INSTALLATION_ENTRY = {
      id: 90,
      account: {
        id: 900,
        login: 'Beeline-Work',
        type: 'Organization',
        avatar_url: 'https://avatars.test/beeline-work',
      },
      repository_selection: 'selected',
    };
    const ORG_REPOSITORY_ENTRY = {
      id: 202,
      name: 'monolith',
      full_name: 'Beeline-Work/monolith',
      clone_url: 'https://github.test/Beeline-Work/monolith',
      default_branch: 'main',
    };

    // Links HUMAN and serves both installations from the App listing. The
    // user-token listing mode is the variable under test: GitHub's own
    // /user/installations visibility decides which org-claim path refresh()
    // may take.
    async function bindOrgIdentity(
      database: PgliteDatabase,
      userListings: 'confirmed' | 'user-only' | 'unavailable' | 'unavailable-404',
    ) {
      const operations = operationsFor(database);
      const { fetchMock } = await bindIdentity(database);
      await operations.beginIdentity(HUMAN, {
        redirectUri: 'beeline://callback',
        state: 'org-claim-state',
      });
      await operations.completeIdentity(
        HUMAN,
        { challenge: 'oauth-code', proof: 'org-claim-state' },
        false,
      );
      const originalFetch = fetchMock.getMockImplementation()!;
      fetchMock.mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (
          userListings === 'confirmed' &&
          url === 'https://api.github.test/user/installations?per_page=100&page=1'
        )
          return new Response(
            JSON.stringify({
              total_count: 2,
              installations: [INSTALLATION_ENTRY, ORG_INSTALLATION_ENTRY],
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        if (userListings === 'unavailable' && url.includes('/user/installations'))
          return new Response(JSON.stringify({ message: 'unavailable' }), {
            status: 503,
            headers: { 'content-type': 'application/json' },
          });
        if (userListings === 'unavailable-404' && url.includes('/user/installations'))
          return new Response(JSON.stringify({ message: 'Not Found' }), {
            status: 404,
            headers: { 'content-type': 'application/json' },
          });
        if (url === 'https://api.github.test/app/installations?per_page=100&page=1')
          return new Response(JSON.stringify([INSTALLATION_ENTRY, ORG_INSTALLATION_ENTRY]), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        if (url === 'https://api.github.test/app/installations/90')
          return new Response(JSON.stringify(ORG_INSTALLATION_ENTRY), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        if (url === 'https://api.github.test/app/installations/90/access_tokens')
          return new Response(
            JSON.stringify({ token: 'org-installation-token', expires_at: '2030-01-01T00:00:00Z' }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        if (url.startsWith('https://api.github.test/installation/repositories')) {
          const authorization = (init?.headers as Record<string, string>).authorization;
          if (authorization === 'Bearer org-installation-token')
            return new Response(JSON.stringify({ repositories: [ORG_REPOSITORY_ENTRY] }), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            });
          return originalFetch(input, init);
        }
        return originalFetch(input, init);
      });
      return { operations, fetchMock, originalFetch };
    }

    it('claims an organization installation the user listing confirms', async () => {
      const { operations } = await bindOrgIdentity(database, 'confirmed');
      await expect(operations.refresh(HUMAN)).resolves.toEqual({});
      expect(
        (
          await database.query<{ installation_id: string | number; owner_id: string }>(
            `SELECT installation_id,owner_id FROM github_installations ORDER BY installation_id`,
          )
        ).rows.map((row) => ({
          installation_id: Number(row.installation_id),
          owner_id: row.owner_id,
        })),
      ).toEqual([
        { installation_id: 77, owner_id: HUMAN },
        { installation_id: 90, owner_id: HUMAN },
      ]);
      expect(
        (
          await database.query<{ full_name: string }>(
            `SELECT full_name FROM github_repositories WHERE installation_id=90`,
          )
        ).rows.map((row) => row.full_name),
      ).toEqual(['Beeline-Work/monolith']);
    });

    it('refuses an organization installation the user listing excludes', async () => {
      const { operations } = await bindOrgIdentity(database, 'user-only');
      await expect(operations.refresh(HUMAN)).resolves.toEqual({});
      expect(
        (
          await database.query(
            `SELECT installation_id FROM github_installations WHERE installation_id=90`,
          )
        ).rows,
      ).toEqual([]);
    });

    it('claims an unclaimed organization installation when the user listing answers 404', async () => {
      const { operations } = await bindOrgIdentity(database, 'unavailable-404');
      // Production listing failure: a healthy token still cannot list org
      // installs. 404 is unavailable, not a throw, and does not demand reconnect.
      await expect(operations.refresh(HUMAN)).resolves.toEqual({});
      expect(
        (
          await database.query<{ installation_id: string | number; owner_id: string }>(
            `SELECT installation_id,owner_id FROM github_installations WHERE installation_id=90`,
          )
        ).rows.map((row) => ({
          installation_id: Number(row.installation_id),
          owner_id: row.owner_id,
        })),
      ).toEqual([{ installation_id: 90, owner_id: HUMAN }]);
    });

    it('claims an unclaimed organization installation when the user listing is unavailable', async () => {
      const { operations } = await bindOrgIdentity(database, 'unavailable');
      // Expired token with no refresh grant: reconnect is already required,
      // and the 503 leaves the user listing UNAVAILABLE rather than definitive.
      await database.query(
        `UPDATE github_user_tokens SET encrypted_refresh_token=NULL, expires_at=now()-interval '1 minute' WHERE subject='42'`,
      );
      await expect(operations.refresh(HUMAN)).resolves.toEqual({ githubReconnectNeeded: true });
      // The App's own listing still sees the org install; nobody owns it yet.
      expect(
        (
          await database.query<{ installation_id: string | number; owner_id: string }>(
            `SELECT installation_id,owner_id FROM github_installations WHERE installation_id=90`,
          )
        ).rows.map((row) => ({
          installation_id: Number(row.installation_id),
          owner_id: row.owner_id,
        })),
      ).toEqual([{ installation_id: 90, owner_id: HUMAN }]);
    });

    it("does not claim another viewer's organization installation during a user-listings outage", async () => {
      const OTHER = 'b'.repeat(64);
      await database.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Other')`, [
        OTHER,
      ]);
      await database.query(
        `INSERT INTO github_installations(installation_id,owner_id,account_id,account_login,account_type,repository_selection,status) VALUES(90,$1,'900','Beeline-Work','Organization','selected','active')`,
        [OTHER],
      );
      const { operations } = await bindOrgIdentity(database, 'unavailable');
      await database.query(
        `UPDATE github_user_tokens SET encrypted_refresh_token=NULL, expires_at=now()-interval '1 minute' WHERE subject='42'`,
      );
      await expect(operations.refresh(HUMAN)).resolves.toEqual({ githubReconnectNeeded: true });
      expect(
        (
          await database.query<{ owner_id: string }>(
            `SELECT owner_id FROM github_installations WHERE installation_id=90`,
          )
        ).rows[0]?.owner_id,
      ).toBe(OTHER);
    });
  });
});
