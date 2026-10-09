import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { compactPushClaims, compactWebhookDeliveries, migrate } from './database.js';
import { cancelArchivedCornerAssignments } from './corner-close.js';
import { PgliteDatabase } from './test-support.js';

const HUMAN = 'a'.repeat(64);
const AGENT = 'b'.repeat(64);
const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const ROOM = '22222222-2222-4222-8222-222222222222';
const CORNER = '33333333-3333-4333-8333-333333333333';

describe('release data cleanup', () => {
  let db: PgliteDatabase;
  beforeEach(async () => {
    db = new PgliteDatabase();
    await migrate(db);
  });
  afterEach(async () => { await db.close(); });

  it('expires old webhook ids and clears retained JSON in bounded migration batches', async () => {
    await db.query(`INSERT INTO github_webhook_deliveries
      (delivery_id,event_type,payload,received_at,processed_at) VALUES
      ('old','push','{"large":"old"}',now()-interval '31 days',now()),
      ('recent','push','{"large":"recent"}',now()-interval '1 day',now())`);
    await compactWebhookDeliveries(db);
    expect((await db.query(`SELECT delivery_id,payload,event_type,processed_at
      FROM github_webhook_deliveries ORDER BY delivery_id`)).rows).toEqual([
      { delivery_id: 'recent', payload: null, event_type: null, processed_at: null },
    ]);
    await compactWebhookDeliveries(db);
    expect((await db.query(`SELECT count(*)::integer total FROM github_webhook_deliveries`)).rows[0])
      .toEqual({ total: 1 });
  });

  it('terminally cancels every stale command and working turn in an archived corner', async () => {
    await db.query(`INSERT INTO identities(id,kind,name) VALUES
      ($1,'human','Human'),($2,'agent','Agent')`, [HUMAN, AGENT]);
    await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Space')`, [WORKSPACE]);
    await db.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Room')`, [ROOM, WORKSPACE]);
    await db.query(`INSERT INTO rooms(id,workspace_id,parent_id,name,archived_at)
      VALUES($1,$2,$3,'Closed',now())`, [CORNER, WORKSPACE, ROOM]);
    await db.query(`INSERT INTO messages(id,room_id,author_id,text)
      VALUES('source',$1,$2,'work')`, [CORNER, HUMAN]);
    for (const action of ['input', 'resume', 'restart', 'stop'])
      await db.query(`INSERT INTO agent_commands
        (id,room_id,agent_id,source_message_id,turn_request_id,action,reason,
          root_command_id,root_source_message_id,agent_depth)
        VALUES($1,$2,$3,'source','turn',$4,'test',$1,'source',0)`,
        [`command-${action}`, CORNER, AGENT, action]);
    await db.query(`INSERT INTO agent_turns(room_id,request_id,agent_id,status)
      VALUES($1,'turn',$2,'working')`, [CORNER, AGENT]);
    await cancelArchivedCornerAssignments(db);
    expect((await db.query(`SELECT DISTINCT state FROM agent_commands
      WHERE room_id=$1`, [CORNER])).rows).toEqual([{ state: 'cancelled' }]);
    expect((await db.query(`SELECT status FROM agent_turns WHERE room_id=$1`, [CORNER])).rows)
      .toEqual([{ status: 'cancelled' }]);
  });

  it('expires terminal claims outside the candidate window but preserves release catchups', async () => {
    await db.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Human')`, [HUMAN]);
    await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Space')`, [WORKSPACE]);
    await db.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Room')`, [ROOM, WORKSPACE]);
    await db.query(`INSERT INTO messages(id,room_id,author_id,text)
      VALUES('catchup',$1,$2,'Release')`, [ROOM, HUMAN]);
    await db.query(`INSERT INTO push_devices(token,identity_id,platform,environment)
      VALUES('device',$1,'ios','physical')`, [HUMAN]);
    await db.query(`INSERT INTO push_release_catchups(device_token,identity_id,message_id)
      VALUES('device',$1,'catchup')`, [HUMAN]);
    await db.query(`INSERT INTO push_delivery_claims
      (message_id,device_token,status,completed_at) VALUES
      ('old','device','delivered',now()-interval '2 hours'),
      ('fresh','device','delivered',now()),
      ('catchup','device','failed',now()-interval '2 hours')`);
    await compactPushClaims(db);
    expect((await db.query(`SELECT message_id FROM push_delivery_claims
      ORDER BY message_id`)).rows).toEqual([
      { message_id: 'catchup' }, { message_id: 'fresh' },
    ]);
  });
});
