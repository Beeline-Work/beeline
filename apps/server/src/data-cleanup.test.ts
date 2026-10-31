import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { compactPushClaims, compactWebhookDeliveries } from './database.js';
import { cancelArchivedCornerAssignments } from './corner-close.js';
import { PgliteDatabase, migratedDatabase } from './test-support.js';
import { PendingAttachmentCleanupLoop, sweepPendingAttachments } from './pending-attachment-cleanup.js';

const HUMAN = 'a'.repeat(64);
const AGENT = 'b'.repeat(64);
const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const ROOM = '22222222-2222-4222-8222-222222222222';
const CORNER = '33333333-3333-4333-8333-333333333333';

describe('release data cleanup', () => {
  let db: PgliteDatabase;
  beforeEach(async () => {
    db = await migratedDatabase();
  });
  afterEach(async () => { await db.close(); });

  it('CLEANUP-ATTACH-1: sweeps abandoned rows in bounded batches while preserving live requests', async () => {
    await db.query(`INSERT INTO identities(id,kind,name) VALUES($1,'agent','Agent')`, [AGENT]);
    await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Space')`, [WORKSPACE]);
    await db.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Room')`, [ROOM, WORKSPACE]);
    await db.query(`INSERT INTO rooms(id,workspace_id,parent_id,name,archived_at)
      VALUES($1,$2,$3,'Closed',now())`, [CORNER, WORKSPACE, ROOM]);
    const queue = async (request: string, room = ROOM, old = true) => db.query(
      `INSERT INTO agent_pending_attachments(room_id,agent_id,url,name,mime_type,size,request_id,generation_id,created_at)
       VALUES($1,$2,'/v1/media/example',$3,'text/plain',5,$3,'old-generation',
         CASE WHEN $4 THEN now()-interval '2 days' ELSE now() END)`, [room, AGENT, request, old]);
    for (const request of ['missing', 'complete', 'failed', 'cancelled', 'live', 'fresh']) await queue(request, ROOM, request !== 'fresh');
    for (const status of ['complete', 'failed', 'cancelled', 'working']) await db.query(
      `INSERT INTO agent_turns(room_id,request_id,agent_id,status,generation_id) VALUES($1,$2,$3,$4,'new-generation')`,
      [ROOM, status === 'working' ? 'live' : status, AGENT, status]);
    await db.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES('attachment-source',$1,$2,'work')`, [ROOM, AGENT]);
    await db.query(`INSERT INTO agent_commands
      (id,room_id,agent_id,source_message_id,turn_request_id,action,reason,root_command_id,root_source_message_id,agent_depth)
      VALUES('queued-command',$1,$2,'attachment-source','queued','input','test','queued-command','attachment-source',0)`, [ROOM, AGENT]);
    await queue('queued');
    await db.query(`DELETE FROM agent_turns WHERE request_id='queued'`);
    await queue('archived', CORNER, false);
    expect(await sweepPendingAttachments(db)).toBe(5);
    expect((await db.query(`SELECT name FROM agent_pending_attachments ORDER BY name`)).rows)
      .toEqual([{ name: 'fresh' }, { name: 'live' }, { name: 'queued' }]);
    await db.query(`INSERT INTO agent_pending_attachments(room_id,agent_id,url,name,mime_type,size,created_at)
      SELECT $1,$2,'/v1/media/example','abandoned','text/plain',5,now()-interval '2 days' FROM generate_series(1,1001)`, [ROOM, AGENT]);
    const loop = new PendingAttachmentCleanupLoop(db);
    expect(await loop.runOnce(0)).toBe(1000);
    expect(await loop.runOnce(1)).toBe(0);
    expect(await loop.runOnce(3600000)).toBe(1);
    expect(await sweepPendingAttachments(db)).toBe(0);
  });

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
    // Replace dispatch's optimistic row with the stale helper generation.
    await db.query(`INSERT INTO agent_turns(room_id,request_id,agent_id,status,generation_id)
      VALUES($1,'turn',$2,'working','stale-helper-generation')
      ON CONFLICT(room_id,request_id,agent_id) DO UPDATE
        SET status=EXCLUDED.status,generation_id=EXCLUDED.generation_id`, [CORNER, AGENT]);
    await cancelArchivedCornerAssignments(db);
    expect((await db.query(`SELECT DISTINCT state FROM agent_commands
      WHERE room_id=$1`, [CORNER])).rows).toEqual([{ state: 'cancelled' }]);
    expect((await db.query(`SELECT status FROM agent_turns WHERE room_id=$1`, [CORNER])).rows)
      .toEqual([{ status: 'cancelled' }]);
  });

  it('expires terminal claims while retaining mobile read-clear claims for a week', async () => {
    await db.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Human')`, [HUMAN]);
    await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Space')`, [WORKSPACE]);
    await db.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Room')`, [ROOM, WORKSPACE]);
    await db.query(`INSERT INTO push_devices(token,identity_id,platform,environment)
      VALUES('device',$1,'ios','physical')`, [HUMAN]);
    // An iOS delivered claim no read-clear push has named stays (sendReadClears)
    // for a week, so a Room never read cannot grow claims forever.
    await db.query(`INSERT INTO push_delivery_claims
      (message_id,device_token,status,completed_at,read_cleared_at) VALUES
      ('old','device','delivered',now()-interval '2 hours',now()-interval '2 hours'),
      ('unnamed','device','delivered',now()-interval '2 hours',NULL),
      ('stale','device','delivered',now()-interval '8 days',NULL),
      ('fresh','device','delivered',now(),NULL),
      ('failed','device','failed',now()-interval '2 hours',NULL)`);
    await compactPushClaims(db);
    expect((await db.query(`SELECT message_id FROM push_delivery_claims
      ORDER BY message_id`)).rows).toEqual([
      { message_id: 'fresh' }, { message_id: 'unnamed' },
    ]);
  });
});
