import { createHash, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate, PostgresDatabase, type SqlDatabase } from './database.js';
import { PgliteDatabase } from './test-support.js';
import { TokenAuth } from './auth.js';
import { PhoneService } from './phone-service.js';

const OWNER = 'a'.repeat(64);
const ISSUER = 'c'.repeat(64);
const AGENT = 'b'.repeat(64);
const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const ROOM = '22222222-2222-4222-8222-222222222222';
const CODE = '12345678-ABCDEF12';
const codeHash = createHash('sha256').update(CODE).digest('hex');
// Optional real PostgreSQL proof: loopback only, unique schema, never a shared account.
const postgresUrl = process.env.BEELINE_LIFETIME_TEST_POSTGRES_URL;
if (postgresUrl && !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(postgresUrl).hostname))
  throw new Error('lifetime proofs require an isolated loopback PostgreSQL');

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

// Pause a real statement after it acquired its locks; no timers or polling.
function pauseAfter(database: SqlDatabase, matches: (sql: string) => boolean) {
  const reached = deferred();
  const release = deferred();
  let paused = false;
  const wrap = (db: SqlDatabase): SqlDatabase => ({
    query: async (sql, values) => {
      const result = await db.query(sql, values);
      if (!paused && matches(sql)) {
        paused = true;
        reached.resolve();
        await release.promise;
      }
      return result;
    },
    transaction: (work) => db.transaction((tx) => work(wrap(tx))),
  });
  return { database: wrap(database), reached: reached.promise, release: release.resolve };
}

function observeStart(database: SqlDatabase) {
  const started = deferred();
  const wrap = (db: SqlDatabase): SqlDatabase => ({
    query: (sql, values) => {
      started.resolve();
      return db.query(sql, values);
    },
    transaction: (work) => db.transaction((tx) => work(wrap(tx))),
  });
  return { database: wrap(database), started: started.promise };
}

