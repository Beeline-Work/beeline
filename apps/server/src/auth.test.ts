import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { migrate } from './database.js';
import { PgliteDatabase } from './test-support.js';
import { TokenAuth, tokenHash, verifierFromEnvironment } from './auth.js';

describe('opaque token ceremony', () => {
  let db: PgliteDatabase;
  beforeEach(async () => {
    db = new PgliteDatabase();
    await migrate(db);
  });
  afterEach(() => db.close());
  it('makes daemon exchange codes one use and token hashes the only stored secret', async () => {
    await db.query(
      `INSERT INTO identities(id,kind,name) VALUES($1,'human','owner'),($2,'agent','bee')`,
      ['a'.repeat(64), 'b'.repeat(64)],
    );
    const verify = async () => ({ subject: 'x', login: 'x', name: 'x' });
    const auth = new TokenAuth(db, verify);
    const exchange = await auth.createDaemonExchange('b'.repeat(64));
    const first = await auth.exchangeDaemonToken(exchange.exchangeToken);
    expect(first?.daemonToken).toMatch(/^bdt_/);
    await expect(auth.exchangeDaemonToken(exchange.exchangeToken)).resolves.toBeNull();
    const raw = await db.query<{ token_hash: string }>(`SELECT token_hash FROM daemon_tokens`);
    expect(raw.rows[0]?.token_hash).not.toContain(first!.daemonToken);
    const afterRestart = new TokenAuth(db, verify);
    await expect(afterRestart.authenticateDaemon(first!.daemonToken)).resolves.toBe('b'.repeat(64));
  });
  it('rejects revoked and expired daemon tokens without writing their last-used timestamp', async () => {
    const agent = 'b'.repeat(64);
    const now = new Date('2026-09-06T12:00:00.000Z');
    await db.query(`INSERT INTO identities(id,kind,name) VALUES($1,'agent','bee')`, [agent]);
    await db.query(
      `INSERT INTO daemon_tokens(token_hash,agent_id,expires_at,revoked_at)
       VALUES($1,$3,NULL,$4),($2,$3,$5,NULL)`,
      [
        tokenHash('revoked-token'),
        tokenHash('expired-token'),
        agent,
        new Date('2026-09-06T11:59:59.000Z'),
        new Date('2026-09-06T11:59:59.000Z'),
      ],
    );
    const auth = new TokenAuth(
      db,
      async () => ({ subject: 'x', login: 'x', name: 'x' }),
      () => now,
    );

    await expect(auth.authenticateDaemon('revoked-token')).resolves.toBeNull();
    await expect(auth.authenticateDaemon('expired-token')).resolves.toBeNull();
    const rows = await db.query<{ last_used_at: Date | null }>(
      `SELECT last_used_at FROM daemon_tokens ORDER BY token_hash`,
    );
    expect(rows.rows).toEqual([{ last_used_at: null }, { last_used_at: null }]);
  });
  it('bounds a cached daemon authorization to ten seconds after revocation', async () => {
    const agent = 'b'.repeat(64);
    let now = new Date('2026-09-06T12:00:00.000Z');
    await db.query(`INSERT INTO identities(id,kind,name) VALUES($1,'agent','bee')`, [agent]);
    await db.query(`INSERT INTO daemon_tokens(token_hash,agent_id) VALUES($1,$2)`, [
      tokenHash('cached-token'),
      agent,
    ]);
    const auth = new TokenAuth(
      db,
      async () => ({ subject: 'x', login: 'x', name: 'x' }),
      () => now,
    );

    const query = vi.spyOn(db, 'query');
    await expect(auth.authenticateDaemon('cached-token')).resolves.toBe(agent);
    expect(query).toHaveBeenCalledTimes(1);
    await db.query(`UPDATE daemon_tokens SET revoked_at=$2 WHERE token_hash=$1`, [
      tokenHash('cached-token'),
      now,
    ]);
    expect(query).toHaveBeenCalledTimes(2);
    now = new Date(now.getTime() + 9_999);
    await expect(auth.authenticateDaemon('cached-token')).resolves.toBe(agent);
    expect(query).toHaveBeenCalledTimes(2);
    now = new Date(now.getTime() + 1);
    await expect(auth.authenticateDaemon('cached-token')).resolves.toBeNull();
    expect(query).toHaveBeenCalledTimes(3);
  });
  it('preserves an imported legacy identity and lands it in no Workspace on first monolith sign-in', async () => {
    const legacy = 'a'.repeat(64);
    await db.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Legacy')`, [legacy]);
    await db.query(
      `INSERT INTO identity_external_links(provider,subject,identity_id,issuer,audience) VALUES('github','42',$1,'https://github.com','old-client')`,
      [legacy],
    );
    const auth = new TokenAuth(db, async () => ({ subject: '42', login: 'owner', name: 'Owner' }));
    const tokens = await auth.exchangeGitHubOidc('proof');
    expect(tokens.identityId).toBe(legacy);
    expect(await auth.authenticatePhone(tokens.accessToken)).toBe(legacy);
    expect(
      (await db.query(`SELECT 1 FROM memberships WHERE identity_id=$1`, [legacy])).rowCount,
    ).toBe(0);
  });
  it('preserves existing Workspace ownership and adds no shared Welcome membership', async () => {
    const captain = 'c'.repeat(64);
    const tubingCrew = '11111111-1111-4111-8111-111111111111';
    await db.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Captain')`, [captain]);
    await db.query(
      `INSERT INTO identity_external_links(provider,subject,identity_id,issuer,audience)
       VALUES('github','captain',$1,'https://github.com','old-client')`,
      [captain],
    );
    await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Tubing Crew')`, [tubingCrew]);
    await db.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role)
       VALUES($1,NULL,$2,'owner')`,
      [tubingCrew, captain],
    );
    const auth = new TokenAuth(db, async () => ({
      subject: 'captain',
      login: 'captain',
      name: 'Captain',
    }));

    await auth.exchangeGitHubOidc('proof');

    expect((await db.query(`SELECT id,name FROM workspaces ORDER BY id`)).rows).toEqual([
      { id: tubingCrew, name: 'Tubing Crew' },
    ]);
    expect(
      (
        await db.query(
          `SELECT workspace_id,identity_id,role FROM memberships
           WHERE identity_id=$1 AND room_id IS NULL AND removed_at IS NULL ORDER BY workspace_id`,
          [captain],
        )
      ).rows,
    ).toEqual([{ workspace_id: tubingCrew, identity_id: captain, role: 'owner' }]);
  });
  it('creates no Workspace or membership for a brand-new identity', async () => {
    const auth = new TokenAuth(db, async () => ({
      subject: 'first-sign-in',
      login: 'first',
      name: 'First',
    }));
    const first = await auth.exchangeGitHubOidc('proof');
    await auth.exchangeGitHubOidc('proof-again');
    expect((await db.query(`SELECT 1 FROM workspaces`)).rowCount).toBe(0);
    expect(
      (await db.query(`SELECT 1 FROM memberships WHERE identity_id=$1`, [first.identityId]))
        .rowCount,
    ).toBe(0);
  });
  it('never refills a Welcome Workspace that still exists, and migrate never reseeds it', async () => {
    const welcomeId = 'bee11e00-0000-4000-8000-000000000001';
    const roomId = 'bee11e00-0000-4000-8000-000000000002';
    await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Beeline Welcome')`, [welcomeId]);
    await db.query(
      `INSERT INTO rooms(id,workspace_id,name,visibility) VALUES($1,$2,'welcome','public')`,
      [roomId, welcomeId],
    );
    const auth = new TokenAuth(db, async () => ({
      subject: 'welcome-second',
      login: 'second',
      name: 'Second',
    }));
    const second = await auth.exchangeGitHubOidc('proof');
    await migrate(db);
    expect(
      (await db.query(`SELECT 1 FROM memberships WHERE identity_id=$1`, [second.identityId]))
        .rowCount,
    ).toBe(0);
    await db.query(`DELETE FROM workspaces WHERE id=$1`, [welcomeId]);
    await migrate(db);
    expect((await db.query(`SELECT 1 FROM workspaces WHERE id=$1`, [welcomeId])).rowCount).toBe(0);
  });
  it('redeems only the one-use auth ticket and receives no GitHub access token', async () => {
    const request = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.method).toBe('POST');
      expect(JSON.parse(String(init?.body))).toEqual({ ticket: 'ticket-proof' });
      return new Response(JSON.stringify({ subject: '42', login: 'owner', name: 'Owner' }), {
        status: 200,
      });
    });
    vi.stubGlobal('fetch', request);
    vi.stubEnv('PHONE_GITHUB_EXCHANGE_ENDPOINT', 'https://auth.example/phone-exchange');
    await expect(verifierFromEnvironment(vi.fn())('ticket-proof')).resolves.toEqual({
      subject: '42',
      login: 'owner',
      name: 'Owner',
    });
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });
  it('uses local identities in development and the mounted verifier by default', async () => {
    const mounted = vi.fn(async () => ({ subject: '42', login: 'owner', name: 'Owner' }));
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('PHONE_GITHUB_EXCHANGE_ENDPOINT', '');
    await expect(verifierFromEnvironment(mounted)('local:octocat')).resolves.toEqual({
      subject: 'local-octocat',
      login: 'octocat',
      name: 'octocat',
    });
    await expect(verifierFromEnvironment(mounted)('ticket-proof')).resolves.toEqual({
      subject: '42',
      login: 'owner',
      name: 'Owner',
    });
    expect(mounted).toHaveBeenCalledOnce();
    vi.unstubAllEnvs();
  });
});
