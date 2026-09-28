import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { migrate } from './database.js';
import { PgliteDatabase } from './test-support.js';
import { GOOGLE_GRANT_REVOKED, GoogleOAuth } from './google-oauth.js';
import { PhoneService } from './phone-service.js';
import { GOOGLE_TOOL_SCOPES } from '@beeline/api-contract/workbench';

const ACCOUNT_SCOPES = ['openid', 'email', ...new Set(Object.values(GOOGLE_TOOL_SCOPES).flat())].join(' ');

const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const CONNECTOR = '22222222-2222-4222-8222-222222222222';
const OWNER = 'a'.repeat(64);
const HELPER = 'b'.repeat(64);

let database: PgliteDatabase;
beforeEach(async () => {
  database = new PgliteDatabase();
  await migrate(database);
  await database.query(
    `INSERT INTO identities(id,kind,name) VALUES ($1,'human','Owner'),($2,'agent','Helper')`,
    [OWNER, HELPER],
  );
  await database.query(`INSERT INTO workspaces(id,name) VALUES ($1,'Home')`, [WORKSPACE]);
  await database.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`, [HELPER, OWNER]);
  await database.query(
    `INSERT INTO memberships(workspace_id,room_id,identity_id,role)
     VALUES($1,NULL,$2,'owner'),($1,NULL,$3,'member')`,
    [WORKSPACE, OWNER, HELPER],
  );
  await database.query(
    `INSERT INTO workspace_connectors(id,workspace_id,owner_identity_id,connector_type,
      helper_agent_id,machine_id,status)
     VALUES($1,$2,$3,'google-gmail',$4,$4,'installing')`,
    [CONNECTOR, WORKSPACE, OWNER, HELPER],
  );
});

it('pairs one product with its own OAuth sign-in and leaves siblings uninstalled', async () => {
  const oauth = new GoogleOAuth(database, 'client-id', 'client-secret',
    'https://beeline.example', randomBytes(32).toString('base64'));
  const phone = new PhoneService(database, 'https://beeline.example', undefined,
    undefined, undefined, false, database, undefined, oauth);
  const paired = await phone.pairConnector({ workspaceId: WORKSPACE,
    connectorType: 'google-gmail', helperAgentId: HELPER }, OWNER);
  expect(paired.status.status).toBe('installing');
  const rows = await database.query<{ connector_type: string; sign_in: { method: string; url: string } }>(
    `SELECT connector_type,sign_in FROM workspace_connectors WHERE workspace_id=$1`, [WORKSPACE]);
  expect(rows.rows).toHaveLength(1);
  expect(rows.rows[0]!.sign_in.method).toBe('oauth');
  expect(new URL(rows.rows[0]!.sign_in.url).host).toBe('accounts.google.com');
  const state = new URL(rows.rows[0]!.sign_in.url).searchParams.get('state')!;
  expect(await oauth.cancel(state)).toBe(true);
  const denied = await database.query<{ status: string; status_error: string; sign_in: unknown;
    status_steps: { label: string; status: string; reason: string }[] }>(
    `SELECT status,status_error,sign_in,status_steps FROM workspace_connectors WHERE id=$1`, [paired.connectorId]);
  expect(denied.rows[0]).toMatchObject({ status: 'disconnected',
    status_error: null, sign_in: null });
  expect(denied.rows[0]!.status_steps).toEqual([]);
  await phone.pairConnector({ workspaceId: WORKSPACE,
    connectorType: 'google-gmail', helperAgentId: HELPER }, OWNER);
  const retry = await database.query<{ sign_in: { url: string }; status: string }>(
    `SELECT sign_in,status FROM workspace_connectors WHERE id=$1`, [paired.connectorId]);
  expect(retry.rows[0]!.status).toBe('installing');
  expect(new URL(retry.rows[0]!.sign_in.url).searchParams.get('state')).not.toBe(state);
  const pending = await database.query<{ status_error: string }>(
    `SELECT status_error FROM workspace_connectors WHERE id=$1`, [paired.connectorId]);
  expect(pending.rows[0]!.status_error).toBeNull();
});
afterEach(async () => database.close());

it('returns every Google tool to retryable Connect after denial, exchange failure, cancellation, and abandonment', async () => {
  const transport = vi.fn(async () => new Response('{"error":"invalid_grant"}', { status: 400 })) as typeof fetch;
  const oauth = new GoogleOAuth(database, 'client-id', 'client-secret',
    'https://beeline.example', randomBytes(32).toString('base64'), transport);
  const phone = new PhoneService(database, 'https://beeline.example', undefined,
    undefined, undefined, false, database, undefined, oauth);
  const kinds = ['google-gmail', 'google-calendar', 'google-drive', 'google-youtube'] as const;
  for (const kind of kinds) {
    for (const outcome of ['denied', 'failed', 'cancelled', 'abandoned'] as const) {
      const paired = await phone.pairConnector({ workspaceId: WORKSPACE,
        connectorType: kind, helperAgentId: HELPER }, OWNER);
      const pending = await database.query<{ sign_in: { url: string } }>(
        `SELECT sign_in FROM workspace_connectors WHERE id=$1`, [paired.connectorId]);
      const state = new URL(pending.rows[0]!.sign_in.url).searchParams.get('state')!;
      if (outcome === 'denied') expect(await oauth.cancel(state)).toBe(true);
      else if (outcome === 'failed') expect(await oauth.complete(state, 'bad-code')).toBe(false);
      else if (outcome === 'cancelled') {
        expect(await oauth.cancelConnector(paired.connectorId, 'c'.repeat(64))).toBe(false);
        expect(await oauth.cancelConnector(paired.connectorId, OWNER)).toBe(true);
      } else {
        await database.query(
          `UPDATE google_oauth_attempts SET expires_at=now()-interval '1 second' WHERE state=$1`,
          [state],
        );
      }
      const view = await phone.readWorkbench({ workspaceId: WORKSPACE }, OWNER);
      const row = view.connectors.find((entry) => entry.connectorId === paired.connectorId)!;
      expect(row.status.status, `${kind} ${outcome}`).toBe('disconnected');
      expect(row.status.errorMessage, `${kind} ${outcome}`).toBeUndefined();
      expect(row.status.signIn, `${kind} ${outcome}`).toBeUndefined();
      const retry = await phone.pairConnector({ workspaceId: WORKSPACE,
        connectorType: kind, helperAgentId: HELPER }, OWNER);
      expect(retry.connectorId).toBe(paired.connectorId);
      const fresh = await database.query<{ sign_in: { url: string } }>(
        `SELECT sign_in FROM workspace_connectors WHERE id=$1`, [paired.connectorId]);
      expect(new URL(fresh.rows[0]!.sign_in.url).searchParams.get('state')).not.toBe(state);
    }
  }
  expect(transport).toHaveBeenCalledTimes(kinds.length);
});

it('starts account consent without a helper and clears denied, failed, cancelled, and abandoned browser attempts', async () => {
  const transport = vi.fn(async () => new Response('{"error":"invalid_grant"}', { status: 400 })) as typeof fetch;
  const oauth = new GoogleOAuth(database, 'client-id', 'client-secret',
    'https://beeline.example', randomBytes(32).toString('base64'), transport);
  for (const outcome of ['denied', 'failed', 'cancelled', 'abandoned'] as const) {
    const url = new URL(await oauth.beginAccount(OWNER, 'google-calendar'));
    expect(url.host).toBe('accounts.google.com');
    expect(url.searchParams.get('redirect_uri')).toBe('https://beeline.example/v1/google/oauth/callback');
    expect(url.searchParams.get('scope')).toContain('calendar.readonly');
    expect(url.searchParams.get('scope')).toContain('gmail.');
    expect(url.searchParams.get('scope')).toContain('yt-analytics');
    const state = url.searchParams.get('state')!;
    expect((await oauth.accountStatus(OWNER)).authorizationUrl).toBe(url.toString());
    if (outcome === 'denied') expect(await oauth.cancelAccountState(state)).toBe(true);
    if (outcome === 'failed') expect(await oauth.completeAccount(state, 'bad-code')).toEqual({ completed: false, offers: [] });
    if (outcome === 'cancelled') expect(await oauth.cancelAccount(OWNER)).toBe(true);
    if (outcome === 'abandoned') {
      await database.query(`UPDATE google_oauth_accounts SET expires_at=now()-interval '1 second'
        WHERE owner_identity_id=$1`, [OWNER]);
    }
    expect(await oauth.accountStatus(OWNER)).toEqual({ connected: false, connectedTypes: [] });
    const retry = new URL(await oauth.beginAccount(OWNER, 'google-calendar'));
    expect(retry.searchParams.get('state')).not.toBe(state);
    expect(await oauth.cancelAccount(OWNER)).toBe(true);
  }
  expect(transport).toHaveBeenCalledOnce();
});

it('seals a helper-free account grant and exposes only the access token to the owner', async () => {
  const transport = vi.fn(async (url: string | URL | Request) =>
    new Response(JSON.stringify(String(url).endsWith('/token') ? {
      access_token: 'owner-token', refresh_token: 'owner-refresh', expires_in: 3600,
      scope: ACCOUNT_SCOPES,
    } : { email: 'owner@example.test' }), { status: 200 })) as typeof fetch;
  const oauth = new GoogleOAuth(database, 'client-id', 'client-secret',
    'https://beeline.example', randomBytes(32).toString('base64'), transport);
  const firstUrl = new URL(await oauth.beginAccount(OWNER, 'google-calendar'));
  expect(firstUrl.searchParams.get('scope')).toContain('gmail.');
  const state = firstUrl.searchParams.get('state')!;
  expect(await oauth.completeAccount(state, 'good-code')).toEqual({ completed: true, offers: [] });
  expect(await oauth.accountStatus(OWNER)).toMatchObject({ connected: true,
    connectedTypes: Object.keys(GOOGLE_TOOL_SCOPES), accountEmail: 'owner@example.test' });
  const secondUrl = new URL(await oauth.beginAccount(OWNER, 'google-gmail'));
  expect(secondUrl.searchParams.get('scope')).toContain('calendar.readonly');
  expect(secondUrl.searchParams.get('scope')).toContain('gmail.readonly');
  expect(secondUrl.searchParams.get('scope')).toContain('yt-analytics');
  expect(await oauth.accountStatus(OWNER)).toMatchObject({ connected: true,
    connectedTypes: Object.keys(GOOGLE_TOOL_SCOPES), authorizationUrl: secondUrl.toString() });
  expect(await oauth.completeAccount(secondUrl.searchParams.get('state')!, 'good-code-2'))
    .toEqual({ completed: true, offers: [] });
  expect(await oauth.accountStatus(OWNER)).toEqual({ connected: true,
    connectedTypes: Object.keys(GOOGLE_TOOL_SCOPES), accountEmail: 'owner@example.test' });
  expect(await oauth.grantForOwner(OWNER)).toMatchObject({ accessToken: 'owner-token' });
  expect(await oauth.grantForOwner('c'.repeat(64))).toBeNull();
});

it('does not restore a disconnected account when an access-token refresh finishes later', async () => {
  let releaseRefresh!: () => void;
  let refreshStarted!: () => void;
  const started = new Promise<void>(resolve => { refreshStarted = resolve; });
  const refresh = new Promise<void>(resolve => { releaseRefresh = resolve; });
  let tokenCalls = 0;
  const transport = vi.fn(async (url: string | URL | Request) => {
    if (!String(url).endsWith('/token'))
      return new Response('{"email":"owner@example.test"}', { status: 200 });
    tokenCalls++;
    if (tokenCalls === 2) { refreshStarted(); await refresh; }
    return new Response(JSON.stringify({ access_token: `token-${tokenCalls}`,
      ...(tokenCalls === 1 ? { refresh_token: 'refresh' } : {}),
      expires_in: tokenCalls === 1 ? 0 : 3600,
      scope: ACCOUNT_SCOPES }), { status: 200 });
  }) as typeof fetch;
  const oauth = new GoogleOAuth(database, 'client-id', 'client-secret',
    'https://beeline.example', randomBytes(32).toString('base64'), transport);
  const state = new URL(await oauth.beginAccount(OWNER, 'google-calendar')).searchParams.get('state')!;
  expect((await oauth.completeAccount(state, 'code'))?.completed).toBe(true);
  const pending = oauth.grantForOwner(OWNER);
  await started;
  await oauth.disconnectAccount(OWNER);
  releaseRefresh();
  expect(await pending).toBeNull();
  expect(await oauth.accountStatus(OWNER)).toMatchObject({ connected: false, connectedTypes: [] });
});

it('withholds credentials when a stored connector no longer belongs to its helper owner', async () => {
  const transport = vi.fn(async (url: string | URL | Request) =>
    new Response(JSON.stringify(String(url).endsWith('/token') ? {
      access_token: 'owner-token', refresh_token: 'owner-refresh', expires_in: 3600,
      scope: 'openid email',
    } : { email: 'owner@example.test' }), { status: 200 })) as typeof fetch;
  const oauth = new GoogleOAuth(database, 'client-id', 'client-secret',
    'https://beeline.example', randomBytes(32).toString('base64'), transport);
  const state = new URL(await oauth.begin(CONNECTOR)).searchParams.get('state')!;
  expect(await oauth.complete(state, 'google-code')).toBe(true);
  expect(await oauth.grantForHelper(CONNECTOR, HELPER)).toMatchObject({ accessToken: 'owner-token' });

  const otherOwner = 'd'.repeat(64);
  await database.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Other owner')`, [otherOwner]);
  await database.query(`UPDATE agents SET owner_id=$2 WHERE agent_id=$1`, [HELPER, otherOwner]);
  vi.mocked(transport).mockClear();
  expect(await oauth.grantForHelper(CONNECTOR, HELPER)).toBeNull();
  expect(transport).not.toHaveBeenCalled();
});

