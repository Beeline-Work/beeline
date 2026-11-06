import { describe, expect, it, vi, GitHubAppClient, GitHubOAuthClient, GitHubOperations, HUMAN, fixtureScope1 } from './github-operations.test-support.js';

describe('GitHub phone operations', () => {
const scope1 = fixtureScope1();


  it('keeps a listed repository token available while its installation sync is in progress', async () => {
    const workspace = '11111111-1111-4111-8111-111111111111';
    const room = '22222222-2222-4222-8222-222222222222';
    await scope1.database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Hive')`, [workspace]);
    await scope1.database.query(
      `INSERT INTO github_installations(installation_id,owner_id,account_id,account_login,account_type,repository_selection,status)
       VALUES(77,$1,'42','owner','User','selected','active')`,
      [HUMAN],
    );
    await scope1.database.query(
      `INSERT INTO github_repositories(repository_id,installation_id,full_name,default_branch)
       VALUES(101,77,'owner/widgets','main'),(102,77,'owner/removed','main')`,
    );
    await scope1.database.query(
      `INSERT INTO rooms(id,workspace_id,name,repository_key,repository_remote,repository_resolution,github_installation_id)
       VALUES($1,$2,'General','owner/widgets','https://github.com/owner/widgets.git','repository',77)`,
      [room, workspace],
    );
    const app = {
      installationAccount: vi.fn(async () => ({
        id: '42',
        login: 'owner',
        type: 'User' as const,
        repositorySelection: 'selected' as const,
      })),
      listRepositories: vi.fn(async () => [
        {
          id: 101,
          installationId: 77,
          fullName: 'owner/widgets',
          defaultBranch: 'main',
        },
      ]),
      installationToken: vi.fn(async () => ({
        token: 'scoped-token',
        expiresAt: '2030-01-01T00:00:00Z',
      })),
    } as unknown as GitHubAppClient;
    const operations = new GitHubOperations(scope1.database, {} as GitHubOAuthClient, app, 'secret');
    const query = scope1.database.query.bind(scope1.database);
    let tokenDuringSync: string | undefined;
    vi.spyOn(scope1.database, 'query').mockImplementation(async (sql, values) => {
      if (sql.startsWith('INSERT INTO github_repositories(')) {
        tokenDuringSync = (await operations.roomToken(room)).token;
      }
      return query(sql, values);
    });

    await operations.processWebhook('installation', {
      action: 'created',
      installation: { id: 77 },
    });

    expect(tokenDuringSync).toBe('scoped-token');
    expect(await operations.roomToken(room)).toMatchObject({ token: 'scoped-token' });
    expect(
      (
        await scope1.database.query<{ repository_id: number; active: boolean }>(
          `SELECT repository_id,active FROM github_repositories WHERE installation_id=77 ORDER BY repository_id`,
        )
      ).rows,
    ).toEqual([
      { repository_id: 101, active: true },
      { repository_id: 102, active: false },
    ]);
  });

  it('does not publish repository changes for an identical installation refresh', async () => {
    await scope1.database.query(
      `INSERT INTO github_installations(installation_id,owner_id,account_id,account_login,account_type,repository_selection,status,updated_at)
       VALUES(77,$1,'42','owner','User','selected','active','2020-01-01')`,
      [HUMAN],
    );
    await scope1.database.query(
      `INSERT INTO github_repositories(repository_id,installation_id,full_name,default_branch,updated_at)
       VALUES(101,77,'owner/widgets','main','2020-01-01')`,
    );
    let defaultBranch = 'main';
    const app = {
      installationAccount: vi.fn(async () => ({
        id: '42', login: 'owner', type: 'User' as const,
        repositorySelection: 'selected' as const,
      })),
      listRepositories: vi.fn(async () => [{
        id: 101, installationId: 77, fullName: 'owner/widgets', defaultBranch,
      }]),
    } as unknown as GitHubAppClient;
    const operations = new GitHubOperations(scope1.database, {} as GitHubOAuthClient, app, 'secret');
    const refresh = () => operations.processWebhook('installation', {
      action: 'created', installation: { id: 77 },
    });

    await refresh();
    const dates = async () => ({
      installation: (await scope1.database.query<{ updated_at: Date }>(
        `SELECT updated_at FROM github_installations WHERE installation_id=77`,
      )).rows[0]!.updated_at,
      repository: (await scope1.database.query<{ updated_at: Date }>(
        `SELECT updated_at FROM github_repositories WHERE repository_id=101`,
      )).rows[0]!.updated_at,
    });
    expect(await dates()).toEqual({
      installation: new Date('2020-01-01'), repository: new Date('2020-01-01'),
    });

    defaultBranch = 'trunk';
    await refresh();
    expect((await dates()).repository.getTime()).toBeGreaterThan(new Date('2020-01-01').getTime());
  });

  it.each(['workflow_job', 'workflow_run', 'delete'])(
    'does not refresh an installation for %s webhooks', async (event) => {
      await scope1.database.query(
        `INSERT INTO github_installations(installation_id,owner_id,account_id,account_login,account_type,repository_selection,status)
         VALUES(77,$1,'42','owner','User','selected','active')`,
        [HUMAN],
      );
      const app = {
        installationAccount: vi.fn(),
        listRepositories: vi.fn(),
      } as unknown as GitHubAppClient;
      const operations = new GitHubOperations(scope1.database, {} as GitHubOAuthClient, app, 'secret');

      await operations.processWebhook(event, {
        action: 'completed', installation: { id: 77 },
      });

      expect(app.installationAccount).not.toHaveBeenCalled();
      expect(app.listRepositories).not.toHaveBeenCalled();
    },
  );

  it('records GitHub repository visibility on installation refresh', async () => {
    await scope1.database.query(
      `INSERT INTO github_installations(installation_id,owner_id,account_id,account_login,account_type,repository_selection,status)
       VALUES(77,$1,'42','owner','User','selected','active')`,
      [HUMAN],
    );
    await scope1.database.query(
      `INSERT INTO github_repositories(repository_id,installation_id,full_name,default_branch)
       VALUES(101,77,'owner/widgets','main')`,
    );
    let widgetsPrivate = true;
    const app = {
      installationAccount: vi.fn(async () => ({
        id: '42',
        login: 'owner',
        type: 'User' as const,
        repositorySelection: 'selected' as const,
      })),
      listRepositories: vi.fn(async () => [
        {
          id: 101,
          installationId: 77,
          fullName: 'owner/widgets',
          defaultBranch: 'main',
          private: widgetsPrivate,
        },
        {
          id: 102,
          installationId: 77,
          fullName: 'owner/open',
          defaultBranch: 'main',
          private: false,
        },
      ]),
    } as unknown as GitHubAppClient;
    const operations = new GitHubOperations(scope1.database, {} as GitHubOAuthClient, app, 'secret');
    const stored = async () =>
      (
        await scope1.database.query<{ repository_id: number; private: boolean | null }>(
          `SELECT repository_id,private FROM github_repositories WHERE installation_id=77 ORDER BY repository_id`,
        )
      ).rows;

    await operations.processWebhook('installation', {
      action: 'created',
      installation: { id: 77 },
    });
    expect(await stored()).toEqual([
      { repository_id: 101, private: true },
      { repository_id: 102, private: false },
    ]);

    widgetsPrivate = false;
    await operations.processWebhook('repository', {
      action: 'publicized',
      installation: { id: 77 },
    });
    expect(await stored()).toEqual([
      { repository_id: 101, private: false },
      { repository_id: 102, private: false },
    ]);
  });

  it('records a repository auto-merge toggle on the next installation sync', async () => {
    await scope1.database.query(
      `INSERT INTO github_installations(installation_id,owner_id,account_id,account_login,account_type,repository_selection,status)
       VALUES(77,$1,'42','owner','User','selected','active')`,
      [HUMAN],
    );
    await scope1.database.query(
      `INSERT INTO github_repositories(repository_id,installation_id,full_name,default_branch,allow_auto_merge)
       VALUES(101,77,'owner/widgets','main',false)`,
    );
    let widgetsAutoMerge = false;
    const app = {
      installationAccount: vi.fn(async () => ({
        id: '42',
        login: 'owner',
        type: 'User' as const,
        repositorySelection: 'selected' as const,
      })),
      listRepositories: vi.fn(async () => [
        {
          id: 101,
          installationId: 77,
          fullName: 'owner/widgets',
          defaultBranch: 'main',
          private: false,
          allowAutoMerge: widgetsAutoMerge,
        },
      ]),
    } as unknown as GitHubAppClient;
    const operations = new GitHubOperations(scope1.database, {} as GitHubOAuthClient, app, 'secret');
    const stored = async () =>
      (
        await scope1.database.query<{ allow_auto_merge: boolean | null }>(
          `SELECT allow_auto_merge FROM github_repositories WHERE repository_id=101`,
        )
      ).rows[0]?.allow_auto_merge;

    expect(await stored()).toBe(false);

    // A repo already bound to a Room with a reviewer gets auto-merge turned
    // on later, on GitHub's side, with nobody touching the Room. The next
    // webhook-triggered sync is the only thing that records it.
    widgetsAutoMerge = true;
    await operations.processWebhook('repository', {
      action: 'edited',
      installation: { id: 77 },
    });
    expect(await stored()).toBe(true);
  });

  it('still refreshes the catalog for a repository lifecycle webhook', async () => {
    await scope1.database.query(
      `INSERT INTO github_installations(installation_id,owner_id,account_id,account_login,account_type,repository_selection,status)
       VALUES(77,$1,'42','owner','User','selected','active')`,
      [HUMAN],
    );
    const app = {
      installationAccount: vi.fn(async () => ({
        id: '42', login: 'owner', type: 'User' as const,
        repositorySelection: 'selected' as const,
      })),
      listRepositories: vi.fn(async () => [{
        id: 101, installationId: 77, fullName: 'owner/renamed', defaultBranch: 'main',
      }]),
    } as unknown as GitHubAppClient;
    const operations = new GitHubOperations(scope1.database, {} as GitHubOAuthClient, app, 'secret');

    await operations.processWebhook('repository', {
      action: 'renamed', installation: { id: 77 },
    });

    expect(app.installationAccount).toHaveBeenCalledWith(77);
    expect((await scope1.database.query<{ full_name: string }>(
      `SELECT full_name FROM github_repositories WHERE repository_id=101`,
    )).rows[0]?.full_name).toBe('owner/renamed');
  });

  it('uses the Room exact-repository token to list and dispatch on the stored default branch', async () => {
    const workspace = '11111111-1111-4111-8111-111111111111';
    const room = '22222222-2222-4222-8222-222222222222';
    await scope1.database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Hive')`, [workspace]);
    await scope1.database.query(
      `INSERT INTO github_installations(installation_id,owner_id,account_id,account_login,account_type,repository_selection,status)
       VALUES(77,$1,'42','owner','User','selected','active')`,
      [HUMAN],
    );
    await scope1.database.query(
      `INSERT INTO github_repositories(repository_id,installation_id,full_name,default_branch)
       VALUES(101,77,'owner/widgets','trunk')`,
    );
    await scope1.database.query(
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
    const operations = new GitHubOperations(scope1.database, {} as GitHubOAuthClient, app, 'secret');

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
    // Reproduction release-dispatch-attribution: an anonymous production dispatch must be refused.
    vi.mocked(app.listDispatchableWorkflows).mockResolvedValue([
      { id: 13, name: 'Unified production release' },
    ]);
    await expect(operations.dispatchRoomWorkflow(room, 'Unified production release'))
      .rejects.toThrow(/agent identity/);

  });
});
