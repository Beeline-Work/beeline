import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { migrate, migrateData } from './database.js';
import { PgliteDatabase } from './test-support.js';
import { TokenAuth, tokenHash, verifierFromEnvironment, type PhoneTokens } from './auth.js';

describe('opaque token ceremony', () => {
  let db: PgliteDatabase;
  beforeEach(async () => {
    db = new PgliteDatabase();
    await migrate(db);
  });
  afterEach(() => db.close());
  async function phoneAuth(clock: () => Date) {
    const auth = new TokenAuth(
      db,
      async () => ({ subject: 'owner', login: 'owner', name: 'Owner' }),
      clock,
    );
    const initial = await auth.exchangeGitHubOidc('proof');
    return { auth, initial };
  }

  it('renews an unused session after every access row expired and was swept, across a server restart', async () => {
    let now = new Date('2026-10-12T19:53:39Z');
    const { initial } = await phoneAuth(() => now);
    now = new Date('2026-10-12T20:40:00Z');
    await db.query('DELETE FROM phone_access_tokens WHERE expires_at < $1', [now]);
    expect((await db.query('SELECT 1 FROM phone_access_tokens')).rowCount).toBe(0);
    const afterDeploy = new TokenAuth(db, async () => { throw new Error('unused'); }, () => now);
    expect(await afterDeploy.authenticatePhone(initial.accessToken)).toBeNull();
    const renewed = await afterDeploy.refresh(initial.refreshToken);
    expect(renewed?.identityId).toBe(initial.identityId);
    expect(await afterDeploy.authenticatePhone(renewed!.accessToken)).toBe(initial.identityId);
  });

  async function legacySuccessor(previous: PhoneTokens, generation: number): Promise<PhoneTokens> {
    const next = { ...previous, refreshToken: `legacy-successor-${generation}` };
    const key = createHash('sha256').update('beeline:refresh-replay:').update(previous.refreshToken).digest();
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(next), 'utf8'), cipher.final()]);
    const sealed = [iv, cipher.getAuthTag(), encrypted].map(p => p.toString('base64url')).join('.');
    await db.query(`INSERT INTO phone_sessions(refresh_hash,identity_id,family_id,expires_at)
      SELECT $1,identity_id,family_id,expires_at FROM phone_sessions WHERE refresh_hash=$2`,
      [tokenHash(next.refreshToken), tokenHash(previous.refreshToken)]);
    await db.query('UPDATE phone_sessions SET consumed_at=now(),successor_tokens=$2 WHERE refresh_hash=$1',
      [tokenHash(previous.refreshToken), sealed]);
    return next;
  }

  it('revokes only the signed-out device, leaving another sign-in for the same person usable', async () => {
    const { auth, initial } = await phoneAuth(() => new Date('2026-10-12T19:53:39Z'));
    const otherDevice = await auth.exchangeGitHubOidc('another-device');
    expect(otherDevice.identityId).toBe(initial.identityId);
    expect((await db.query('SELECT DISTINCT family_id FROM phone_sessions')).rowCount).toBe(2);
    await auth.revokePhoneSession(initial.refreshToken);
    await auth.revokePhoneSession(initial.refreshToken);
    expect(await auth.refresh(initial.refreshToken)).toBeNull();
    expect(await auth.authenticatePhone(initial.accessToken)).toBeNull();
    expect(await auth.authenticatePhone(otherDevice.accessToken)).toBe(initial.identityId);
    expect((await auth.refresh(otherDevice.refreshToken))?.identityId).toBe(initial.identityId);
  });

  it('retains the device credential after a lost reply, sleep beyond two minutes, and months of inactivity', async () => {
    let now = new Date('2026-10-11T14:00:00Z');
    const { auth, initial } = await phoneAuth(() => now);
    await auth.refresh(initial.refreshToken); // server committed, reply was lost
    now = new Date('2027-10-11T14:00:00Z');
    const afterRestart = new TokenAuth(db, async () => { throw new Error('unused'); }, () => now);
    const renewed = await afterRestart.refresh(initial.refreshToken);
    expect(renewed?.refreshToken).toBe(initial.refreshToken);
    expect(renewed!.refreshExpiresAt).toBeGreaterThan(now.getTime());
    expect(await afterRestart.authenticatePhone(renewed!.accessToken)).toBe(initial.identityId);
    expect((await db.query('SELECT * FROM phone_sessions')).rows).toEqual([
      expect.objectContaining({ consumed_at: null, successor_tokens: null }),
    ]);
  });

  it('recovers a legacy lost rotation reply long after the old grace window and access expiry', async () => {
    let now = new Date('2026-10-11T14:00:00Z');
    const { auth, initial } = await phoneAuth(() => now);
    const successor = await legacySuccessor(initial, 1);
    now = new Date('2026-10-15T14:00:00Z');
    const recovered = await auth.refresh(initial.refreshToken);
    expect(recovered?.refreshToken).toBe(successor.refreshToken);
    expect(await auth.authenticatePhone(recovered!.accessToken)).toBe(initial.identityId);
  });

  it('follows already-advanced legacy successors without revoking the current device session', async () => {
    const { auth, initial } = await phoneAuth(() => new Date('2026-10-11T14:00:00Z'));
    const successor = await legacySuccessor(initial, 1);
    const latest = await legacySuccessor(successor, 2);
    expect((await auth.refresh(initial.refreshToken))?.refreshToken).toBe(latest.refreshToken);
    expect((await auth.refresh(successor.refreshToken))?.refreshToken).toBe(latest.refreshToken);
    await auth.revokePhoneSession(initial.refreshToken);
    expect(await auth.refresh(latest.refreshToken)).toBeNull();
  });

  it('rejects an unrecoverable pre-replay token without deleting its live family', async () => {
    const { auth, initial } = await phoneAuth(() => new Date('2026-10-11T14:00:00Z'));
    const latest = await legacySuccessor(initial, 1);
    await db.query('UPDATE phone_sessions SET successor_tokens=NULL WHERE refresh_hash=$1', [tokenHash(initial.refreshToken)]);
    expect(await auth.refresh(initial.refreshToken)).toBeNull();
    expect((await auth.refresh(latest.refreshToken))?.refreshToken).toBe(latest.refreshToken);
  });

  it('upgrades the old expiry values before the sweep and keeps the change idempotent', async () => {
    const { auth, initial } = await phoneAuth(() => new Date('2026-10-11T14:00:00Z'));
    await db.query('DELETE FROM workflow_backfills WHERE name=$1', ['durable-phone-sessions-v1']);
    await db.query('UPDATE phone_sessions SET expires_at=$1', [new Date('2026-11-10T14:00:00Z')]);
    await migrateData(db);
    await migrateData(db);
    await db.query('DELETE FROM phone_sessions WHERE expires_at < $1', [new Date('2027-11-10T14:00:00Z')]);
    expect((await auth.refresh(initial.refreshToken))?.refreshToken).toBe(initial.refreshToken);
    expect((await db.query('SELECT expires_at FROM phone_sessions')).rows).toEqual([
      { expires_at: new Date('9999-12-31T23:59:59Z') },
    ]);
  });

  it('allows simultaneous renewals without rotating, clobbering or growing the refresh family', async () => {
    const { auth, initial } = await phoneAuth(() => new Date('2026-10-11T14:00:00Z'));
    const [first, second] = await Promise.all([auth.refresh(initial.refreshToken), auth.refresh(initial.refreshToken)]);
    expect(first?.refreshToken).toBe(initial.refreshToken);
    expect(second?.refreshToken).toBe(initial.refreshToken);
    expect((await db.query('SELECT 1 FROM phone_sessions')).rowCount).toBe(1);
    expect(await auth.authenticatePhone(first!.accessToken)).toBe(initial.identityId);
    expect(await auth.authenticatePhone(second!.accessToken)).toBe(initial.identityId);
  });
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
  it('keeps a name the person edited across later GitHub sign-ins', async () => {
    let githubName = 'Octo Cat';
    const auth = new TokenAuth(db, async () => ({
      subject: 'renamer',
      login: 'octocat',
      name: githubName,
    }));
    const first = await auth.exchangeGitHubOidc('proof');
    const nameOf = async () =>
      (
        await db.query<{ name: string }>(`SELECT name FROM identities WHERE id=$1`, [
          first.identityId,
        ])
      ).rows[0]?.name;
    expect(await nameOf()).toBe('Octo Cat');
    await db.query(`UPDATE identities SET name='Ada' WHERE id=$1`, [first.identityId]);
    githubName = 'Octo Cat Renamed';
    await auth.exchangeGitHubOidc('proof-again');
    expect(await nameOf()).toBe('Ada');
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