it('exchanges one exact state, seals the grant, and returns it only to the paired helper', async () => {
  const requests: string[] = [];
  const transport = vi.fn(async (url: string | URL | Request) => {
    requests.push(String(url));
    if (String(url).endsWith('/token')) return new Response(JSON.stringify({
      access_token: 'ya29.secret', refresh_token: 'refresh.secret', expires_in: 3600,
      scope: 'openid email https://www.googleapis.com/auth/gmail.readonly',
    }), { status: 200 });
    return new Response(JSON.stringify({ email: 'owner@example.test' }), { status: 200 });
  }) as typeof fetch;
  const oauth = new GoogleOAuth(database, 'client-id', 'client-secret',
    'https://beeline.example', randomBytes(32).toString('base64'), transport);
  const start = new URL(await oauth.begin(CONNECTOR));
  expect(start.host).toBe('accounts.google.com');
  expect(start.searchParams.get('redirect_uri')).toBe('https://beeline.example/v1/google/oauth/callback');
  expect(start.searchParams.get('scope')).toContain('https://www.googleapis.com/auth/yt-analytics.readonly');
  const state = start.searchParams.get('state')!;
  expect(await oauth.complete(state, 'google-code')).toBe(true);
  expect(await oauth.complete(state, 'google-code')).toBe(false);
  expect(await oauth.grantForHelper(CONNECTOR, 'c'.repeat(64))).toBeNull();
  expect(await oauth.grantForHelper(CONNECTOR, HELPER)).toMatchObject({
    accessToken: 'ya29.secret',
    accountEmail: 'owner@example.test',
    scopes: ['openid', 'email', 'https://www.googleapis.com/auth/gmail.readonly'],
  });
  expect(await oauth.grantForHelper(CONNECTOR, HELPER)).not.toHaveProperty('refreshToken');
  const stored = await database.query<{ sealed_grant: string }>(
    `SELECT sealed_grant FROM google_oauth_grants WHERE workspace_id=$1`, [WORKSPACE]);
  expect(stored.rows[0]!.sealed_grant).not.toContain('ya29.secret');
  expect(requests).toHaveLength(2);
  const phone = new PhoneService(database, 'https://beeline.example', undefined,
    undefined, undefined, false, database, undefined, oauth);
  const calendar = await phone.pairConnector({ workspaceId: WORKSPACE,
    connectorType: 'google-calendar', helperAgentId: HELPER }, OWNER);
  const second = await database.query<{ sign_in: unknown }>(
    `SELECT sign_in FROM workspace_connectors WHERE id=$1`, [calendar.connectorId]);
  expect(second.rows[0]!.sign_in).toBeNull();
  await phone.unpairConnector({ workspaceId: WORKSPACE, connectorId: CONNECTOR }, OWNER);
  expect(await oauth.hasGrant(WORKSPACE, OWNER, HELPER)).toBe(true);
  await phone.unpairConnector({ workspaceId: WORKSPACE, connectorId: calendar.connectorId }, OWNER);
  expect(await oauth.hasGrant(WORKSPACE, OWNER, HELPER)).toBe(false);
});

