import { advanceCorner } from './corner-lifecycle.js';

import type { createHash } from 'node:crypto';

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { cornerRunStateSql } from './corner-run.js';

import { generateKeyPair, exportPKCS8 } from 'jose';

import { GitHubAppClient, GitHubHttpError, GitHubOAuthClient } from '@beeline/auth/github';

import { type QueryResult, type SqlDatabase } from './database.js';

import type { QueryResultRow } from 'pg';

import { seedCornerOpening, PgliteDatabase, migratedDatabase, insertCornerFacts, setCornerOwner } from './test-support.js';

import { captureServerError } from './sentry.js';

import { GitHubOperations } from './github-operations.js';

import { readAgentCommands } from './agent-command.js';

import { DaemonService } from './daemon-service.js';

import { cornerFactsSql, cornerRowState, type CornerStateRow } from './chat-corner-counts.js';

import { LiveHub } from './live.js';

import { PhoneService } from './phone-service.js';

import { readRoomView } from '@beeline/api-contract/phone';

import type { createServer } from 'node:http';

import type { AddressInfo } from 'node:net';

vi.mock('./sentry.js', () => ({ captureServerError: vi.fn() }));


export const HUMAN = 'a'.repeat(64);

export const REVIEWER = 'b'.repeat(64);
export function fixtureScope1() {

  let database: PgliteDatabase;

  beforeEach(async () => {
    database = await migratedDatabase();
    await database.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Owner')`, [
      HUMAN,
    ]);
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await database.close();
  });


  async function checksFixture(count = 1) {
    const workspace = '11111111-1111-4111-8111-111111111111';
    const room = '22222222-2222-4222-8222-222222222222';
    const headSha = '1'.repeat(40);
    await database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Hive')`, [workspace]);
    await database.query(`INSERT INTO identities(id,kind,name) VALUES($1,'agent','Reviewer')`, [REVIEWER]);
    await database.query(`INSERT INTO agents(agent_id,owner_id,yolo_mode) VALUES($1,$2,true)`, [REVIEWER, HUMAN]);
    await database.query(`INSERT INTO github_installations(
      installation_id,owner_id,account_id,account_login,account_type,repository_selection,status
    ) VALUES(77,$1,'42','owner','User','selected','active')`, [HUMAN]);
    await database.query(`INSERT INTO github_repositories(repository_id,installation_id,full_name,default_branch)
      VALUES(101,77,'owner/widgets','main')`);
    await database.query(`INSERT INTO rooms(id,workspace_id,created_by,name,repository_key,repository_remote,
      repository_resolution,github_installation_id,reviewer_agent_id)
      VALUES($1,$2,$3,'General','owner/widgets','https://github.com/owner/widgets.git','repository',77,$4)`,
    [room, workspace, HUMAN, REVIEWER]);
    await database.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
      VALUES($1,$2,$3,'member')`, [workspace, room, REVIEWER]);
    const corners: string[] = [];
    for (let number = 1; number <= count; number++) {
      const corner = `33333333-${String(number).padStart(4, '0')}-4333-8333-333333333333`;
      corners.push(corner);
      // The reviewer agent opened these corners: its opening order and creator.
      await database.query(`INSERT INTO rooms(id,workspace_id,parent_id,created_by,name)
        VALUES($1,$2,$3,$4,'Checks')`, [corner, workspace, room, REVIEWER]);
      await insertCornerFacts(database, { cornerId: corner, lifecycle: JSON.stringify({ checks: 'passing',
        pr: { number, headSha, url: `https://github.com/owner/widgets/pull/${number}`, mergeability: 'clean' } }) });
      await seedCornerOpening(database, { cornerId: corner, agentId: REVIEWER });
    }
    const app = {
      installationToken: vi.fn(async () => ({ token: 'room-token', expiresAt: '2030-01-01T00:00:00Z' })),
      readCommitCheckRollup: vi.fn(async () => ({ state: 'passed', total: 1, failing: [], checks: [] })),
      readPullRequest: vi.fn(async (_token: string, _repository: string, number: number) => ({ number,
        headSha, url: `https://github.com/owner/widgets/pull/${number}`, mergeability: 'clean' })),
      mergePullRequest: vi.fn(async () => undefined),
      branchDeletionSafety: vi.fn(async () => ({ defaultBranch: 'main', aheadBy: 0, protected: false })),
      openPullRequestsForBranch: vi.fn(async () => []),
      deleteBranch: vi.fn(async () => undefined),
    };
    const payload = { action: 'completed', installation: { id: 77 }, repository: { full_name: 'owner/widgets' },
      check_run: { name: 'lint', status: 'completed', conclusion: 'success', head_sha: headSha,
        check_suite: { head_branch: 'feature/corner-333333330001', head_sha: headSha } } };
    return { room, corners, headSha, app, payload };
  }


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
return {
get database(){return database;}, set database(value: typeof database){database=value;},
checksFixture,
boundInstallationOperations,
orgInstallationApp,
};
}
export function fixtureScope2(scope1: ReturnType<typeof fixtureScope1>) {

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
      const rows = await scope1.database.query<{ installation_id: string }>(
        `SELECT installation_id FROM github_installations WHERE owner_id=$1 ORDER BY installation_id`,
        [owner],
      );
      return rows.rows.map((row) => Number(row.installation_id));
    }


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
return {
get privateKeyPem(){return privateKeyPem;}, set privateKeyPem(value: typeof privateKeyPem){privateKeyPem=value;},
INSTALLATION_ENTRY,
REPOSITORY_ENTRY,
bindIdentity,
operationsFor,
OMITTED_ORG_INSTALLATION,
withOmittedOrgInstallation,
ownedInstallationIds,
ORG_INSTALLATION_ENTRY,
ORG_REPOSITORY_ENTRY,
bindOrgIdentity,
};
}
export { advanceCorner } from './corner-lifecycle.js';
export { createHash } from 'node:crypto';
export { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
export { cornerRunStateSql } from './corner-run.js';
export { generateKeyPair, exportPKCS8 } from 'jose';
export { GitHubAppClient, GitHubHttpError, GitHubOAuthClient } from '@beeline/auth/github';
export { seedCornerOpening, PgliteDatabase, migratedDatabase, insertCornerFacts, setCornerOwner } from './test-support.js';
export { captureServerError } from './sentry.js';
export { GitHubOperations } from './github-operations.js';
export { readAgentCommands } from './agent-command.js';
export { DaemonService } from './daemon-service.js';
export { cornerFactsSql, cornerRowState } from './chat-corner-counts.js';
export { LiveHub } from './live.js';
export { PhoneService } from './phone-service.js';
export { readRoomView } from '@beeline/api-contract/phone';
export { readFileSync } from 'node:fs';
export { runInNewContext } from 'node:vm';
export { transformSync } from 'esbuild';
export { createServer } from 'node:http';
export type { QueryResult, SqlDatabase } from './database.js';
export type { QueryResultRow } from 'pg';
export type { CornerStateRow } from './chat-corner-counts.js';
export type { AddressInfo } from 'node:net';
