import { pruneArchivedToolActivity, runMaintenance } from './background.js';
import { EXPIRE_PUSH_CLAIMS_SQL, TERMINAL_PUSH_CLAIMS_SQL } from './push-claim-cleanup.js';
import { BackgroundWork } from './background-work.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { compactPushClaims, compactWebhookDeliveries } from './database.js';
import {
  cancelArchivedCornerAssignments,
  cancelCornerAgentCommands,
  cancelStaleClosedCornerStops,
} from './corner-close.js';
import { CornerAccessDatabase } from './corner-access-database.js';
import { PgliteDatabase, migratedDatabase } from './test-support.js';
import { PendingAttachmentCleanupLoop, sweepPendingAttachments } from './pending-attachment-cleanup.js';

const HUMAN = 'a'.repeat(64);
const AGENT = 'b'.repeat(64);
const OTHER_AGENT = 'c'.repeat(64);
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
    expect(await loop.runOnce()).toBe(1000);
    expect(await loop.nextDelayMs()).toBe(0);
    expect(await loop.runOnce()).toBe(1);
    expect(await loop.nextDelayMs()).toBeGreaterThan(23 * 3600_000);
    expect(await sweepPendingAttachments(db)).toBe(0);
  });

  it('B2: retains 200 newest archived tools and all live, prose and durable rows', async () => {
    await db.query(`INSERT INTO identities(id,kind,name) VALUES($1,'agent','Agent')`, [AGENT]);
    await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Space')`, [WORKSPACE]);
    await db.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Room')`, [ROOM, WORKSPACE]);
    await db.query(`INSERT INTO rooms(id,workspace_id,parent_id,name,archived_at) VALUES($1,$2,$3,'Closed',now())`, [CORNER, WORKSPACE, ROOM]);
    await db.query(`INSERT INTO messages(id,room_id,author_id,text,presentation,activity,created_at)
      SELECT 'tool-'||lpad(n::text,4,'0'),$1,$2,'','activity','[{"kind":"tool","title":"read"}]',now()
      FROM generate_series(1,205) n`, [CORNER, AGENT]);
    await db.query(`INSERT INTO messages(id,room_id,author_id,text,presentation,activity) VALUES
      ('prose',$1,$3,'Keep prose','activity','[]'),('live-tool',$2,$3,'','activity','[{"kind":"tool"}]')`, [CORNER, ROOM, AGENT]);
    await db.query(`INSERT INTO messages(id,room_id,author_id,text,presentation,activity,durable_fact)
      VALUES('durable-tool',$1,$2,'','activity','[{"kind":"tool"}]','failure')`, [CORNER, AGENT]);
    await pruneArchivedToolActivity(db);
    expect((await db.query(`SELECT count(*)::int count,min(id) first FROM messages WHERE id LIKE 'tool-%'`)).rows[0])
      .toEqual({ count: 200, first: 'tool-0006' });
    expect((await db.query(`SELECT id FROM messages WHERE id IN ('prose','live-tool','durable-tool') ORDER BY id`)).rows).toHaveLength(3);
  });
  it('B4: expired crashed claims become uncertain, retries fail, active windows survive and joins expire', async () => {
    await db.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Human')`, [HUMAN]);
    await db.query(`INSERT INTO push_devices(token,identity_id,platform,environment) VALUES('cleanup-device',$1,'ios','physical')`, [HUMAN]);
    await db.query(`INSERT INTO push_delivery_claims(message_id,device_token,status,claimed_at) VALUES
      ('crashed','cleanup-device','claimed',now()-interval '2 hours'),
      ('retry','cleanup-device','retryable',now()-interval '2 hours'),
      ('active','cleanup-device','claimed',now()-interval '2 hours')`);
    await db.query(`INSERT INTO push_outbox(message_id,device_token,expires_at) VALUES('active','cleanup-device',now()+interval '1 hour')`);
    await db.query(EXPIRE_PUSH_CLAIMS_SQL, [1000]);
    expect((await db.query(`SELECT message_id,status FROM push_delivery_claims ORDER BY message_id`)).rows).toEqual([
      { message_id: 'active', status: 'claimed' }, { message_id: 'crashed', status: 'uncertain' }, { message_id: 'retry', status: 'failed' }]);
    await db.query(TERMINAL_PUSH_CLAIMS_SQL, [1000]);
    expect((await db.query(`SELECT 1 FROM push_delivery_claims WHERE status='uncertain'`)).rows).toHaveLength(1);
    await db.query(`UPDATE push_delivery_claims SET completed_at=now()-interval '2 hours' WHERE status='uncertain'`);
    await db.query(TERMINAL_PUSH_CLAIMS_SQL, [1000]);
    expect((await db.query(`SELECT 1 FROM push_delivery_claims WHERE status='uncertain'`)).rows).toHaveLength(0);
    await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Space')`, [WORKSPACE]);
    await db.query(`INSERT INTO workspace_join_notifications(id,workspace_id,joining_identity_id,text,created_at) VALUES
      ('old',$1,$2,'join',now()-interval '2 hours'),('fresh',$1,$2,'join',now())`, [WORKSPACE, HUMAN]);
    await db.query(`INSERT INTO workspace_join_notification_devices(notification_id,device_token) VALUES('old','cleanup-device'),('fresh','cleanup-device')`);
    await runMaintenance(db);
    expect((await db.query(`SELECT id FROM workspace_join_notifications ORDER BY id`)).rows).toEqual([{ id: 'fresh' }]);
    expect((await db.query(`SELECT notification_id FROM workspace_join_notification_devices`)).rows).toEqual([{ notification_id: 'fresh' }]);
  });
  it('ATTACHMENT-DEADLINE: empty and active queues park until a real eligibility change', async () => {
    const loop = new PendingAttachmentCleanupLoop(db);
    let clock = 0;
    const work = new BackgroundWork(() => clock, () => {});
    const run = vi.fn(async () => { await loop.runOnce(); return loop.nextDelayMs(); });
    work.addDeadline('attachments', run);
    expect(await work.run(false)).toBe(Infinity);
    clock += 24 * 3600_000;
    expect(await work.run(false)).toBe(Infinity);
    expect(run).toHaveBeenCalledTimes(1);
    await db.query(`INSERT INTO identities(id,kind,name) VALUES($1,'agent','Agent')`, [AGENT]);
    await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Space')`, [WORKSPACE]);
    await db.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Room')`, [ROOM,WORKSPACE]);
    await db.query(`INSERT INTO agent_turns(room_id,request_id,agent_id,status,generation_id)
      VALUES($1,'active',$2,'working','generation')`, [ROOM,AGENT]);
    await db.query(`INSERT INTO agent_pending_attachments(room_id,agent_id,url,name,mime_type,size,request_id,created_at)
      VALUES($1,$2,'/v1/media/test','test','text/plain',1,'active',now()-interval '2 days')`, [ROOM,AGENT]);
    work.wake('attachments');
    expect(await work.run(false)).toBe(Infinity);
    expect(await loop.nextDelayMs()).toBeUndefined();
    await db.query(`UPDATE agent_turns SET status='complete' WHERE room_id=$1`, [ROOM]);
    expect(await loop.nextDelayMs()).toBe(0);
    work.wake('attachments');
    expect(await work.run(false)).toBe(Infinity);
    expect((await db.query('SELECT count(*)::int count FROM agent_pending_attachments')).rows).toEqual([{ count: 0 }]);
    clock += 24 * 3600_000;
    await work.run(false);
    expect(run).toHaveBeenCalledTimes(3);
  });

  it('expires old webhook ids in bounded migration batches', async () => {
    await db.query(`INSERT INTO github_webhook_deliveries(delivery_id,received_at) VALUES
      ('old',now()-interval '31 days'),('recent',now()-interval '1 day')`);
    await compactWebhookDeliveries(db);
    expect((await db.query(`SELECT delivery_id FROM github_webhook_deliveries ORDER BY delivery_id`)).rows)
      .toEqual([{ delivery_id: 'recent' }]);
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

  it('stops only the claimed turn when a corner closes, never a command that did not start', async () => {
    await db.query(`INSERT INTO identities(id,kind,name) VALUES
      ($1,'human','Human'),($2,'agent','Agent'),($3,'agent','Other')`, [HUMAN, AGENT, OTHER_AGENT]);
    await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Space')`, [WORKSPACE]);
    await db.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Room')`, [ROOM, WORKSPACE]);
    await db.query(`INSERT INTO rooms(id,workspace_id,parent_id,name) VALUES($1,$2,$3,'Open')`,
      [CORNER, WORKSPACE, ROOM]);
    await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES
      ($1,$2,$3,'member'),($1,$2,$4,'member')`, [WORKSPACE, ROOM, AGENT, OTHER_AGENT]);
    await db.query(`INSERT INTO messages(id,room_id,author_id,text)
      VALUES('source',$1,$2,'work')`, [CORNER, HUMAN]);
    await db.query(`INSERT INTO agent_commands
      (id,room_id,agent_id,source_message_id,turn_request_id,action,reason,
        root_command_id,root_source_message_id,agent_depth,state,generation_id,claimed_at,lease_expires_at)
      VALUES('queued',$1,$2,'source','queued-turn','input','test','queued','source',0,'pending',NULL,NULL,NULL),
        ('running',$1,$3,'source','running-turn','input','test','running','source',0,'claimed','g1',now(),
          now()+interval '5 minutes')`, [CORNER, AGENT, OTHER_AGENT]);
    await cancelCornerAgentCommands(new CornerAccessDatabase(db), CORNER);
    expect((await db.query(`SELECT agent_id,turn_request_id,state FROM agent_commands
      WHERE room_id=$1 AND action='stop'`, [CORNER])).rows).toEqual([
      { agent_id: OTHER_AGENT, turn_request_id: 'running-turn', state: 'pending' },
    ]);
    expect((await db.query(`SELECT id,state FROM agent_commands
      WHERE room_id=$1 AND action='input' ORDER BY id`, [CORNER])).rows).toEqual([
      { id: 'queued', state: 'cancelled' },
      { id: 'running', state: 'cancelled' },
    ]);
  });

  it('settles day-old stops left pending in archived corners and keeps recent ones deliverable', async () => {
    await db.query(`INSERT INTO identities(id,kind,name) VALUES
      ($1,'human','Human'),($2,'agent','Agent')`, [HUMAN, AGENT]);
    await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Space')`, [WORKSPACE]);
    await db.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Room')`, [ROOM, WORKSPACE]);
    await db.query(`INSERT INTO rooms(id,workspace_id,parent_id,name,archived_at)
      VALUES($1,$2,$3,'Closed',now())`, [CORNER, WORKSPACE, ROOM]);
    await db.query(`INSERT INTO messages(id,room_id,author_id,text)
      VALUES('source',$1,$2,'work'),('later',$1,$2,'more')`, [CORNER, HUMAN]);
    await db.query(`INSERT INTO agent_commands
      (id,room_id,agent_id,source_message_id,turn_request_id,action,reason,
        root_command_id,root_source_message_id,agent_depth,created_at)
      VALUES('old-stop',$1,$2,'source','old','stop','corner_close','old-stop','source',0,now()-interval '2 days'),
        ('new-stop',$1,$2,'later','new','stop','corner_close','new-stop','later',0,now())`, [CORNER, AGENT]);
    await expect(cancelStaleClosedCornerStops(db)).resolves.toBe(1);
    expect((await db.query(`SELECT id,state FROM agent_commands WHERE room_id=$1 ORDER BY id`, [CORNER])).rows)
      .toEqual([{ id: 'new-stop', state: 'pending' }, { id: 'old-stop', state: 'cancelled' }]);
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