it('only the newest retry state can finish Google sign-in', async () => {
  const transport = vi.fn(async () => new Response(JSON.stringify({
    access_token: 'fresh', refresh_token: 'refresh',
    scope: 'openid email https://www.googleapis.com/auth/gmail.readonly',
  }), { status: 200 })) as typeof fetch;
  const oauth = new GoogleOAuth(database, 'client-id', 'client-secret',
    'https://beeline.example', randomBytes(32).toString('base64'), transport);
  const first = new URL(await oauth.begin(CONNECTOR)).searchParams.get('state')!;
  const second = new URL(await oauth.begin(CONNECTOR)).searchParams.get('state')!;
  expect(second).not.toBe(first);
  expect(await oauth.cancel(first)).toBe(false);
  expect(await oauth.complete(first, 'old-code')).toBe(false);
  expect(transport).not.toHaveBeenCalled();
  const current = await database.query<{ status: string }>(
    `SELECT status FROM workspace_connectors WHERE id=$1`, [CONNECTOR]);
  expect(current.rows[0]!.status).toBe('installing');
});

it('renews an expired Workbench grant before a Room tool receives it', async () => {
  const transport = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).endsWith('/userinfo'))
      return new Response(JSON.stringify({ email: 'owner@example.test' }), { status: 200 });
    const fields = new URLSearchParams(String(init?.body));
    if (fields.get('grant_type') === 'refresh_token') {
      expect(fields.get('refresh_token')).toBe('server-refresh');
      return new Response(JSON.stringify({ access_token: 'renewed-token', expires_in: 3600 }),
        { status: 200 });
    }
    return new Response(JSON.stringify({ access_token: 'expired-token',
      refresh_token: 'server-refresh', expires_in: 1,
      scope: 'https://www.googleapis.com/auth/drive.readonly' }), { status: 200 });
  }) as typeof fetch;
  const oauth = new GoogleOAuth(database, 'client-id', 'client-secret',
    'https://beeline.example', randomBytes(32).toString('base64'), transport);
  const state = new URL(await oauth.begin(CONNECTOR)).searchParams.get('state')!;
  expect(await oauth.complete(state, 'code')).toBe(true);
  expect(await oauth.grantForHelper(CONNECTOR, HELPER)).toMatchObject({
    accessToken: 'renewed-token',
  });
  expect(await oauth.grantForHelper(CONNECTOR, HELPER)).not.toHaveProperty('refreshToken');
  expect(transport).toHaveBeenCalledTimes(3);
});

