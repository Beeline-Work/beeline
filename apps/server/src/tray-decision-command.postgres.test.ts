import { randomUUID } from 'node:crypto';
import { CHOICE_CARD_TYPE } from '@beeline/api-contract/phone';
import { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { PostgresDatabase, type SqlDatabase } from './database.js';
import { DURABLE_LIVE_SCHEMA } from './durable-live.js';
import { LiveHub } from './live.js';
import { PhoneService } from './phone-service.js';
import { skipRoomChoice } from './room-choice.js';
import { ROUTER_COMMAND_SCHEMA, RouterCommandLedger } from './router-command-ledger.js';
import { ROUTER_PROJECTION_SCHEMA } from './router-projection-schema.js';
import { dispatchTrayDecisionCommand } from './tray-decision-command.js';
import { TRAY_MUTABLE_SOURCE_SCHEMA } from './tray-mutable-source.js';
import { workflowRunLockKey } from './workflow-runs.js';

const url = process.env.BEELINE_COMMAND_TEST_POSTGRES_URL;
if (url && !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname))
  throw new Error('Tray decision proofs require isolated loopback PostgreSQL');
const A = 'a'.repeat(64), B = 'b'.repeat(64), AGENT = 'c'.repeat(64), RUN = 'd'.repeat(64);
const W = '11111111-1111-4111-8111-111111111111', ROOM = '22222222-2222-4222-8222-222222222222';
const CORNER = '33333333-3333-4333-8333-333333333333', CHOICE = '44444444-4444-4444-8444-444444444444';
const GRANT = '55555555-5555-4555-8555-555555555555';
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };

/** Only a schema created by this test is dropped. Real pools establish the
 * legacy run/source→authority order; the selected adapter must never wait
 * in the reverse order. Actual legacy skip/card DML completes afterward. */
