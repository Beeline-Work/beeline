import { describe, expect, it, vi, GitHubAppClient, GitHubOAuthClient, GitHubOperations, readAgentCommands, HUMAN, REVIEWER, fixtureScope1, fixtureScope2 } from './test-support-github-operations.test-support.js';

describe('GitHub phone operations', () => {
const scope1 = fixtureScope1();

  it('CHECK-DEADLOCK-1: wakes on first failure and settled followup once across rollback and a new explicit event', async () => {
    const { corners, headSha, app, payload } = await scope1.checksFixture();
    const corner = corners[0]!;
    const checks = [
      { name: 'TYPECHECK', status: 'failed' as const, url: 'https://github.com/owner/widgets/actions/runs/10/job/101', jobId: 101 },
      { name: 'desktop', status: 'pending' as const },
      { name: 'lint', status: 'pending' as const },
    ];
    app.readCommitCheckRollup.mockImplementation(async () => ({
      state: checks.some(c => c.status === 'pending') ? 'pending' as const : 'failed' as const,
      failing: checks.filter(c => c.status === 'failed').map(c => c.name), checks: [...checks],
    }));
    const readJobLog = vi.fn(async (_token: string, _repo: string, jobId: number) => {
      if (jobId === 102) throw new Error('log temporarily unavailable');
      return 'earlier context\n##[error]TS2345 bad type\n';
    });
    Object.assign(app, { readJobLog });
    const operations = new GitHubOperations(scope1.database, {} as GitHubOAuthClient, app as unknown as GitHubAppClient, 'secret');
    const failure = (name: string) => ({ ...payload, check_run: {
      ...payload.check_run, name, conclusion: 'failure',
      details_url: `https://github.com/owner/widgets/actions/runs/10/job/${name === 'TYPECHECK' ? 101 : 102}`,
    } });
    const wakes = async () => (await scope1.database.query<{ body: string }>(
      `SELECT message.text body FROM agent_commands command JOIN messages message
       ON message.id=command.source_message_id WHERE command.room_id=$1 AND command.reason='corner_check'
       ORDER BY message.created_at,message.id`, [corner],
    )).rows;

    const transaction = scope1.database.transaction.bind(scope1.database);
    let replay = true;
    vi.spyOn(scope1.database, 'transaction').mockImplementation(work => transaction(async tx => {
      const result = await work(tx);
      if (replay) {
        replay = false;
        throw Object.assign(new Error('deadlock detected'), { code: '40P01' });
      }
      return result;
    }));
    await expect(operations.processWebhook('check_run', failure('TYPECHECK'))).rejects.toMatchObject({ code: '40P01' });
    expect(await wakes()).toHaveLength(0);
    await operations.processWebhook('check_run', failure('TYPECHECK'));
    expect((await wakes())).toHaveLength(1);
    expect((await wakes())[0]?.body).toContain('TYPECHECK');
    expect((await scope1.database.query<{ body: string }>(
      `SELECT system_event->'payload'->'failedJobs'->0->>'errorLines' body FROM messages
       WHERE room_id=$1 AND system_event->>'kind'='check-failed'`, [corner],
    )).rows[0]?.body).toContain('##[error]TS2345 bad type');
    expect(readJobLog).toHaveBeenCalledWith('room-token', 'owner/widgets', 101);
    const inbox = await readAgentCommands(scope1.database, corner, REVIEWER);
    expect(inbox.commands[0]?.source.body).toContain('> ##[error]TS2345 bad type');
    expect(inbox.commands[0]?.source.body).toContain('untrusted outside data');

    checks[1] = { name: 'desktop', status: 'failed', url: 'https://github.com/owner/widgets/actions/runs/10/job/102', jobId: 102 };
    await operations.processWebhook('check_run', failure('desktop'));
    expect((await wakes())).toHaveLength(1);
    checks[2] = { name: 'lint', status: 'passed' };
    replay = true;
    await expect(operations.processWebhook('check_run', payload)).rejects.toMatchObject({ code: '40P01' });
    expect(await wakes()).toHaveLength(1);
    await operations.processWebhook('check_run', payload);
    expect((await wakes())).toHaveLength(2);
    expect((await wakes())[1]?.body).toContain('desktop');
    const followupInbox = await readAgentCommands(scope1.database, corner, REVIEWER);
    expect(followupInbox.commands.some(command => command.source.body.includes('https://github.com/owner/widgets/actions/runs/10/job/102'))).toBe(true);
    await operations.processWebhook('check_run', payload);
    expect((await wakes())).toHaveLength(2);
    expect(readJobLog).toHaveBeenCalledTimes(4);
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
    const operations = new GitHubOperations(scope1.database, oauth, app, 'secret');
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
    const token = await scope1.database.query<{ encrypted_token: string }>(
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
    await scope1.database.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Previous')`, [
      previous,
    ]);
    await scope1.database.query(
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
      scope1.database,
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
        await scope1.database.query<{ identity_id: string }>(
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
    const operations = new GitHubOperations(scope1.database, oauth, app, 'secret');
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
        await scope1.database.query<{ full_name: string }>(
          `SELECT full_name FROM github_repositories WHERE installation_id=77 AND active`,
        )
      ).rows,
    ).toEqual([{ full_name: 'owner/beeline' }]);
  });


  it('opens select-target when a connected user explicitly adds an organization', async () => {
    const app = scope1.orgInstallationApp('allow');
    const { operations } = await scope1.boundInstallationOperations(app, 'select-target-state');
    await operations.beginInstallation(HUMAN, {
      redirectUri: 'beeline://github-installation', selectTarget: true,
    });
    expect(app.installationUrl).toHaveBeenLastCalledWith(expect.any(String), true);
  });


  it('completes an organization installation even when the user-token listing cannot verify it', async () => {
    const app = scope1.orgInstallationApp('throw-404');
    const { operations, installState } = await scope1.boundInstallationOperations(app);

    await expect(operations.completeInstallation(installState, 78)).resolves.toBe(
      'beeline://github-installation?installed=1',
    );
    expect(
      (
        await scope1.database.query<{
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
        await scope1.database.query<{ full_name: string }>(
          `SELECT full_name FROM github_repositories WHERE installation_id=78 AND active`,
        )
      ).rows,
    ).toEqual([{ full_name: 'acme/widgets' }]);
  });


  it('refuses an organization installation the user listing definitively denies', async () => {
    const app = scope1.orgInstallationApp('deny');
    const { operations, installState } = await scope1.boundInstallationOperations(app, 'org-deny-state');

    await expect(operations.completeInstallation(installState, 78)).rejects.toThrow(
      'GitHub installation access denied',
    );
    expect(
      (
        await scope1.database.query(
          `SELECT installation_id FROM github_installations WHERE installation_id=78`,
        )
      ).rows,
    ).toEqual([]);
  });


  it('still refuses a user installation when the user-token listing throws', async () => {
    const app = scope1.orgInstallationApp('throw-404', 'User');
    const { operations, installState } = await scope1.boundInstallationOperations(app, 'user-404-state');

    await expect(operations.completeInstallation(installState, 78)).rejects.toThrow(
      'GitHub user installations failed: HTTP 404',
    );
    expect(
      (
        await scope1.database.query(
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
    const operations = new GitHubOperations(scope1.database, oauth, app, 'secret');
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
      await scope1.database.query<{ encrypted_token: string }>(
        `DELETE FROM github_user_tokens WHERE subject='42' RETURNING encrypted_token`,
      )
    ).rows[0]?.encrypted_token;
    const resolveSealedUserToken = vi.fn(async () => sealedUserToken);
    const reconciler = new GitHubOperations(scope1.database, oauth, app, 'secret', resolveSealedUserToken);

    await reconciler.refresh(HUMAN);

    expect(app.listInstallations).toHaveBeenCalledOnce();
    expect(resolveSealedUserToken).toHaveBeenCalledWith('42');
    expect(app.listUserInstallationIds).toHaveBeenCalledWith('secret-user-token');
    expect(app.organizationMembership).toHaveBeenCalledWith('secret-user-token', 'someone-else');
    expect(
      (
        await scope1.database.query<{ installation_id: string }>(
          `SELECT installation_id FROM github_installations ORDER BY installation_id`,
        )
      ).rows.map((row) => Number(row.installation_id)),
    ).toEqual([77, 78]);
    expect(
      (
        await scope1.database.query<{ full_name: string }>(
          `SELECT full_name FROM github_repositories ORDER BY full_name`,
        )
      ).rows.map((row) => row.full_name),
    ).toEqual(['Beeline-Work/repo-78', 'owner/repo-77']);
  });


  it('applies installation repository removal and revocation webhooks to the monolith catalog', async () => {
    await scope1.database.query(
      `INSERT INTO github_installations(installation_id,owner_id,account_id,account_login,account_type,repository_selection,status) VALUES(77,$1,'42','owner','User','selected','active')`,
      [HUMAN],
    );
    await scope1.database.query(
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
    const operations = new GitHubOperations(scope1.database, {} as GitHubOAuthClient, app, 'secret');

    await operations.processWebhook('installation_repositories', {
      action: 'removed',
      installation: { id: 77 },
      repositories_removed: [{ id: 101, full_name: 'owner/removed' }],
    });
    expect(
      (
        await scope1.database.query<{ active: boolean }>(
          `SELECT active FROM github_repositories WHERE repository_id=101`,
        )
      ).rows[0]?.active,
    ).toBe(false);

    await scope1.database.query(`UPDATE github_repositories SET active=true WHERE repository_id=101`);
    await operations.processWebhook('installation', {
      action: 'deleted',
      installation: { id: 77 },
    });
    expect(
      (
        await scope1.database.query<{ status: string }>(
          `SELECT status FROM github_installations WHERE installation_id=77`,
        )
      ).rows[0]?.status,
    ).toBe('revoked');
    expect(
      (
        await scope1.database.query<{ active: boolean }>(
          `SELECT active FROM github_repositories WHERE repository_id=101`,
        )
      ).rows[0]?.active,
    ).toBe(false);
  });
describe('user token rotation', () => {
const scope2 = fixtureScope2(scope1);


    it('rotates an expired user token with its refresh grant before listing installations', async () => {
      const operations = scope2.operationsFor(scope1.database);
      const { tokenBodies, fetchMock } = await scope2.bindIdentity(scope1.database);
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
      await scope1.database.query(
        `UPDATE github_user_tokens SET expires_at = now() - interval '1 minute' WHERE subject='42'`,
      );
      tokenBodies.length = 0;
      await expect(operations.refresh(HUMAN)).resolves.toEqual({});
      expect(tokenBodies).toEqual([expect.objectContaining({ grant_type: 'refresh_token' })]);
      expect(tokenBodies[0]).toMatchObject({ refresh_token: 'refresh-1' });
      const stored = (
        await scope1.database.query<{
          expires_at: string | Date;
          expires_in: number;
        }>(`SELECT encrypted_refresh_token, expires_at FROM github_user_tokens WHERE subject='42'`)
      ).rows[0];
      expect(stored?.encrypted_refresh_token).toBeDefined();
      expect(new Date(stored!.expires_at).getTime()).toBeGreaterThan(Date.now());
      expect(
        (
          await scope1.database.query<{ installation_id: number | string }>(
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


    it('claims an organization installation the user listing omits once membership confirms it', async () => {
      const operations = scope2.operationsFor(scope1.database);
      const { fetchMock } = await scope2.bindIdentity(scope1.database);
      await operations.beginIdentity(HUMAN, {
        redirectUri: 'beeline://callback',
        state: 'org-membership',
      });
      await operations.completeIdentity(
        HUMAN,
        { challenge: 'code', proof: 'org-membership' },
        false,
      );
      await scope1.database.query(
        `UPDATE github_user_tokens SET expires_at=now()-interval '1 minute' WHERE subject='42'`,
      );
      await scope2.withOmittedOrgInstallation(
        fetchMock,
        new Response(JSON.stringify({ state: 'active', role: 'member' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );

      await expect(operations.refresh(HUMAN)).resolves.toEqual({});
      await expect(scope2.ownedInstallationIds(HUMAN)).resolves.toEqual([77, 88]);
    });


    it('leaves an omitted organization installation unclaimed when membership denies it', async () => {
      const operations = scope2.operationsFor(scope1.database);
      const { fetchMock } = await scope2.bindIdentity(scope1.database);
      await operations.beginIdentity(HUMAN, {
        redirectUri: 'beeline://callback',
        state: 'org-non-member',
      });
      await operations.completeIdentity(
        HUMAN,
        { challenge: 'code', proof: 'org-non-member' },
        false,
      );
      await scope1.database.query(
        `UPDATE github_user_tokens SET expires_at=now()-interval '1 minute' WHERE subject='42'`,
      );
      // GitHub answers 404 for a non-member: a definitive no, so the listing's
      // omission stands and nothing is claimed.
      await scope2.withOmittedOrgInstallation(
        fetchMock,
        new Response(JSON.stringify({ message: 'Not Found' }), {
          status: 404,
          headers: { 'content-type': 'application/json' },
        }),
      );

      await expect(operations.refresh(HUMAN)).resolves.toEqual({});
      await expect(scope2.ownedInstallationIds(HUMAN)).resolves.toEqual([77]);
    });


    it('never takes an organization installation another identity already owns', async () => {
      const other = 'b'.repeat(64);
      await scope1.database.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Other')`, [
        other,
      ]);
      await scope1.database.query(
        `INSERT INTO github_installations(installation_id,owner_id,account_id,account_login,account_type,repository_selection,status) VALUES(88,$1,'500','acme','Organization','all','active')`,
        [other],
      );
      const operations = scope2.operationsFor(scope1.database);
      const { fetchMock } = await scope2.bindIdentity(scope1.database);
      await operations.beginIdentity(HUMAN, {
        redirectUri: 'beeline://callback',
        state: 'org-owned-elsewhere',
      });
      await operations.completeIdentity(
        HUMAN,
        { challenge: 'code', proof: 'org-owned-elsewhere' },
        false,
      );
      await scope1.database.query(
        `UPDATE github_user_tokens SET expires_at=now()-interval '1 minute' WHERE subject='42'`,
      );
      await scope2.withOmittedOrgInstallation(
        fetchMock,
        new Response(JSON.stringify({ state: 'active', role: 'member' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );

      await expect(operations.refresh(HUMAN)).resolves.toEqual({});
      await expect(scope2.ownedInstallationIds(HUMAN)).resolves.toEqual([77]);
      await expect(scope2.ownedInstallationIds(other)).resolves.toEqual([88]);
    });


    it('keeps a valid linked account healthy across repeated refreshes without a replacement grant', async () => {
      const operations = scope2.operationsFor(scope1.database);
      const { tokenBodies, fetchMock } = await scope2.bindIdentity(scope1.database);
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
        await scope1.database.query(
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
          await scope1.database.query<{ stale_at: string | null }>(
            `SELECT stale_at FROM github_user_tokens WHERE subject='42'`,
          )
        ).rows[0]?.stale_at,
      ).toBeNull();
    });


    it('preserves a refresh credential after a temporary rotation failure and recovers next time', async () => {
      const operations = scope2.operationsFor(scope1.database);
      const { fetchMock } = await scope2.bindIdentity(scope1.database);
      await operations.beginIdentity(HUMAN, {
        redirectUri: 'beeline://callback',
        state: 'transient',
      });
      await operations.completeIdentity(HUMAN, { challenge: 'code', proof: 'transient' }, false);
      await scope1.database.query(
        `UPDATE github_user_tokens SET expires_at=now()-interval '1 minute' WHERE subject='42'`,
      );
      fetchMock.mockRejectedValueOnce(new Error('connection reset'));
      await expect(operations.refresh(HUMAN)).rejects.toThrow('connection reset');
      expect(
        (await scope1.database.query(`SELECT stale_at FROM github_user_tokens WHERE subject='42'`)).rows[0]
          ?.stale_at,
      ).toBeNull();
      await expect(operations.refresh(HUMAN)).resolves.toEqual({});
    });


    it('does not mistake an installation-list outage for an expired sign-in without a refresh grant', async () => {
      const operations = scope2.operationsFor(scope1.database);
      const { fetchMock } = await scope2.bindIdentity(scope1.database);
      await operations.beginIdentity(HUMAN, { redirectUri: 'beeline://callback', state: 'outage' });
      await operations.completeIdentity(HUMAN, { challenge: 'code', proof: 'outage' }, false);
      await scope1.database.query(
        `UPDATE github_user_tokens SET encrypted_refresh_token=NULL WHERE subject='42'`,
      );
      const original = fetchMock.getMockImplementation()!;
      let unavailable = true;
      fetchMock.mockImplementation(async (input, init) => {
        if (!String(input).includes('/user/installations')) return original(input, init);
        return unavailable
          ? new Response('{}', { status: 503 })
          : new Response(JSON.stringify({ total_count: 1, installations: [scope2.INSTALLATION_ENTRY] }), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            });
      });
      await expect(operations.refresh(HUMAN)).rejects.toThrow('HTTP 503');
      expect(
        (await scope1.database.query(`SELECT stale_at FROM github_user_tokens WHERE subject='42'`)).rows[0]
          ?.stale_at,
      ).toBeNull();
      unavailable = false;
      await expect(operations.refresh(HUMAN)).resolves.toEqual({});
    });


    it('preserves reconnect required for an expired legacy credential across a user-installations outage', async () => {
      const operations = scope2.operationsFor(scope1.database);
      const { fetchMock } = await scope2.bindIdentity(scope1.database);
      await operations.beginIdentity(HUMAN, {
        redirectUri: 'beeline://callback',
        state: 'legacy-expired-outage',
      });
      await operations.completeIdentity(
        HUMAN,
        { challenge: 'code', proof: 'legacy-expired-outage' },
        false,
      );
      await scope1.database.query(
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
          await scope1.database.query<{ stale_at: string | null }>(
            `SELECT stale_at FROM github_user_tokens WHERE subject='42'`,
          )
        ).rows[0]?.stale_at,
      ).toBeNull();
    });
});
});