it('withholds an old machine grant from the retried tool until fresh OAuth completes', async () => {
  let exchange = 0;
  const transport = vi.fn(async (url: string | URL | Request) => {
    if (String(url).endsWith('/token')) {
      exchange += 1;
      return new Response(JSON.stringify({
        access_token: exchange === 1 ? 'old-token' : 'fresh-token',
        refresh_token: `refresh-${exchange}`, expires_in: 3600,
        scope: 'openid email https://www.googleapis.com/auth/gmail.readonly',
      }), { status: 200 });
    }
    return new Response(JSON.stringify({ email: 'owner@example.test' }), { status: 200 });
  }) as typeof fetch;
  const oauth = new GoogleOAuth(database, 'client-id', 'client-secret',
    'https://beeline.example', randomBytes(32).toString('base64'), transport);
  const firstState = new URL(await oauth.begin(CONNECTOR)).searchParams.get('state')!;
  expect(await oauth.complete(firstState, 'first-code')).toBe(true);
  expect(await oauth.grantForHelper(CONNECTOR, HELPER)).toMatchObject({ accessToken: 'old-token' });

  await database.query(
    `UPDATE workspace_connectors SET status='error',status_error='Gmail permission denied'
     WHERE id=$1`, [CONNECTOR]);
  const phone = new PhoneService(database, 'https://beeline.example', undefined,
    undefined, undefined, false, database, undefined, oauth);
  await phone.pairConnector({ workspaceId: WORKSPACE,
    connectorType: 'google-gmail', helperAgentId: HELPER }, OWNER);
  const retry = await database.query<{ sign_in: { url: string }; status_error: string }>(
    `SELECT sign_in,status_error FROM workspace_connectors WHERE id=$1`, [CONNECTOR]);
  expect(retry.rows[0]!.status_error).toBeNull();
  expect(await oauth.grantForHelper(CONNECTOR, HELPER)).toBeNull();

  const retryState = new URL(retry.rows[0]!.sign_in.url).searchParams.get('state')!;
  expect(await oauth.complete(retryState, 'retry-code')).toBe(true);
  expect(await oauth.grantForHelper(CONNECTOR, HELPER)).toMatchObject({
    accessToken: 'fresh-token',
  });
  const after = await database.query<{ status_error: string }>(
    `SELECT status_error FROM workspace_connectors WHERE id=$1`, [CONNECTOR]);
  expect(after.rows[0]!.status_error).toBeNull();
});