async function rig(work: (reader: SqlDatabase, writer: SqlDatabase) => Promise<void>) {
  const schema = `tray_decision_${randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString: url, max: 1 });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const config = { connectionString: url, options: `-c search_path=${schema},public`, max: 2 };
  const reader = new PostgresDatabase('', 2, { pool: new Pool(config) });
  const writer = new PostgresDatabase('', 2, { pool: new Pool(config) });
  try {
    await reader.query(`CREATE TABLE workspaces(id uuid PRIMARY KEY);
      CREATE TABLE identities(id text PRIMARY KEY,kind text,name text,handle text,avatar text,face_id text,hidden_from_roster boolean);
      CREATE TABLE rooms(id uuid PRIMARY KEY,workspace_id uuid,parent_id uuid,archived_at timestamptz);
      CREATE TABLE memberships(id bigserial PRIMARY KEY,workspace_id uuid,room_id uuid,identity_id text,role text,removed_at timestamptz);
      CREATE VIEW room_access AS SELECT member.* FROM memberships member
        WHERE member.room_id IS NULL OR EXISTS(SELECT 1 FROM rooms surface WHERE surface.id=member.room_id AND surface.parent_id IS NULL)
        UNION ALL SELECT parent.id,corner.workspace_id,corner.id,parent.identity_id,parent.role,parent.removed_at
        FROM rooms corner JOIN memberships parent ON parent.room_id=corner.parent_id
        WHERE corner.parent_id IS NOT NULL AND corner.archived_at IS NULL;
      CREATE TABLE agents(agent_id text PRIMARY KEY,owner_id text);
      CREATE TABLE workspace_apps(id uuid PRIMARY KEY,workspace_id uuid,owner_identity_id text);
      CREATE TABLE agent_grants(id uuid PRIMARY KEY,agent_id text,workspace_id uuid,room_id uuid,kind text,target text,app_id uuid,status text,superseded_at timestamptz);
      CREATE TABLE permission_authority(permission_id text PRIMARY KEY,room_id uuid,principal_id text,status text);
      CREATE TABLE messages(id text PRIMARY KEY,room_id uuid,author_id text,card_type text,card jsonb,deleted_at timestamptz,created_at timestamptz DEFAULT now());
      CREATE TABLE room_choices(id uuid PRIMARY KEY,workspace_id uuid,room_id uuid,agent_id text,message_id text,mode text,prompt text,
        constraint_text text,options jsonb,electorate text[],status text,closes_at timestamptz,workflow_run_id text);
      CREATE TABLE connector_offers(id uuid PRIMARY KEY,workspace_id uuid,room_id uuid,message_id text,addressee_id text,connector_type text,status text);
      CREATE TABLE message_bookmarks(identity_id text,workspace_id uuid,room_id uuid,message_id text);
      CREATE TABLE needs_you_marks(identity_id text,workspace_id uuid,message_id text);`);
    await reader.query(DURABLE_LIVE_SCHEMA);
    await reader.query(ROUTER_PROJECTION_SCHEMA);
    await reader.query(ROUTER_COMMAND_SCHEMA);
    await reader.query(`INSERT INTO workspaces VALUES($1)`, [W]);
    await reader.query(`INSERT INTO rooms(id,workspace_id,parent_id) VALUES($1,$3,NULL),($2,$3,$1)`, [ROOM, CORNER, W]);
    await reader.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Owner'),($2,'human','Other'),($3,'agent','Agent')`, [A, B, AGENT]);
    await reader.query(`INSERT INTO agents VALUES($1,$2)`, [AGENT, A]);
    await reader.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,NULL,$3,'owner'),($1,$2,$3,'member')`, [W, ROOM, A]);
    await reader.query(`INSERT INTO messages(id,room_id,author_id,card_type,card) VALUES('choice-card',$1,$2,$3,$4::jsonb)`, [CORNER, AGENT, CHOICE_CARD_TYPE,
      JSON.stringify({ runId: RUN, attempt: 0, requester: { pubkey: A } })]);
    await reader.query(`INSERT INTO room_choices(id,workspace_id,room_id,agent_id,message_id,mode,prompt,options,electorate,status,closes_at,workflow_run_id)
      VALUES($1,$2,$3,$4,'choice-card','question','Synthetic?',$5::jsonb,$6::text[],'open',clock_timestamp()+interval '10 minutes',$7)`,
    [CHOICE, W, CORNER, AGENT, JSON.stringify([{ optionId: 'A', letter: 'A', label: 'Stop', consequence: 'Stop' }]), [A], RUN]);
    // This is the real capture/fence trigger, not a hand-written notification.
    await reader.query(TRAY_MUTABLE_SOURCE_SCHEMA);
    await work(reader, writer);
  } finally {
    await Promise.all([reader.close(), writer.close()]);
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
}
function selected(reader: SqlDatabase, live: LiveHub) {
  const phone = new PhoneService(reader, 'https://synthetic.invalid', undefined, undefined, live);
  return (id: string) => dispatchTrayDecisionCommand(new RouterCommandLedger(reader), phone, live,
    'skipChoice', { choiceId: CHOICE }, A, { v: 1, id });
}
async function unchanged(reader: SqlDatabase, publish: unknown) {
  expect((await reader.query('SELECT status FROM room_choices WHERE id=$1', [CHOICE])).rows).toEqual([{ status: 'open' }]);
  expect((await reader.query('SELECT * FROM router_commands')).rows).toEqual([]);
  expect((await reader.query(`SELECT * FROM live_journal WHERE event->>'sourceTable'='tray-projection'`)).rows).toEqual([]);
  expect(publish).not.toHaveBeenCalled();
}

describe.skipIf(!url)('real PostgreSQL selected Tray decision contention', () => {
  it('refuses a legacy-held workflow lock before effects, then the legacy holder commits its actual skip/card change', async () => {
    await rig(async (reader, writer) => {
      const live = new LiveHub(), publish = vi.spyOn(live, 'publish'), held = deferred(), release = deferred();
      const legacy = writer.transaction(async tx => {
        await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [workflowRunLockKey(RUN)]);
        held.resolve(); await release.promise;
        // The source trigger requests this existing authority fence after the
        // legacy run lock. The selected adapter must already have refused.
        await skipRoomChoice(tx, { choiceId: CHOICE, viewerId: A }, { wake: false });
      });
      try {
        await held.promise;
        await expect(selected(reader, live)('busy-run')).rejects.toMatchObject({ status: 409, message: expect.stringContaining('busy') });
        await unchanged(reader, publish);
        release.resolve(); await legacy;
        expect((await reader.query('SELECT status FROM room_choices WHERE id=$1', [CHOICE])).rows).toEqual([{ status: 'skipped' }]);
        expect((await reader.query(`SELECT card->>'status' status FROM messages WHERE id='choice-card'`)).rows).toEqual([{ status: 'skipped' }]);
        expect((await reader.query(`SELECT count(*)::int count FROM live_journal WHERE event->>'sourceTable'='tray-projection'`)).rows[0]?.count).toBeGreaterThan(0);
      } finally { release.resolve(); await legacy; }
    });
  });

  it('refuses NOWAIT source-row contention instead of deadlocking with a legacy source→authority writer', async () => {
    await rig(async (reader, writer) => {
      await reader.query(`UPDATE messages SET card=card-'runId' WHERE id='choice-card'`);
      await reader.query('UPDATE room_choices SET workflow_run_id=NULL WHERE id=$1', [CHOICE]);
      await reader.query(`DELETE FROM live_journal WHERE event->>'sourceTable'='tray-projection'`);
      const live = new LiveHub(), publish = vi.spyOn(live, 'publish'), held = deferred(), release = deferred();
      const legacy = writer.transaction(async tx => {
        await tx.query('SELECT id FROM room_choices WHERE id=$1 FOR UPDATE', [CHOICE]);
        held.resolve(); await release.promise;
        await skipRoomChoice(tx, { choiceId: CHOICE, viewerId: A }, { wake: false });
      });
      try {
        await held.promise;
        await expect(selected(reader, live)('busy-choice')).rejects.toMatchObject({ status: 409, message: expect.stringContaining('busy') });
        await unchanged(reader, publish);
        release.resolve(); await legacy;
        expect((await reader.query('SELECT status FROM room_choices WHERE id=$1', [CHOICE])).rows).toEqual([{ status: 'skipped' }]);
      } finally { release.resolve(); await legacy; }
    });
  });

  it('observes committed parent-Room revocation and refuses without a decision or compatibility notification', async () => {
    await rig(async (reader, writer) => {
      await reader.query(`UPDATE messages SET card=card-'runId' WHERE id='choice-card'`);
      await reader.query('UPDATE room_choices SET workflow_run_id=NULL WHERE id=$1', [CHOICE]);
      await reader.query(`DELETE FROM live_journal WHERE event->>'sourceTable'='tray-projection'`);
      await writer.query('UPDATE memberships SET removed_at=clock_timestamp() WHERE identity_id=$1 AND room_id=$2', [A, ROOM]);
      const live = new LiveHub(), publish = vi.spyOn(live, 'publish');
      await expect(selected(reader, live)('revoked')).rejects.toThrow('room access denied');
      await unchanged(reader, publish);
    });
  });

  it('uses the current resource owner and refuses an old owner after another pool commits transfer', async () => {
    await rig(async (reader, writer) => {
      await reader.query(`INSERT INTO agent_grants(id,agent_id,workspace_id,room_id,kind,target,status)
        VALUES($1,$2,$3,$4,'path','/synthetic','pending')`, [GRANT, AGENT, W, CORNER]);
      await writer.query('UPDATE agents SET owner_id=$2 WHERE agent_id=$1', [AGENT, B]);
      const live = new LiveHub(), publish = vi.spyOn(live, 'publish'), phone = new PhoneService(reader, 'https://synthetic.invalid', undefined, undefined, live);
      await expect(dispatchTrayDecisionCommand(new RouterCommandLedger(reader), phone, live, 'decideAgentGrant',
        { grantId: GRANT, decision: 'always' }, A, { v: 1, id: 'former-owner' })).rejects.toThrow('owner');
      expect((await reader.query('SELECT status FROM agent_grants WHERE id=$1', [GRANT])).rows).toEqual([{ status: 'pending' }]);
      expect((await reader.query('SELECT * FROM router_commands')).rows).toEqual([]);
      expect(publish).not.toHaveBeenCalled();
    });
  });
});