describe('authorization follows current membership and credential lifetime', () => {
  let database: SqlDatabase;
  let close: () => Promise<void>;
  let phone: PhoneService;
  let auth: TokenAuth;
  beforeEach(async () => {
    if (postgresUrl) {
      const schema = `lifetime_${randomUUID().replaceAll('-', '')}`;
      const admin = new Pool({ connectionString: postgresUrl });
      await admin.query(`CREATE SCHEMA ${schema}`);
      const pool = new Pool({
        connectionString: postgresUrl,
        options: `-c search_path=${schema},public`,
      });
      const pg = new PostgresDatabase('', 5, { pool, mode: 'migration' });
      database = pg;
      close = async () => {
        await pg.close();
        await admin.query(`DROP SCHEMA ${schema} CASCADE`);
        await admin.end();
      };
    } else {
      const db = new PgliteDatabase();
      database = db;
      close = () => db.close();
    }
    await migrate(database);
    await database.query(
      `INSERT INTO identities(id,kind,name,handle)
      VALUES($1,'human','Owner','owner'),($2,'human','Issuer','issuer'),($3,'agent','Agent','agent')`,
      [OWNER, ISSUER, AGENT],
    );
    await database.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`, [AGENT, OWNER]);
    await database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Fixture')`, [WORKSPACE]);
    await database.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'General')`, [
      ROOM,
      WORKSPACE,
    ]);
    await database.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role)
      VALUES($1,NULL,$2,'owner'),($1,$5,$2,'owner'),($1,NULL,$3,'member'),($1,$5,$3,'member'),
        ($1,NULL,$4,'member'),($1,$5,$4,'member')`,
      [WORKSPACE, OWNER, ISSUER, AGENT, ROOM],
    );
    phone = new PhoneService(database, 'http://fixture.invalid');
    auth = tokenAuth(database);
  });
  afterEach(async () => close());
  const tokenAuth = (db: SqlDatabase) =>
    new TokenAuth(db, async () => {
      throw new Error('unused verifier');
    });
  const retire = (service = phone) =>
    service.execute('removeAgent', { workspaceId: WORKSPACE, agentId: AGENT }, OWNER);
  async function pairing() {
    await database.query(
      `INSERT INTO agent_pairing_codes(code_hash,workspace_id,created_by,expires_at)
      VALUES($1,$2,$3,now()+interval '15 minutes')`,
      [codeHash, WORKSPACE, ISSUER],
    );
  }
  async function claim(service: PhoneService, variant: string) {
    return variant === 'connect'
      ? service.claimAgentConnectPairing({
          code: CODE,
          agentPubkey: 'd'.repeat(64),
          model: 'fixture',
        })
      : service.claimAgentPairing(CODE, AGENT);
  }
  async function permission() {
    await database.query(
      `INSERT INTO permission_authority(permission_id,room_id,principal_id,request_id,scope,status)
      VALUES('permission',$1,$2,'request','{}','pending')`,
      [ROOM, ISSUER],
    );
    await database.query(
      `INSERT INTO messages(id,room_id,author_id,text,presentation,card_type,card)
      VALUES($1,$2,$3,'Request','card','permission',$4::jsonb)`,
      [
        'f'.repeat(64),
        ROOM,
        AGENT,
        JSON.stringify({
          permissionId: 'permission',
          agent: { pubkey: AGENT },
          repository: 'owner/repo',
        }),
      ],
    );
  }
  const decide = (viewer = ISSUER, service = phone) =>
    service.execute(
      'decideWritePermission',
      {
        roomId: ROOM,
        permissionId: 'permission',
        requestId: 'request',
        agentId: AGENT,
        repository: 'owner/repo',
        decision: 'allow',
      },
      viewer,
    );

  it('retirement deletes unused exchanges and rejects redemption', async () => {
    const exchange = await auth.createDaemonExchange(AGENT);
    await retire();
    expect(
      (
        await database.query(
          `SELECT 1 FROM daemon_token_exchanges WHERE agent_id=$1 AND consumed_at IS NULL`,
          [AGENT],
        )
      ).rowCount,
    ).toBe(0);
    expect(await auth.exchangeDaemonToken(exchange.exchangeToken)).toBeNull();
  });
  it('retirement revokes a token issued before it', async () => {
    const exchange = await auth.createDaemonExchange(AGENT);
    const issued = await auth.exchangeDaemonToken(exchange.exchangeToken);
    expect(issued).not.toBeNull();
    await retire();
    expect(await tokenAuth(database).authenticateDaemon(issued!.daemonToken)).toBeNull();
    expect(await auth.exchangeDaemonToken(exchange.exchangeToken)).toBeNull();
  });
  it('rollback invalidates an unused exchange', async () => {
    await pairing();
    await database.query(`UPDATE agent_pairing_codes SET claimed_by=$1`, [AGENT]);
    const exchange = await auth.createDaemonExchange(AGENT);
    await phone.rollbackUnrealizedAgent(AGENT);
    expect(await auth.exchangeDaemonToken(exchange.exchangeToken)).toBeNull();
  });
  it('Workspace deletion invalidates an unused exchange of its last-member agent', async () => {
    const exchange = await auth.createDaemonExchange(AGENT);
    await phone.execute('deleteWorkspace', { workspaceId: WORKSPACE }, OWNER);
    expect(await auth.exchangeDaemonToken(exchange.exchangeToken)).toBeNull();
  });
  it.each(['removeWorkspaceMember', 'leaveWorkspace'] as const)(
    '%s deletes only the issuer’s unclaimed pairing codes',
    async (operation) => {
      await pairing();
      await database.query(
        `INSERT INTO agent_pairing_codes(code_hash,workspace_id,created_by,expires_at,claimed_by)
      VALUES('claimed',$1,$2,now()+interval '15 minutes',$3),('other',$1,$4,now()+interval '15 minutes',NULL)`,
        [WORKSPACE, ISSUER, AGENT, OWNER],
      );
      if (operation === 'leaveWorkspace')
        await phone.execute(operation, { workspaceId: WORKSPACE }, ISSUER);
      else await phone.execute(operation, { workspaceId: WORKSPACE, memberId: ISSUER }, OWNER);
      expect(
        (await database.query(`SELECT code_hash FROM agent_pairing_codes ORDER BY code_hash`)).rows,
      ).toEqual([{ code_hash: 'claimed' }, { code_hash: 'other' }]);
    },
  );
  it.each(['connect', 'legacy'])(
    '%s claim refuses a code whose issuer membership ended even if the code survives',
    async (variant) => {
      await pairing();
      await database.query(`UPDATE memberships SET removed_at=now() WHERE identity_id=$1`, [
        ISSUER,
      ]);
      const result = await claim(phone, variant);
      expect(result).toEqual(variant === 'connect' ? { status: 'not_found' } : null);
      expect(
        (
          await database.query(`SELECT claimed_by FROM agent_pairing_codes WHERE code_hash=$1`, [
            codeHash,
          ])
        ).rows[0]?.claimed_by,
      ).toBeNull();
    },
  );
  it.each(['Room', 'Workspace'])(
    'a permission requester who lost %s membership cannot decide',
    async (scope) => {
      await permission();
      await database.query(
        `UPDATE memberships SET removed_at=now() WHERE identity_id=$1 AND ${scope === 'Room' ? 'room_id=$2' : 'room_id IS NULL'}`,
        scope === 'Room' ? [ISSUER, ROOM] : [ISSUER],
      );
      await expect(decide()).rejects.toThrow('room access denied');
      expect(
        (await database.query(`SELECT status FROM permission_authority`)).rows[0]?.status,
      ).toBe('pending');
      expect(
        (await database.query(`SELECT 1 FROM messages WHERE card->>'decider' IS NOT NULL`))
          .rowCount,
      ).toBe(0);
    },
  );
  it('a current requester can decide', async () => {
    await permission();
    await decide();
    expect((await database.query(`SELECT status FROM permission_authority`)).rows[0]?.status).toBe(
      'authorized',
    );
  });
  it('the existing manager path works without Room membership', async () => {
    await permission();
    await database.query(
      `UPDATE memberships SET removed_at=now() WHERE room_id=$1 AND identity_id=$2`,
      [ROOM, OWNER],
    );
    await decide(OWNER);
    expect((await database.query(`SELECT status FROM permission_authority`)).rows[0]?.status).toBe(
      'authorized',
    );
  });

  describe.skipIf(!postgresUrl)('real concurrent transaction proofs', () => {
    it.each(['retirement', 'exchange'])(
      '%s wins the exchange race without leaving a usable token',
      async (winner) => {
        const exchange = await auth.createDaemonExchange(AGENT);
        const paused = pauseAfter(database, (sql) =>
          winner === 'retirement'
            ? sql.includes('UPDATE memberships SET removed_at=now()')
            : sql.includes('INSERT INTO daemon_tokens'),
        );
        const loser = observeStart(database);
        const first =
          winner === 'retirement'
            ? retire(new PhoneService(paused.database, 'http://fixture.invalid'))
            : tokenAuth(paused.database).exchangeDaemonToken(exchange.exchangeToken);
        await paused.reached;
        const second =
          winner === 'retirement'
            ? tokenAuth(loser.database).exchangeDaemonToken(exchange.exchangeToken)
            : retire(new PhoneService(loser.database, 'http://fixture.invalid'));
        await loser.started;
        paused.release();
        const results = await Promise.all([first, second]);
        const issued = results[winner === 'exchange' ? 0 : 1];
        if (winner === 'retirement') expect(issued).toBeNull();
        else {
          expect(issued).toHaveProperty('daemonToken');
          expect(
            await tokenAuth(database).authenticateDaemon(
              (issued as { daemonToken: string }).daemonToken,
            ),
          ).toBeNull();
        }
        expect(
          (
            await database.query(
              `SELECT 1 FROM daemon_tokens WHERE agent_id=$1 AND revoked_at IS NULL`,
              [AGENT],
            )
          ).rowCount,
        ).toBe(0);
      },
    );
    it.each(['connect', 'legacy'])(
      'removal wins a concurrent %s pairing claim',
      async (variant) => {
        await pairing();
        const paused = pauseAfter(database, (sql) =>
          sql.includes('UPDATE memberships SET removed_at=now()'),
        );
        const loser = observeStart(database);
        const removal = new PhoneService(paused.database, 'http://fixture.invalid').execute(
          'removeWorkspaceMember',
          { workspaceId: WORKSPACE, memberId: ISSUER },
          OWNER,
        );
        await paused.reached;
        const claiming = claim(new PhoneService(loser.database, 'http://fixture.invalid'), variant);
        await loser.started;
        paused.release();
        await removal;
        expect(await claiming).toEqual(variant === 'connect' ? { status: 'not_found' } : null);
      },
    );
    it('removal wins a permission decision begun while the requester was still visible', async () => {
      await permission();
      const paused = pauseAfter(database, (sql) =>
        sql.includes('UPDATE memberships SET removed_at=now()'),
      );
      const loser = observeStart(database);
      const removal = new PhoneService(paused.database, 'http://fixture.invalid').execute(
        'removeWorkspaceMember',
        { workspaceId: WORKSPACE, memberId: ISSUER },
        OWNER,
      );
      await paused.reached;
      const decision = decide(ISSUER, new PhoneService(loser.database, 'http://fixture.invalid'));
      const rejected = expect(decision).rejects.toThrow('room access denied');
      await loser.started;
      paused.release();
      await Promise.all([removal, rejected]);
    });
  });
});