it('re-arms every Google tool on the machine when a fresh grant lands', async () => {
  const siblings = ['google-calendar', 'google-drive', 'google-youtube'];
  for (const [index, type] of siblings.entries())
    await database.query(
      `INSERT INTO workspace_connectors(id,workspace_id,owner_identity_id,connector_type,
        helper_agent_id,machine_id,status,status_error,status_steps,sign_in,pairing_generation)
       VALUES($1,$2,$3,$4,$5,$5,'error','Google authorization failed; retry the connection',
        '[{"label":"Google sign-in","status":"failed"}]'::jsonb,$6::jsonb,3)`,
      [`33333333-3333-4333-8333-33333333333${index}`, WORKSPACE, OWNER, type, HELPER,
        index === 0 ? JSON.stringify({ method: 'oauth', url: 'https://accounts.google.com/stale' }) : null],
    );
  const transport = vi.fn(async (url: string | URL | Request) =>
    new Response(JSON.stringify(String(url).endsWith('/token') ? {
      access_token: 'fresh', refresh_token: 'refresh', expires_in: 3600,
      scope: 'openid email',
    } : { email: 'owner@example.test' }), { status: 200 })) as typeof fetch;
  const oauth = new GoogleOAuth(database, 'client-id', 'client-secret',
    'https://beeline.example', randomBytes(32).toString('base64'), transport);
  const state = new URL(await oauth.begin(CONNECTOR)).searchParams.get('state')!;
  const query = vi.spyOn(database, 'query');
  expect(await oauth.complete(state, 'code')).toBe(true);
  const notified = query.mock.calls
    .filter(([sql]) => sql.includes('pg_notify'))
    .map(([, values]) => JSON.parse(String(values![1])).agentId);
  query.mockRestore();
  const rows = await database.query<{ connector_type: string; status: string;
    status_error: string | null; sign_in: unknown; pairing_generation: number }>(
    `SELECT connector_type,status,status_error,sign_in,pairing_generation
     FROM workspace_connectors WHERE workspace_id=$1 ORDER BY connector_type`, [WORKSPACE]);
  expect(rows.rows).toEqual([
    { connector_type: 'google-calendar', status: 'installing', status_error: null, sign_in: null, pairing_generation: 4 },
    { connector_type: 'google-drive', status: 'installing', status_error: null, sign_in: null, pairing_generation: 4 },
    { connector_type: 'google-gmail', status: 'installing', status_error: null, sign_in: null, pairing_generation: 2 },
    { connector_type: 'google-youtube', status: 'installing', status_error: null, sign_in: null, pairing_generation: 4 },
  ]);
  expect(notified).toContain(HELPER);
  for (const [index] of siblings.entries())
    expect(await oauth.grantForHelper(`33333333-3333-4333-8333-33333333333${index}`, HELPER))
      .toMatchObject({ accessToken: 'fresh' });
});

