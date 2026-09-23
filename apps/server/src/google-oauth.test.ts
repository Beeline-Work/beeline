import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { migrate } from './database.js';
import { PgliteDatabase } from './test-support.js';
import { GoogleOAuth } from './google-oauth.js';
import { PhoneService } from './phone-service.js';

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
  const denied = await database.query<{ status: string; status_error: string; sign_in: unknown }>(
    `SELECT status,status_error,sign_in FROM workspace_connectors WHERE id=$1`, [paired.connectorId]);
  expect(denied.rows[0]).toMatchObject({ status: 'error',
    status_error: 'Google authorization was denied', sign_in: null });
  await phone.pairConnector({ workspaceId: WORKSPACE,
    connectorType: 'google-gmail', helperAgentId: HELPER }, OWNER);
  const retry = await database.query<{ sign_in: { url: string }; status: string }>(
    `SELECT sign_in,status FROM workspace_connectors WHERE id=$1`, [paired.connectorId]);
  expect(retry.rows[0]!.status).toBe('installing');
  expect(new URL(retry.rows[0]!.sign_in.url).searchParams.get('state')).not.toBe(state);
});
afterEach(async () => database.close());

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
