import { createHash } from 'node:crypto';
import { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { migrate } from './database.js';
import { PgliteDatabase } from './test-support.js';
import { TokenAuth } from './auth.js';
import { PhoneService } from './phone-service.js';
import { DaemonService } from './daemon-service.js';
import { LiveHub } from './live.js';
import { createBeelineServer } from './server.js';
import {
  DELETED_ACCOUNT_IDENTITY_ID,
  DELETED_ACCOUNT_NAME,
} from '@beeline/api-contract/system-identity';
import { REVIEW_IDENTITY_ID } from './review-access.js';

// sha256('github:owner') — the same derivation TokenAuth.exchangeGitHubOidc
// uses, so the fresh sign-in assertion below recreates the SAME id.
const OWNER = createHash('sha256').update('github:owner').digest('hex');
const PARTNER = createHash('sha256').update('github:partner').digest('hex');
const AGENT = 'b'.repeat(64);
const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const ROOM = '22222222-2222-4222-8222-222222222222';
const DM_HUMAN = '33333333-3333-4333-8333-333333333333';
const DM_AGENT = '44444444-4444-4444-8444-444444444444';
const CORNER = '55555555-5555-4555-8555-555555555555';

describe('deleteAccount', () => {
  let database: PgliteDatabase;
  let auth: TokenAuth;
  let phone: PhoneService;
  let origin: string | undefined;
  let server: ReturnType<typeof createBeelineServer> | undefined;
  let ownerToken: string;

  const seed = async () => {
    await database.query(
      `INSERT INTO identities(id,kind,name,github_subject) VALUES
         ($1,'human','Owner','owner'),($2,'human','Partner','partner'),($3,'agent','Bee',NULL)`,
      [OWNER, PARTNER, AGENT],
    );
    await database.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`, [AGENT, OWNER]);
    await database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Hive')`, [WORKSPACE]);
    await database.query(
      `INSERT INTO rooms(id,workspace_id,name,created_by) VALUES($1,$2,'General',$3)`,
      [ROOM, WORKSPACE, OWNER],
    );
    await database.query(
      `INSERT INTO rooms(id,workspace_id,name,direct_participants) VALUES($1,$2,'Direct message',$4::jsonb),
         ($3,$2,'Direct message',$5::jsonb)`,
      [DM_HUMAN, WORKSPACE, DM_AGENT, JSON.stringify([OWNER, PARTNER]), JSON.stringify([OWNER, AGENT])],
    );
    await database.query(
      `INSERT INTO rooms(id,workspace_id,parent_id,name) VALUES($1,$2,$3,'Corner')`,
      [CORNER, WORKSPACE, ROOM],
    );
    await database.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES
         ($1,NULL,$2,'owner'),($1,NULL,$3,'member'),
         ($1,$4,$2,'owner'),($1,$4,$3,'member'),($1,$4,$5,'member'),
         ($1,$6,$2,'member'),($1,$6,$3,'member'),
         ($1,$7,$2,'member'),($1,$7,$5,'member')`,
      [WORKSPACE, OWNER, PARTNER, ROOM, AGENT, DM_HUMAN, DM_AGENT],
    );
    await database.query(
      `INSERT INTO corner_facts(corner_id,owner_agent_id,objective,lifecycle) VALUES($1,$2,'ship it','{"lifecycle":"working"}'::jsonb)`,
      [CORNER, AGENT],
    );
    // Authored content: the owner in the shared Room mentioning the partner,
    // the agent in the shared Room mentioning the owner, the owner in the
    // human DM.
    await database.query(
      `INSERT INTO messages(id,room_id,author_id,text,mention_ids) VALUES
         ('m1',$1,$2,'hello @partner',$5::jsonb),
         ('m2',$1,$3,'on it @owner',$6::jsonb),
         ('m3',$4,$2,'just us',$7::jsonb)`,
      [
        ROOM,
        OWNER,
        AGENT,
        DM_HUMAN,
        JSON.stringify([PARTNER]),
        JSON.stringify([OWNER]),
        JSON.stringify([]),
      ],
    );
    // The agent's working state and schedules.
    await database.query(
      `INSERT INTO agent_turns(room_id,request_id,agent_id,status) VALUES($1,'req-1',$2,'complete')`,
      [ROOM, AGENT],
    );
    await database.query(
      `INSERT INTO live_outputs(room_id,agent_id,turn_id,kind,body) VALUES($1,$2,'turn-1','draft','{"text":"working"}'::jsonb)`,
      [ROOM, AGENT],
    );
    await database.query(
      `INSERT INTO work_schedules(schedule_id,agent_id,room_id,revision,schedule) VALUES('ws-1',$1,$2,1,'{"kind":"cron"}'::jsonb)`,
      [AGENT, ROOM],
    );
    await database.query(
      `INSERT INTO schedule_receipts(schedule_id,occurrence_id,agent_id,room_id,status) VALUES('ws-1','occ-1',$1,$2,'ran')`,
      [AGENT, ROOM],
    );
    await database.query(
      `INSERT INTO agent_schedules(id,workspace_id,room_id,agent_id,creator_id,cadence,message,next_run_at)
       VALUES('66666666-6666-4666-8666-666666666666',$1,$2,$3,$4,'{"kind":"interval"}'::jsonb,'check',now()+interval '1 hour')`,
      [WORKSPACE, ROOM, AGENT, OWNER],
    );
    await database.query(
      `INSERT INTO agent_mandates(agent_id,room_id,generation,mandate) VALUES($1,$2,1,'{"kind":"always"}'::jsonb)`,
      [AGENT, ROOM],
    );
    // Grants, invites, pairing codes, media, authority rows, GitHub.
    await database.query(
      `INSERT INTO agent_grants(id,agent_id,workspace_id,kind,target,reason,requested_by,room_id,status)
       VALUES('77777777-7777-4777-8777-777777777777',$1,$2,'command','npm test','needed',$3,$4,'approved')`,
      [AGENT, WORKSPACE, OWNER, ROOM],
    );
    await database.query(
      `INSERT INTO invites(token_hash,workspace_id,created_by,expires_at) VALUES($1,$2,$3,now()+interval '1 day')`,
      ['a'.repeat(64), WORKSPACE, OWNER],
    );
    await database.query(
      `INSERT INTO agent_pairing_codes(code_hash,workspace_id,created_by,expires_at) VALUES($1,$2,$3,now()+interval '1 day')`,
      ['b'.repeat(64), WORKSPACE, OWNER],
    );
    await database.query(
      `INSERT INTO media(id,owner_id,bytes,mime_type,name,sha256) VALUES
         ('88888888-8888-4888-8888-888888888888',$1,'x'::bytea,'text/plain','notes.txt',$2)`,
      [OWNER, createHash('sha256').update('notes').digest('hex')],
    );
    await database.query(
      `INSERT INTO permission_authority(permission_id,room_id,principal_id,request_id,scope,status)
       VALUES('perm-1',$1,$2,'req-perm','{}'::jsonb,'authorized')`,
      [ROOM, AGENT],
    );
    await database.query(
      `INSERT INTO push_devices(token,identity_id,platform,environment) VALUES('device-token',$1,'ios','physical')`,
      [OWNER],
    );
    await database.query(
      `INSERT INTO github_installations(installation_id,owner_id,account_login,account_type) VALUES(9001,$1,'owner','User')`,
      [OWNER],
    );
    await database.query(
      `INSERT INTO github_user_tokens(subject,encrypted_token) VALUES('owner','enc')`,
    );
  };

  beforeEach(async () => {
    database = new PgliteDatabase();
    await migrate(database);
    await seed();
    auth = new TokenAuth(database, async (proof) => {
      const login = proof === 'proof' ? 'owner' : proof === 'partner-proof' ? 'partner' : proof;
      return { subject: login, login, name: login[0]!.toUpperCase() + login.slice(1) };
    });
    phone = new PhoneService(database, 'http://placeholder', undefined, async () => undefined);
  });

  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    await database.close();
  });

  /** Mounts the real HTTP server so the operation runs over the wire. */
  const startServer = async () => {
    server = createBeelineServer({
      database,
      auth,
      phone,
      daemon: new DaemonService(database, new LiveHub(), async () => ({
        token: 'github-room-token',
        expiresAt: Date.now() + 60_000,
      })),
      live: new LiveHub(),
      mediaMaximumBytes: 1024 * 1024,
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
  };

  const expectRowCount = async (sql: string, values: unknown[], expected: number) => {
    const result = await database.query(sql, values);
    expect(result.rowCount, sql).toBe(expected);
  };

  it('deletes the account and its agents through the real operation path, anonymising shared content', async () => {
    await startServer();
    ownerToken = (await auth.exchangeGitHubOidc('proof')).accessToken;

    const response = await fetch(`${origin}/v1/phone/operations/deleteAccount`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ownerToken}`, 'content-type': 'application/json' },
      body: '{}',
    });
    expect(response.status).toBe(204);

    // The person and their agent are gone; the tombstone author is in.
    await expectRowCount(`SELECT 1 FROM identities WHERE id=ANY($1)`, [[OWNER, AGENT]], 0);
    await expectRowCount(
      `SELECT 1 FROM identities WHERE id=$1 AND kind='human' AND hidden_from_roster AND name=$2 AND github_subject IS NULL`,
      [DELETED_ACCOUNT_IDENTITY_ID, DELETED_ACCOUNT_NAME],
      1,
    );

    // Shared-content rule: messages survive, re-attributed and unmentioned.
    await expectRowCount(
      `SELECT 1 FROM messages WHERE id IN ('m1','m2','m3') AND author_id=$1`,
      [DELETED_ACCOUNT_IDENTITY_ID],
      3,
    );
    await expectRowCount(
      `SELECT 1 FROM messages WHERE id IN ('m1','m2','m3')
       AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(mention_ids) m WHERE m=ANY($1))`,
      [[OWNER, AGENT]],
      0,
    );

    // The human DM survives with the deleted participant scrubbed; the DM
    // nobody else relies on (person↔own agent) goes with the account.
    await expectRowCount(`SELECT 1 FROM rooms WHERE id=$1`, [DM_HUMAN], 1);
    await expectRowCount(
      `SELECT 1 FROM rooms WHERE id=$1 AND direct_participants=$2::jsonb`,
      [DM_HUMAN, JSON.stringify([PARTNER])],
      1,
    );
    await expectRowCount(`SELECT 1 FROM rooms WHERE id=$1`, [DM_AGENT], 0);

    // The agent's corner archives as done/abandoned and loses its owner.
    await expectRowCount(
      `SELECT 1 FROM rooms r JOIN corner_facts f ON f.corner_id=r.id
       WHERE r.id=$1 AND r.archived_at IS NOT NULL
         AND f.owner_agent_id IS NULL AND f.close_requested
         AND f.lifecycle->>'lifecycle'='done' AND f.lifecycle->>'outcome'='abandoned'`,
      [CORNER],
      1,
    );

    // Personal state: everything keyed to the person or the agent is gone.
    for (const [sql, values] of [
      [`SELECT 1 FROM agent_turns WHERE agent_id=ANY($1)`, [[OWNER, AGENT]]],
      [`SELECT 1 FROM live_outputs WHERE agent_id=ANY($1)`, [[OWNER, AGENT]]],
      [`SELECT 1 FROM work_schedules WHERE agent_id=ANY($1)`, [[OWNER, AGENT]]],
      [`SELECT 1 FROM schedule_receipts WHERE agent_id=ANY($1)`, [[OWNER, AGENT]]],
      [`SELECT 1 FROM agent_schedules WHERE creator_id=ANY($1) OR agent_id=ANY($1)`, [[OWNER, AGENT]]],
      [`SELECT 1 FROM agent_mandates WHERE agent_id=ANY($1)`, [[OWNER, AGENT]]],
      [`SELECT 1 FROM agent_grants WHERE requested_by=ANY($1)`, [[OWNER, AGENT]]],
      [`SELECT 1 FROM permission_authority WHERE principal_id=ANY($1)`, [[OWNER, AGENT]]],
      [`SELECT 1 FROM invites`, []],
      [`SELECT 1 FROM agent_pairing_codes`, []],
      [`SELECT 1 FROM push_devices WHERE identity_id=ANY($1)`, [[OWNER, AGENT]]],
      [`SELECT 1 FROM github_installations WHERE owner_id=ANY($1)`, [[OWNER, AGENT]]],
      [`SELECT 1 FROM github_user_tokens WHERE subject='owner'`, []],
      [`SELECT 1 FROM memberships WHERE identity_id=ANY($1)`, [[OWNER, AGENT]]],
      [`SELECT 1 FROM agents WHERE agent_id=ANY($1)`, [[OWNER, AGENT]]],
      [`SELECT 1 FROM phone_sessions WHERE identity_id=ANY($1)`, [[OWNER, AGENT]]],
      [`SELECT 1 FROM phone_access_tokens WHERE identity_id=ANY($1)`, [[OWNER, AGENT]]],
      [`SELECT 1 FROM daemon_tokens WHERE agent_id=ANY($1)`, [[OWNER, AGENT]]],
    ] as const) {
      await expectRowCount(sql, values, 0);
    }

    // Media bytes are gone; the tombstone keeps the "expired" story honest.
    await expectRowCount(`SELECT 1 FROM media WHERE owner_id=ANY($1)`, [[OWNER, AGENT]], 0);
    await expectRowCount(
      `SELECT 1 FROM media_expirations WHERE id='88888888-8888-4888-8888-888888888888'`,
      [],
      1,
    );

    // Attribution the account created is lifted off the shared artifacts.
    await expectRowCount(`SELECT 1 FROM rooms WHERE id=$1 AND created_by IS NULL`, [ROOM], 1);

    // Sole surviving owner succession: the partner now owns the Workspace.
    await expectRowCount(
      `SELECT 1 FROM memberships WHERE workspace_id=$1 AND room_id IS NULL AND identity_id=$2 AND role='owner'`,
      [WORKSPACE, PARTNER],
      1,
    );

    // Every token the account held is dead: the access token authenticates to
    // nothing and the refresh family is gone.
    expect(await auth.authenticatePhone(ownerToken)).toBeNull();
  });

  it('is idempotent: a second call resolves without effect', async () => {
    await phone.execute('deleteAccount', {}, OWNER);
    await expect(phone.execute('deleteAccount', {}, OWNER)).resolves.toBeUndefined();
    await expectRowCount(`SELECT 1 FROM identities WHERE id=$1`, [OWNER], 0);
  });

  it('lets the same GitHub subject sign in fresh afterwards', async () => {
    await phone.execute('deleteAccount', {}, OWNER);
    const fresh = await auth.exchangeGitHubOidc('proof');
    expect(fresh.accessToken).toBeTruthy();
    expect(await auth.authenticatePhone(fresh.accessToken)).toBe(OWNER);
    // A NEW account: no agent, no durable messages (only the join note the
    // welcome landing writes on its behalf).
    await expectRowCount(`SELECT 1 FROM agents WHERE agent_id=$1`, [OWNER], 0);
    await expectRowCount(
      `SELECT 1 FROM messages WHERE author_id=$1 AND presentation='message'`,
      [OWNER],
      0,
    );
  });

  it('refuses the review identity and leaves it standing', async () => {
    await auth.exchangeReviewIdentity();
    await expect(phone.execute('deleteAccount', {}, REVIEW_IDENTITY_ID)).rejects.toThrow(
      /review identity/,
    );
    await expectRowCount(`SELECT 1 FROM identities WHERE id=$1`, [REVIEW_IDENTITY_ID], 1);
  });
});