it('fails the attempt only when Google refuses the code, and logs why without tokens', async () => {
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const transport = vi.fn(async () => new Response(
      JSON.stringify({ error: 'invalid_grant', error_description: 'Bad Request' }),
      { status: 400 })) as typeof fetch;
    const oauth = new GoogleOAuth(database, 'client-id', 'client-secret',
      'https://beeline.example', randomBytes(32).toString('base64'), transport);
    const state = new URL(await oauth.begin(CONNECTOR)).searchParams.get('state')!;
    expect(await oauth.complete(state, 'code')).toBe(false);
    const row = await database.query<{ status: string; status_error: string }>(
      `SELECT status,status_error FROM workspace_connectors WHERE id=$1`, [CONNECTOR]);
    // A refusal offers Connect again (#1840).
    expect(row.rows[0]).toEqual({ status: 'disconnected', status_error: null });
    const logged = errors.mock.calls.map((call) => call.join(' ')).join('\n');
    expect(logged).toContain('400');
    expect(logged).toContain('invalid_grant');
  } finally {
    errors.mockRestore();
  }
});

it('leaves the attempt retryable when our own grant write fails', async () => {
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const transport = vi.fn(async (url: string | URL | Request) =>
      new Response(JSON.stringify(String(url).endsWith('/token') ? {
        access_token: 'ya29.secret', refresh_token: 'refresh.secret', expires_in: 3600,
        scope: 'openid email',
      } : { email: 'owner@example.test' }), { status: 200 })) as typeof fetch;
    const oauth = new GoogleOAuth(database, 'client-id', 'client-secret',
      'https://beeline.example', randomBytes(32).toString('base64'), transport);
    const state = new URL(await oauth.begin(CONNECTOR)).searchParams.get('state')!;
    const original = database.query.bind(database);
    const query = vi.spyOn(database, 'query').mockImplementation(async (sql, values) => {
      if (sql.includes('INSERT INTO google_oauth_grants')) throw new Error('connection reset');
      return original(sql, values);
    });
    expect(await oauth.complete(state, 'code')).toBe(false);
    query.mockRestore();
    const row = await database.query<{ status: string; status_error: string | null }>(
      `SELECT status,status_error FROM workspace_connectors WHERE id=$1`, [CONNECTOR]);
    expect(row.rows[0]).toEqual({ status: 'installing', status_error: null });
    const logged = errors.mock.calls.map((call) => call.join(' ')).join('\n');
    expect(logged).toContain('connection reset');
    expect(logged).not.toContain('ya29.secret');
    expect(logged).not.toContain('refresh.secret');
    // The same sign-in link can still finish once the write succeeds.
    expect(await oauth.complete(state, 'code-again')).toBe(true);
    expect(await oauth.grantForHelper(CONNECTOR, HELPER)).toMatchObject({ accessToken: 'ya29.secret' });
  } finally {
    errors.mockRestore();
  }
});

