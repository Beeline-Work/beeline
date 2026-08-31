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
});
