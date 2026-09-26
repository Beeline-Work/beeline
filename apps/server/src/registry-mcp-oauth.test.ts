import { afterEach, beforeEach, expect, it } from 'vitest';
import { migrate } from './database.js';
import { PgliteDatabase } from './test-support.js';
import { RegistryMcpOAuth } from './registry-mcp-oauth.js';

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
    `INSERT INTO workspace_connectors(
       id,workspace_id,owner_identity_id,connector_type,helper_agent_id,machine_id,status,
       registry_server_name,registry_version,registry_manifest,display_name
     ) VALUES($1,$2,$3,'registry-mcp',$4,$4,'installing','app.linear/linear','1.0.1',$5::jsonb,'Linear')`,
    [
      CONNECTOR,
      WORKSPACE,
      OWNER,
      HELPER,
      JSON.stringify({ name: 'app.linear/linear', version: '1.0.1' }),
    ],
  );
});

afterEach(async () => database.close());

it('lets only the paired helper claim one short-lived callback code', async () => {
  const oauth = new RegistryMcpOAuth(database, 'https://beeline.example');
  const started = await oauth.begin(CONNECTOR, HELPER);
  expect(started.redirectUri).toBe('https://beeline.example/v1/registry-mcp/oauth/callback');
  expect(await oauth.claim(CONNECTOR, started.state, HELPER)).toEqual({ status: 'pending' });
  expect(await oauth.complete(started.state, 'provider-code')).toBe(true);
  expect(await oauth.complete(started.state, 'duplicate-code')).toBe(false);
  expect(await oauth.claim(CONNECTOR, started.state, 'c'.repeat(64))).toEqual({
    status: 'pending',
  });
  expect(await oauth.claim(CONNECTOR, started.state, HELPER)).toEqual({
    status: 'ready',
    code: 'provider-code',
  });
  // The spent attempt is gone, and a gone attempt is expired, not pending:
  // the helper mints a fresh authorization instead of re-posting a dead URL.
  expect(await oauth.claim(CONNECTOR, started.state, HELPER)).toEqual({ status: 'expired' });
});

it('reports an authorization attempt nobody started as expired', async () => {
  const oauth = new RegistryMcpOAuth(database, 'https://beeline.example');
  expect(await oauth.claim(CONNECTOR, 'never-issued-state', HELPER)).toEqual({
    status: 'expired',
  });
});