it('leaves the attempt retryable when Google cannot be reached', async () => {
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const transport = vi.fn(async () => { throw new TypeError('fetch failed'); }) as typeof fetch;
    const oauth = new GoogleOAuth(database, 'client-id', 'client-secret',
      'https://beeline.example', randomBytes(32).toString('base64'), transport);
    const state = new URL(await oauth.begin(CONNECTOR)).searchParams.get('state')!;
    expect(await oauth.complete(state, 'code')).toBe(false);
    const row = await database.query<{ status: string }>(
      `SELECT status FROM workspace_connectors WHERE id=$1`, [CONNECTOR]);
    expect(row.rows[0]!.status).toBe('installing');
    const attempt = await database.query(
      `SELECT 1 FROM google_oauth_attempts WHERE state=$1`, [state]);
    expect(attempt.rows).toHaveLength(1);
  } finally {
    errors.mockRestore();
  }
});

it('treats only Google invalid_grant as a terminal refresh refusal', async () => {
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  let refresh: Response = new Response('', { status: 503 });
  const transport = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).endsWith('/userinfo'))
      return new Response(JSON.stringify({ email: 'owner@example.test' }), { status: 200 });
    if (new URLSearchParams(String(init?.body)).get('grant_type') === 'refresh_token') return refresh;
    return new Response(JSON.stringify({ access_token: 'expired', refresh_token: 'server-refresh',
      expires_in: 1, scope: 'openid email' }), { status: 200 });
  }) as typeof fetch;
  try {
    const oauth = new GoogleOAuth(database, 'client-id', 'client-secret',
      'https://beeline.example', randomBytes(32).toString('base64'), transport);
    const state = new URL(await oauth.begin(CONNECTOR)).searchParams.get('state')!;
    expect(await oauth.complete(state, 'code')).toBe(true);
    const outage = await oauth.grantForHelper(CONNECTOR, HELPER).catch((error: Error) => error);
    expect(outage).toBeInstanceOf(Error);
    expect((outage as Error).message).not.toMatch(/invalid/);
    refresh = new Response(JSON.stringify({ error: 'invalid_client' }), { status: 401 });
    const misconfigured = await oauth.grantForHelper(CONNECTOR, HELPER).catch((error: Error) => error);
    expect((misconfigured as Error).message).not.toMatch(/invalid/);
    refresh = new Response(JSON.stringify({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }),
      { status: 400 });
    await expect(oauth.grantForHelper(CONNECTOR, HELPER)).rejects.toThrow(GOOGLE_GRANT_REVOKED);
    expect(GOOGLE_GRANT_REVOKED).toContain('invalid_grant');
  } finally {
    errors.mockRestore();
  }
});

