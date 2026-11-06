import { describe, expect, it, HUMAN, fixtureScope1, fixtureScope2 } from './test-support-github-operations.test-support.js';

describe('GitHub phone operations', () => {
const scope1 = fixtureScope1();
describe('user token rotation', () => {
const scope2 = fixtureScope2(scope1);


    it('keeps reconnect required after GitHub permanently rejects the refresh grant', async () => {
      const operations = scope2.operationsFor(scope1.database);
      const { fetchMock } = await scope2.bindIdentity(scope1.database);
      await operations.beginIdentity(HUMAN, {
        redirectUri: 'beeline://callback',
        state: 'rejected',
      });
      await operations.completeIdentity(HUMAN, { challenge: 'code', proof: 'rejected' }, false);
      await scope1.database.query(
        `UPDATE github_user_tokens SET expires_at=now()-interval '1 minute' WHERE subject='42'`,
      );
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 }),
      );
      await expect(operations.refresh(HUMAN)).resolves.toEqual({ githubReconnectNeeded: true });
      await expect(operations.refresh(HUMAN)).resolves.toEqual({ githubReconnectNeeded: true });
      expect(
        (
          await scope1.database.query<{ encrypted_refresh_token: string | null }>(
            `SELECT encrypted_refresh_token FROM github_user_tokens WHERE subject='42'`,
          )
        ).rows[0]?.encrypted_refresh_token,
      ).toBeNull();
    });


    it('keeps reconnect required when a rejected grant meets a user-installations outage', async () => {
      const operations = scope2.operationsFor(scope1.database);
      const { fetchMock } = await scope2.bindIdentity(scope1.database);
      await operations.beginIdentity(HUMAN, {
        redirectUri: 'beeline://callback',
        state: 'rejected-outage',
      });
      await operations.completeIdentity(
        HUMAN,
        { challenge: 'code', proof: 'rejected-outage' },
        false,
      );
      await scope1.database.query(
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
      const operations = scope2.operationsFor(scope1.database);
      const { tokenBodies } = await scope2.bindIdentity(scope1.database);
      await operations.beginIdentity(HUMAN, {
        redirectUri: 'beeline://callback',
        state: 'historical-stale',
      });
      await operations.completeIdentity(
        HUMAN,
        { challenge: 'code', proof: 'historical-stale' },
        false,
      );
      await scope1.database.query(
        `UPDATE github_user_tokens SET stale_at=now(),expires_at=now()-interval '1 minute' WHERE subject='42'`,
      );
      tokenBodies.length = 0;

      await expect(operations.refresh(HUMAN)).resolves.toEqual({});
      expect(tokenBodies).toEqual([
        expect.objectContaining({ grant_type: 'refresh_token', refresh_token: 'refresh-1' }),
      ]);
      expect(
        (await scope1.database.query(`SELECT stale_at FROM github_user_tokens WHERE subject='42'`)).rows[0]
          ?.stale_at,
      ).toBeNull();
    });


    it('degrades to stored installations with a reconnect flag when refresh is impossible', async () => {
      const operations = scope2.operationsFor(scope1.database);
      const { fetchMock } = await scope2.bindIdentity(scope1.database);
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
      await scope1.database.query(
        `UPDATE github_user_tokens SET encrypted_refresh_token = NULL, expires_at = now() - interval '1 minute' WHERE subject='42'`,
      );
      // Previously synced installation/repositories answer the picker from storage.
      await scope1.database.query(
        `INSERT INTO github_installations(installation_id,owner_id,account_id,account_login,account_type,repository_selection,status) VALUES(77,$1,'42','owner','User','selected','active')`,
        [HUMAN],
      );
      await scope1.database.query(
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
          await scope1.database.query<{ installation_id: string }>(
            `SELECT installation_id FROM github_installations WHERE installation_id=77`,
          )
        ).rows[0]?.installation_id,
      ).toBe(77);
      expect(
        (
          await scope1.database.query<{ full_name: string }>(
            `SELECT full_name FROM github_repositories WHERE repository_id=101`,
          )
        ).rows[0]?.full_name,
      ).toBe('owner/widgets');
    });


    it('keeps reconnect required when the App catalog is unavailable after credential rejection', async () => {
      const operations = scope2.operationsFor(scope1.database);
      const { fetchMock } = await scope2.bindIdentity(scope1.database);
      await operations.beginIdentity(HUMAN, {
        redirectUri: 'beeline://callback',
        state: 'catalog-outage',
      });
      await operations.completeIdentity(
        HUMAN,
        { challenge: 'code', proof: 'catalog-outage' },
        false,
      );
      await scope1.database.query(
        `UPDATE github_user_tokens SET encrypted_refresh_token=NULL,expires_at=now()-interval '1 minute' WHERE subject='42'`,
      );
      await scope1.database.query(
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
      const operations = scope2.operationsFor(scope1.database);
      const { fetchMock } = await scope2.bindIdentity(scope1.database);
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
              JSON.stringify({ total_count: 1, installations: [scope2.INSTALLATION_ENTRY] }),
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


    it('claims an organization installation the user listing confirms', async () => {
      const { operations } = await scope2.bindOrgIdentity(scope1.database, 'confirmed');
      await expect(operations.refresh(HUMAN)).resolves.toEqual({});
      expect(
        (
          await scope1.database.query<{ installation_id: string | number; owner_id: string }>(
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
          await scope1.database.query<{ full_name: string }>(
            `SELECT full_name FROM github_repositories WHERE installation_id=90`,
          )
        ).rows.map((row) => row.full_name),
      ).toEqual(['Beeline-Work/monolith']);
    });


    it('refuses an organization installation the user listing excludes', async () => {
      const { operations } = await scope2.bindOrgIdentity(scope1.database, 'user-only');
      await expect(operations.refresh(HUMAN)).resolves.toEqual({});
      expect(
        (
          await scope1.database.query(
            `SELECT installation_id FROM github_installations WHERE installation_id=90`,
          )
        ).rows,
      ).toEqual([]);
    });


    it('claims an unclaimed organization installation when the user listing answers 404', async () => {
      const { operations } = await scope2.bindOrgIdentity(scope1.database, 'unavailable-404');
      // Production listing failure: a healthy token still cannot list org
      // installs. 404 is unavailable, not a throw, and does not demand reconnect.
      await expect(operations.refresh(HUMAN)).resolves.toEqual({});
      expect(
        (
          await scope1.database.query<{ installation_id: string | number; owner_id: string }>(
            `SELECT installation_id,owner_id FROM github_installations WHERE installation_id=90`,
          )
        ).rows.map((row) => ({
          installation_id: Number(row.installation_id),
          owner_id: row.owner_id,
        })),
      ).toEqual([{ installation_id: 90, owner_id: HUMAN }]);
    });


    it('claims an unclaimed organization installation when the user listing is unavailable', async () => {
      const { operations } = await scope2.bindOrgIdentity(scope1.database, 'unavailable');
      // Expired token with no refresh grant: reconnect is already required,
      // and the 503 leaves the user listing UNAVAILABLE rather than definitive.
      await scope1.database.query(
        `UPDATE github_user_tokens SET encrypted_refresh_token=NULL, expires_at=now()-interval '1 minute' WHERE subject='42'`,
      );
      await expect(operations.refresh(HUMAN)).resolves.toEqual({ githubReconnectNeeded: true });
      // The App's own listing still sees the org install; nobody owns it yet.
      expect(
        (
          await scope1.database.query<{ installation_id: string | number; owner_id: string }>(
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
      await scope1.database.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Other')`, [
        OTHER,
      ]);
      await scope1.database.query(
        `INSERT INTO github_installations(installation_id,owner_id,account_id,account_login,account_type,repository_selection,status) VALUES(90,$1,'900','Beeline-Work','Organization','selected','active')`,
        [OTHER],
      );
      const { operations } = await scope2.bindOrgIdentity(scope1.database, 'unavailable');
      await scope1.database.query(
        `UPDATE github_user_tokens SET encrypted_refresh_token=NULL, expires_at=now()-interval '1 minute' WHERE subject='42'`,
      );
      await expect(operations.refresh(HUMAN)).resolves.toEqual({ githubReconnectNeeded: true });
      expect(
        (
          await scope1.database.query<{ owner_id: string }>(
            `SELECT owner_id FROM github_installations WHERE installation_id=90`,
          )
        ).rows[0]?.owner_id,
      ).toBe(OTHER);
    });
});
});
