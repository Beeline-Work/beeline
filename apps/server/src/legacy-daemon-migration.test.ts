import { afterEach, beforeEach, expect, it } from 'vitest';
import { generateKeypair, nip98AuthHeader } from '@beeline/nostr';
import { migrate } from './database.js';
import { PgliteDatabase } from './test-support.js';
import { TokenAuth } from './auth.js';
import { createBeelineServer, type ServerOptions } from './server.js';
import { LiveHub } from './live.js';
import { PhoneService } from './phone-service.js';
import { DaemonService } from './daemon-service.js';

const owner = 'a'.repeat(64),
  workspace = '11111111-1111-4111-8111-111111111111';
let database: PgliteDatabase,
  auth: TokenAuth,
  server: ReturnType<typeof createBeelineServer>,
  origin: string;
const key = generateKeypair();
beforeEach(async () => {
  database = new PgliteDatabase();
  await migrate(database);
  await database.query(
    `INSERT INTO identities(id,kind,name) VALUES($1,'human','Owner'),($2,'agent','Legacy')`,
    [owner, key.publicKey],
  );
  await database.query(
    `INSERT INTO agents(agent_id,owner_id,access_policy) VALUES($1,$2,'{"type":"creator"}')`,
    [key.publicKey, owner],
  );
  await database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Fixture')`, [workspace]);
  await database.query(
    `INSERT INTO memberships(workspace_id,identity_id,role) VALUES($1,$2,'owner'),($1,$3,'member')`,
    [workspace, owner, key.publicKey],
  );
  auth = new TokenAuth(database, async () => {
    throw new Error('unused');
  });
  const live = new LiveHub();
  const options: ServerOptions = {
    database,
    auth,
    phone: new PhoneService(database, 'http://fixture'),
    daemon: new DaemonService(database, live),
    live,
    mediaMaximumBytes: 1024,
    legacyMigrationOrigin: '',
  };
  server = createBeelineServer(options);
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  options.legacyMigrationOrigin = origin;
});
afterEach(async () => {
  await new Promise<void>((done) => server.close(() => done()));
  await database.close();
});
function request(
  identity = key,
  payload = { workspaceId: workspace, pairedBy: owner },
  authorization?: string,
) {
  const url = `${origin}/v1/auth/daemon/migrate-legacy`;
  return fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization:
        authorization ?? nip98AuthHeader(identity.secretKey, identity.publicKey, url, 'POST'),
    },
    body: JSON.stringify(payload),
  });
}
it('redelivers the same migration credential after a lost exchange reply, without minting twice or reviving revocation', async () => {
  const exchange = await (await request()).json();
  const redeem = () =>
    fetch(`${origin}/v1/auth/daemon/exchange`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ exchangeToken: exchange.exchangeToken }),
    });
  const issued = await (await redeem()).json();
  const replay = await redeem();
  expect(replay.status).toBe(200);
  expect(await replay.json()).toEqual(issued);
  await database.query("UPDATE daemon_token_exchanges SET expires_at=now()-interval '1 day'");
  const delayed = await redeem();
  expect(delayed.status).toBe(200);
  expect(await delayed.json()).toEqual(issued);
  expect(
    (await database.query('SELECT count(*)::int AS count FROM daemon_tokens')).rows[0]?.count,
  ).toBe(1);
  await database.query('UPDATE daemon_tokens SET revoked_at=now() WHERE agent_id=$1', [
    key.publicKey,
  ]);
  expect((await redeem()).status).toBe(401);
});
it('migrates an authorized legacy identity once without changing its identity or permissions', async () => {
  const first = await request();
  expect(first.status).toBe(200);
  const exchange = await first.json();
  expect(exchange.agentId).toBe(key.publicKey);
  const activated = await auth.exchangeDaemonToken(exchange.exchangeToken);
  expect(activated?.agentId).toBe(key.publicKey);
  expect(await auth.authenticateDaemon(activated!.daemonToken)).toBe(key.publicKey);
  expect((await request()).status).toBe(403);
  expect(
    (
      await database.query<{ access_policy: unknown }>(
        `SELECT access_policy FROM agents WHERE agent_id=$1`,
        [key.publicKey],
      )
    ).rows[0]?.access_policy,
  ).toEqual({ type: 'creator' });
});
it('recovers a lost migration reply with a fresh proof and invalidates its prior unused exchange', async () => {
  const first = await (await request()).json();
  const second = await (await request()).json();
  expect(second.exchangeToken).not.toBe(first.exchangeToken);
  expect(await auth.exchangeDaemonToken(first.exchangeToken)).toBeNull();
  expect(await auth.exchangeDaemonToken(second.exchangeToken)).not.toBeNull();
});
it('allows a currently authorized relay record even when an earlier cutover minted an active credential', async () => {
  await auth.exchangeDaemonToken((await auth.createDaemonExchange(key.publicKey)).exchangeToken);
  const migration = await request();
  expect(migration.status).toBe(200);
  const exchange = await migration.json();
  expect(await auth.exchangeDaemonToken(exchange.exchangeToken)).not.toBeNull();
  expect((await request()).status).toBe(403);
});
it('does not mint a daemon token when removal wins between migration and exchange', async () => {
  const exchange = await (await request()).json();
  await database.query(`UPDATE memberships SET removed_at=now() WHERE identity_id=$1`, [
    key.publicKey,
  ]);
  expect(await auth.exchangeDaemonToken(exchange.exchangeToken)).toBeNull();
  expect(
    (await database.query(`SELECT 1 FROM daemon_tokens WHERE agent_id=$1`, [key.publicKey]))
      .rowCount,
  ).toBe(0);
});
it('refuses replay, the wrong request binding, unknown keys, removed membership and revoked monolith access', async () => {
  const url = `${origin}/v1/auth/daemon/migrate-legacy`;
  const proof = nip98AuthHeader(key.secretKey, key.publicKey, url, 'POST');
  expect((await request(key, undefined, proof)).status).toBe(200);
  expect((await request(key, undefined, proof)).status).toBe(403);
  expect((await request(generateKeypair())).status).toBe(403);
  expect(
    (
      await request(
        key,
        undefined,
        nip98AuthHeader(key.secretKey, key.publicKey, `${origin}/wrong`, 'POST'),
      )
    ).status,
  ).toBe(401);
  await database.query(`UPDATE memberships SET removed_at=now() WHERE identity_id=$1`, [
    key.publicKey,
  ]);
  expect((await request()).status).toBe(403);
  await database.query(`UPDATE memberships SET removed_at=NULL WHERE identity_id=$1`, [
    key.publicKey,
  ]);
  const token = await auth.exchangeDaemonToken(
    (await auth.createDaemonExchange(key.publicKey)).exchangeToken,
  );
  await database.query(`UPDATE daemon_tokens SET revoked_at=now() WHERE agent_id=$1`, [
    key.publicKey,
  ]);
  expect(token).not.toBeNull();
  expect((await request()).status).toBe(403);
});