it('sweeps a Google sign-in nobody finished back to Connect, even with Workbench closed', async () => {
  const oauth = new GoogleOAuth(database, 'client-id', 'client-secret',
    'https://beeline.example', randomBytes(32).toString('base64'));
  const phone = new PhoneService(database, 'https://beeline.example', undefined,
    undefined, undefined, false, database, undefined, oauth);
  const paired = await phone.pairConnector({ workspaceId: WORKSPACE,
    connectorType: 'google-gmail', helperAgentId: HELPER }, OWNER);
  expect(await oauth.expireAttempts()).toBe(0);
  await database.query(
    `UPDATE google_oauth_attempts SET expires_at=now()-interval '1 minute' WHERE connector_id=$1`,
    [paired.connectorId]);
  expect(await oauth.expireAttempts()).toBe(1);
  const row = await database.query<{ status: string; status_error: string; sign_in: unknown }>(
    `SELECT status,status_error,sign_in FROM workspace_connectors WHERE id=$1`, [paired.connectorId]);
  expect(row.rows[0]).toEqual({ status: 'disconnected', status_error: null, sign_in: null });
  expect((await database.query(`SELECT 1 FROM google_oauth_attempts`)).rows).toHaveLength(0);
  // Retry re-arms it with a fresh sign-in page.
  await phone.pairConnector({ workspaceId: WORKSPACE,
    connectorType: 'google-gmail', helperAgentId: HELPER }, OWNER);
  const retried = await database.query<{ status: string; status_error: string | null;
    sign_in: { method: string } }>(
    `SELECT status,status_error,sign_in FROM workspace_connectors WHERE id=$1`, [paired.connectorId]);
  expect(retried.rows[0]).toMatchObject({ status: 'installing', status_error: null,
    sign_in: { method: 'oauth' } });
});
