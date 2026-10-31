import { readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { migrate, PostgresDatabase, postgresPoolConfig, type SqlDatabase } from './database.js';
import { PushDeliveryLoop } from './background.js';
import { backfillPushOutbox } from './push-outbox.js';
import { PgliteDatabase } from './test-support.js';
import * as sentry from './sentry.js';

const person = 'a'.repeat(64), author = 'b'.repeat(64);
const workspace = '11111111-1111-4111-8111-111111111111';
const room = '22222222-2222-4222-8222-222222222222';
async function setup(db: SqlDatabase) {
  await migrate(db);
  await db.query(`INSERT INTO identities(id,kind,name,handle,push_level)
    VALUES($1,'human','Owner','owner','full'),($2,'human','Peer','peer','full')`, [person, author]);
  await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Proof')`, [workspace]);
  await db.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Proof')`, [room, workspace]);
  await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
    VALUES($1,$2,$3,'owner'),($1,$2,$4,'member')`, [workspace, room, person, author]);
  await db.query(`INSERT INTO push_devices(token,identity_id,platform,environment,registered_at)
    VALUES('proof-device',$1,'android','physical',now()-interval '1 day')`, [person]);
  await db.query(`INSERT INTO push_delivery_floors(id,started_at)
    VALUES('message-delivery',now()-interval '1 day')`);
}
async function post(db: SqlDatabase, id: string) {
  await db.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'@owner hello')`, [id, room, author]);
}

it('rolls back fanout with the message, backfills cutover once, and honors old claims', async () => {
  const db = new PgliteDatabase();
  try {
    await setup(db);
    await expect(db.transaction(async tx => {
      await post(tx, 'rolled-back');
      throw new Error('rollback');
    })).rejects.toThrow('rollback');
    expect((await db.query(`SELECT * FROM push_outbox`)).rows).toHaveLength(0);
    await post(db, 'old-delivered');
    await post(db, 'old-pending');
    await post(db, 'old-retry');
    await post(db, 'old-failed');
    await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
      VALUES($1,NULL,$2,'owner')`, [workspace, person]);
    await db.query(`INSERT INTO workspace_join_notifications(id,workspace_id,room_id,joining_identity_id,text)
      VALUES('join-pending',$1,$2,$3,'Peer joined'),('join-delivered',$1,$2,$3,'Peer joined')`,
      [workspace, room, author]);
    await db.query(`INSERT INTO workspace_join_notification_devices(notification_id,device_token)
      VALUES('join-pending','proof-device'),('join-delivered','proof-device')`);
    await db.query(`DELETE FROM push_outbox`);
    await db.query(`INSERT INTO push_delivery_claims(message_id,device_token,status)
      VALUES('old-delivered','proof-device','delivered'),('join-delivered','proof-device','delivered'),
        ('old-failed','proof-device','failed')`);
    await db.query(`INSERT INTO push_delivery_claims(message_id,device_token,status,attempts,next_retry_at)
      VALUES('old-retry','proof-device','retryable',2,now()+interval '1 minute')`);
    await backfillPushOutbox(db);
    await backfillPushOutbox(db);
    expect((await db.query(`SELECT * FROM push_outbox`)).rows).toHaveLength(6);
    const send = vi.fn().mockResolvedValue(undefined);
    expect(await new PushDeliveryLoop(db, { send }).runOnce()).toBe(2);
    expect(send.mock.calls.map(([, message]) => message.messageId).sort()).toEqual(['join-pending','old-pending']);
    expect(await new PushDeliveryLoop(db, { send }).runOnce()).toBe(0);
    await db.query(`UPDATE push_delivery_claims SET next_retry_at=now()-interval '1 second'
      WHERE message_id='old-retry'`);
    expect(await new PushDeliveryLoop(db, { send }).runOnce()).toBe(1);
    expect((await db.query(`SELECT status,attempts FROM push_delivery_claims WHERE message_id='old-retry'`)).rows)
      .toEqual([{ status: 'delivered', attempts: 3 }]);
  } finally { await db.close(); }
});

it('recovers a leased entry after restart and a claim abandoned before provider send', async () => {
  const db = new PgliteDatabase();
  try {
    await setup(db);
    await post(db, 'abandoned');
    await db.query(`INSERT INTO push_delivery_claims(message_id,device_token,status,claimed_at)
      VALUES('abandoned','proof-device','claimed',now()-interval '2 minutes')`);
    const send = vi.fn().mockResolvedValue(undefined);
    expect(await new PushDeliveryLoop(db, { send }).runOnce()).toBe(1);
    expect(await new PushDeliveryLoop(db, { send }).runOnce()).toBe(0);
    expect(send).toHaveBeenCalledOnce();
  } finally { await db.close(); }
});

const postgresUrl = process.env.BEELINE_PUSH_TEST_POSTGRES_URL;
if (postgresUrl && !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(postgresUrl).hostname))
  throw new Error('push proofs require isolated loopback PostgreSQL');

describe.skipIf(!postgresUrl)('R-PUSH-SCAN-LOCK', () => {
  it('delivers under load while messages ACCESS EXCLUSIVE is acquired without migration retries', async () => {
    const schema = `push_proof_${randomUUID().replaceAll('-', '')}`;
    const admin = new Pool({ connectionString: postgresUrl, max: 1 });
    await admin.query(`CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public`);
    await admin.query(`CREATE SCHEMA ${schema}`);
    const config = postgresPoolConfig(postgresUrl!, 2, 'long-running');
    config.options = `${config.options} -c search_path=${schema},public`;
    const jobs = new PostgresDatabase('', 2, { mode: 'long-running', pool: new Pool(config) });
    const owner = new PostgresDatabase('', 1, { mode: 'migration', pool: new Pool({
      connectionString: postgresUrl, max: 1, options: `-c search_path=${schema},public -c lock_timeout=1000ms`,
    }) });
    let running: Promise<number> | undefined;
    let releaseSend: (() => void) | undefined;
    try {
      await setup(owner);
      expect((await jobs.query(`SHOW statement_timeout`)).rows[0]!.statement_timeout).toBe('2s');
      expect((await jobs.query(`SHOW lock_timeout`)).rows[0]!.lock_timeout).toBe('500ms');
      // This history predates both outbox and replay cutover. Seed it without
      // fanout; fresh messages below still exercise both transactional triggers.
      await owner.query(`ALTER TABLE messages DISABLE TRIGGER message_push_outbox`);
      await owner.query(`ALTER TABLE messages DISABLE TRIGGER beeline_notify_live_messages`);
      await owner.query(`INSERT INTO messages(id,room_id,author_id,text,created_at)
        SELECT 'history-'||n,$1,$2,repeat('@owner historical message ',100),now()-interval '1 day'
        FROM generate_series(1,50000) n`, [room, author]);
      await owner.query(`ALTER TABLE messages ENABLE TRIGGER message_push_outbox`);
      await owner.query(`ALTER TABLE messages ENABLE TRIGGER beeline_notify_live_messages`);
      await owner.query(`INSERT INTO messages(id,room_id,author_id,text)
        SELECT 'fresh-'||n,$1,$2,'@owner fresh' FROM generate_series(1,300) n`, [room, author]);
      // Negative control matches the long-held ACCESS SHARE incident. No retries.
      const legacy = await admin.connect();
      try {
        await legacy.query('BEGIN');
        await legacy.query(`SELECT id FROM ${schema}.messages LIMIT 1`);
        await expect(owner.transaction(async tx => {
          await tx.query(`LOCK TABLE messages IN ACCESS EXCLUSIVE MODE`);
        })).rejects.toMatchObject({ code: '55P03' });
      } finally { await legacy.query('ROLLBACK'); legacy.release(); }
      let startedSend!: () => void;
      const sending = new Promise<void>(resolve => { releaseSend = resolve; });
      const started = new Promise<void>(resolve => { startedSend = resolve; });
      const send = vi.fn(async () => { startedSend(); await sending; });
      const loop = new PushDeliveryLoop(jobs, { send });
      const candidateQueries: {sql: string; values?: unknown[]}[] = [];
      const transaction = jobs.transaction.bind(jobs);
      vi.spyOn(jobs,'transaction').mockImplementation(async work => transaction(async tx => {
        const query = vi.spyOn(tx,'query');
        try { return await work(tx); }
        finally { for (const [sql,values] of query.mock.calls)
          if (sql.includes('FROM unclaimed')) candidateQueries.push({sql,values}); }
      }));
      running = loop.runOnce();
      await Promise.race([started, running.then(() => { throw new Error("no delivery started"); })]);
      const lockDurations: number[] = [];
      for (let n = 0; n < 20; n++) {
        const began = Date.now();
        await owner.transaction(async tx => { await tx.query(`LOCK TABLE messages IN ACCESS EXCLUSIVE MODE`); });
        lockDurations.push(Date.now() - began);
        releaseSend!();
      }
      expect(Math.max(...lockDurations)).toBeLessThan(1000);
      console.info(`R-PUSH-SCAN-LOCK: 300 deliveries; 20 locks; max lock handoff ${Math.max(...lockDurations)}ms`);
      expect(await running).toBe(300);
      expect(send).toHaveBeenCalledTimes(300);
      const candidate = candidateQueries[0]!;
      const explain = await jobs.query(`EXPLAIN (ANALYZE,FORMAT JSON) ${candidate.sql}`, candidate.values);
      const visit = (node: Record<string, unknown>) => {
        if (node['Relation Name'] === 'messages') {
          expect(node['Node Type']).not.toBe('Seq Scan');
          expect(String(node['Index Cond'] ?? node['Recheck Cond'])).toMatch(/\bid\b/);
        }
        for (const child of (node.Plans ?? []) as Record<string, unknown>[]) visit(child);
      };
      visit((explain.rows[0]!['QUERY PLAN'] as { Plan: Record<string, unknown> }[])[0]!.Plan);
    } finally {
      releaseSend?.();
      await running?.catch(() => undefined);
      await jobs.close(); await owner.close();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end();
    }
  }, 120_000);
});

it('R-PUSH-BACKLOG: delivers a DM behind ineligible notes and drops expired rows', async () => {
  const db = new PgliteDatabase();
  try {
    await setup(db);
    await db.query(`UPDATE identities SET push_level='attention' WHERE id=$1`, [person]);
    await db.query(`INSERT INTO messages(id,room_id,author_id,text,presentation,card_type)
      SELECT 'noise-'||n,$1,$2,'GitHub check updated','system','github-corner-note'
      FROM generate_series(1,200) n`, [room, author]);
    // Seed rows left by the previous enqueue policy, even after new writes are filtered.
    await db.query(`INSERT INTO push_outbox(message_id,device_token,expires_at)
      SELECT id,'proof-device',created_at+interval '1 hour' FROM messages WHERE id LIKE 'noise-%'
      ON CONFLICT DO NOTHING`);
    await db.query(`UPDATE push_outbox SET not_before=now()-interval '2 minutes'`);
    await db.query(`INSERT INTO push_outbox(message_id,device_token,not_before,expires_at)
      SELECT 'expired-'||n,'proof-device',now()-interval '3 minutes',now()-interval '1 second'
      FROM generate_series(1,1100) n`);
    const dm = '33333333-3333-4333-8333-333333333333';
    await db.query(`INSERT INTO rooms(id,workspace_id,name,direct_participants)
      VALUES($1,$2,'DM',$3::jsonb)`, [dm, workspace, JSON.stringify([person,author])]);
    await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
      VALUES($1,$2,$3,'member'),($1,$2,$4,'member')`, [workspace,dm,person,author]);
    await db.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES('fresh-dm',$1,$2,'Hello from your DM')`, [dm,author]);
    const send = vi.fn().mockResolvedValue(undefined);
    const signal = vi.spyOn(sentry,'captureServerError').mockImplementation(()=>{});
    const began = performance.now();
    const loop = new PushDeliveryLoop(db, { send });
    expect(await loop.runOnce()).toBe(1);
    expect(await loop.runOnce()).toBe(0);
    expect(signal).toHaveBeenCalledOnce();
    expect(signal).toHaveBeenCalledWith(expect.any(Error),{background_job:'push',signal:'push-outbox-backlog'});
    signal.mockRestore();
    const elapsed = performance.now() - began;
    expect(send).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith('proof-device',expect.objectContaining({ messageId:'fresh-dm',title:'@peer' }));
    expect((await db.query(`SELECT * FROM push_outbox`)).rows).toHaveLength(0);
    expect((await db.query(`SELECT reason,count(*)::int count FROM push_outbox_retirements GROUP BY reason ORDER BY reason`)).rows)
      .toEqual([{reason:'expired',count:1100},{reason:'ineligible',count:200}]);
    // Retirement evidence must not suppress an edit that becomes deliverable.
    await db.query(`UPDATE messages SET text='@owner please read',presentation='message',card_type=NULL WHERE id='noise-1'`);
    expect(await loop.runOnce()).toBe(1);
    expect(send).toHaveBeenLastCalledWith('proof-device',expect.objectContaining({messageId:'noise-1'}));
    console.info(`R-PUSH-BACKLOG: discarded 1300 rows, delivered DM; ${(1301/(elapsed/1000)).toFixed(1)} rows/sec (${elapsed.toFixed(1)} ms), local provider stand-in`);
  } finally { await db.close(); }
});

it('batches suppression with parity for mute, live view, server lease and both read rules', async () => {
  const db = new PgliteDatabase();
  try {
    await setup(db);
    const names = ['muted','view','lease','recent','read','stale'];
    for (const name of names) {
      const id = createHash('sha256').update(name).digest('hex');
      await db.query(`INSERT INTO identities(id,kind,name,handle,push_level) VALUES($1,'human',$2,$2,'full')`,[id,name]);
      await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'member')`,[workspace,room,id]);
      await db.query(`INSERT INTO push_devices(token,identity_id,platform,environment,registered_at)
        VALUES($1,$2,'android','physical',now()-interval '1 day')`,[name,id]);
    }
    await db.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES('batch',$1,$2,'Untargeted full-mode prose')`,[room,author]);
    await db.query(`UPDATE memberships SET push_muted=true WHERE identity_id=$1`,[createHash('sha256').update('muted').digest('hex')]);
    await db.query(`INSERT INTO live_server_instances(instance_id) VALUES('alive')`);
    await db.query(`INSERT INTO room_push_views(room_id,identity_id,session_id,instance_id,expires_at)
      VALUES($1,$2,'view',NULL,now()+interval '1 minute'),
        ($1,$3,'lease','alive',now()-interval '1 minute'),
        ($1,$4,'stale','gone',now()-interval '1 minute')`,
      [room,createHash('sha256').update('view').digest('hex'),createHash('sha256').update('lease').digest('hex'),createHash('sha256').update('stale').digest('hex')]);
    await db.query(`INSERT INTO room_read_marks(room_id,identity_id,message_created_at,message_id,updated_at)
      SELECT $1::uuid,$2::text,now()-interval '1 day','older',now()
      UNION ALL SELECT $1::uuid,$3::text,created_at,id,now()-interval '1 minute' FROM messages WHERE id='batch'`,
      [room,createHash('sha256').update('recent').digest('hex'),createHash('sha256').update('read').digest('hex')]);
    const sqls: string[] = [];
    const transaction = db.transaction.bind(db);
    vi.spyOn(db,'transaction').mockImplementation(async work => transaction(async tx => {
      const query = vi.spyOn(tx,'query');
      try { return await work(tx); }
      finally { sqls.push(...query.mock.calls.map(([sql])=>sql)); }
    }));
    const send = vi.fn().mockResolvedValue(undefined);
    expect(await new PushDeliveryLoop(db,{send}).runOnce()).toBe(2);
    expect(send.mock.calls.map(([token])=>token).sort()).toEqual(['proof-device','stale']);
    expect((await db.query(`SELECT device_token FROM push_delivery_claims WHERE status='suppressed' ORDER BY device_token`)).rows
      .map(row=>row.device_token)).toEqual(['lease','muted','read','recent','view']);
    expect(sqls.filter(sql=>sql.includes('SELECT candidate.message_id,candidate.token'))).toHaveLength(1);
  } finally { await db.close(); }
});

it('does not enqueue cards the delivery policy unconditionally excludes', async () => {
  const db = new PgliteDatabase();
  try {
    await setup(db);
    await db.query(`INSERT INTO messages(id,room_id,author_id,text,presentation,card_type)
      VALUES('excluded',$1,$2,'Order reference','card','agent-command')`,[room,author]);
    expect((await db.query(`SELECT * FROM push_outbox`)).rows).toHaveLength(0);
  } finally { await db.close(); }
});


it('does not send a claim that expires while waiting for provider capacity', async () => {
  const db = new PgliteDatabase();
  try {
    await setup(db);
    await post(db,'expires-before-send');
    const query = db.query.bind(db);
    const future = Date.now()+2*60*60*1000;
    vi.spyOn(db,'query').mockImplementation(async (sql,values) => {
      const result = await query(sql,values);
      if (sql.includes('INSERT INTO push_delivery_claims AS claim'))
        vi.spyOn(Date,'now').mockReturnValue(future);
      return result;
    });
    const send = vi.fn().mockResolvedValue(undefined);
    expect(await new PushDeliveryLoop(db,{send}).runOnce()).toBe(0);
    expect(send).not.toHaveBeenCalled();
    expect((await query(`SELECT status,error FROM push_delivery_claims WHERE message_id='expires-before-send'`)).rows)
      .toEqual([{status:'failed',error:'Push expired before provider send'}]);
    expect((await query(`SELECT * FROM push_outbox`)).rows).toHaveLength(0);
  } finally { vi.restoreAllMocks(); await db.close(); }
});

it('preserves the old selector delivery set and retires only rows it would never select', async () => {
  const db = new PgliteDatabase();
  try {
    await setup(db);
    const full = 'c'.repeat(64), off = 'd'.repeat(64), agent = 'e'.repeat(64);
    await db.query(`UPDATE identities SET push_level='attention' WHERE id=$1`,[person]);
    await db.query(`INSERT INTO identities(id,kind,name,handle,push_level)
      VALUES($1,'human','Full','full','full'),($2,'human','Off','off','off'),
        ($3,'agent','Agent','agent','attention')`,[full,off,agent]);
    for (const id of [full,off,agent]) await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
      VALUES($1,$2,$3,'member')`,[workspace,room,id]);
    await db.query(`INSERT INTO push_devices(token,identity_id,platform,environment,registered_at)
      VALUES('full-device',$1,'android','physical',now()-interval '1 day'),
        ('off-device',$2,'android','physical',now()-interval '1 day')`,[full,off]);
    const dm = '33333333-3333-4333-8333-333333333333';
    await db.query(`INSERT INTO rooms(id,workspace_id,name,direct_participants)
      VALUES($1,$2,'DM',$3::jsonb)`,[dm,workspace,JSON.stringify([person,author])]);
    await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
      VALUES($1,$2,$3,'member'),($1,$2,$4,'member')`,[workspace,dm,person,author]);
    await db.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES('reply-source',$1,$2,'Earlier owner message')`,[room,person]);
    const cases = [
      {id:'github-note',presentation:'system',cardType:'github-corner-note'},
      {id:'github-reply',presentation:'system',cardType:'github-corner-note',reply:'reply-source'},
      {id:'command',presentation:'card',cardType:'agent-command'},
      {id:'plain',text:'Untargeted prose'},
      {id:'tag',text:'@owner Please look'},
      {id:'quoted-tag',text:'`@owner` is quoted'},
      {id:'choice',presentation:'card',cardType:'choice',card:{mode:'question',mentionIds:[person]}},
      {id:'multi-choice',presentation:'card',cardType:'choice',card:{mode:'question',mentionIds:[person,full]}},
      {id:'closed-choice',presentation:'card',cardType:'choice',card:{mode:'question',status:'closed',mentionIds:[person]}},
      {id:'offline',presentation:'card',cardType:'machine-offline',card:{status:'open',ownerId:person}},
      {id:'retired-merge',presentation:'card',cardType:'corner-merge-yes',text:'@owner merged'},
      {id:'relay',presentation:'card',cardType:'relay',card:{direction:'up'}},
      {id:'automatic',presentation:'card',cardType:'grant-auto'},
      {id:'dm',channel:dm},
      {id:'dm-note',channel:dm,presentation:'system',cardType:'github-corner-note'},
      {id:'retry'},
      {id:'claimed'},
    ];
    for (const row of cases) await db.query(`INSERT INTO messages(id,room_id,author_id,text,presentation,card_type,card,reply_to_message_id)
      VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8)`,[row.id,row.channel??room,author,row.text??'Unaddressed update',
        row.presentation??'message',row.cardType??null,JSON.stringify(row.card??null),row.reply??null]);
    await db.query(`INSERT INTO agent_turns(room_id,request_id,agent_id,status) VALUES($1,'working-turn',$2,'working')`,[room,agent]);
    await db.query(`INSERT INTO messages(id,room_id,author_id,text,request_id)
      VALUES('working',$1,$2,'@owner final answer','working-turn')`,[room,agent]);
    for (const id of [person,full,off]) await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
      VALUES($1,NULL,$2,'member')`,[workspace,id]);
    await db.query(`INSERT INTO workspace_join_notifications(id,workspace_id,room_id,joining_identity_id,text)
      VALUES('join-parity',$1,$2,$3,'Peer joined')`,[workspace,room,author]);
    await db.query(`INSERT INTO workspace_join_notification_devices(notification_id,device_token)
      VALUES('join-parity','proof-device'),('join-parity','full-device'),('join-parity','off-device')`);
    const key = (message: string,token: string) => JSON.stringify([message,token]);
    const queued = async () => (await db.query<{message_id:string;device_token:string}>(`SELECT message_id,device_token FROM push_outbox`)).rows;
    const newlyQueued = new Set((await queued()).map(row=>key(row.message_id,row.device_token)));
    for (const id of ['github-note','command','multi-choice','closed-choice','retired-merge','relay','automatic','dm-note'])
      expect([...newlyQueued].some(value=>JSON.parse(value)[0]===id),id).toBe(false);
    expect(newlyQueued.has(key('github-reply','proof-device'))).toBe(true);
    // Recreate all old fanout rows and context, including those new writes omit.
    await db.query(`INSERT INTO push_message_context(message_id,room_id,author_id,request_id,turn_ids,burst_ids,expires_at)
      SELECT id,room_id,author_id,request_id,ARRAY[id],ARRAY[id],created_at+interval '1 hour' FROM messages
      ON CONFLICT DO NOTHING`);
    await db.query(`INSERT INTO push_outbox(message_id,device_token,expires_at)
      SELECT m.id,device.token,m.created_at+interval '1 hour' FROM messages m
      JOIN effective_memberships member ON member.room_id=m.room_id AND member.removed_at IS NULL AND member.identity_id<>m.author_id
      JOIN push_devices device ON device.identity_id=member.identity_id ON CONFLICT DO NOTHING`);
    await db.query(`INSERT INTO push_delivery_claims(message_id,device_token,status,next_retry_at)
      VALUES('retry','proof-device','retryable',now()+interval '5 minutes')`);
    await db.query(`INSERT INTO push_delivery_claims(message_id,device_token,status)
      VALUES('claimed','proof-device','claimed')`);
    const legacySql = await readFile(new URL('./test-fixtures/push-selection-before-backlog.sql',import.meta.url),'utf8');
    const before = await queued();
    const eligible = async (rows: typeof before) => new Set((await db.query<{message_id:string;token:string}>(legacySql,
      [JSON.stringify(rows)])).rows.map(row=>key(row.message_id,row.token)));
    const oldEligible = await eligible(before);
    expect(oldEligible.size).toBeGreaterThan(0);
    for (const value of oldEligible) expect(newlyQueued.has(value),`enqueue removed old-eligible ${value}`).toBe(true);
    const sent: string[] = [];
    const loop = new PushDeliveryLoop(db,{send:async (token,message)=>{sent.push(key(message.messageId,token));}});
    await loop.runOnce();
    expect(new Set(sent)).toEqual(oldEligible);
    const after = new Set((await queued()).map(row=>key(row.message_id,row.device_token)));
    const claims = new Set((await db.query<{message_id:string;device_token:string}>(`SELECT message_id,device_token FROM push_delivery_claims`))
      .rows.map(row=>key(row.message_id,row.device_token)));
    const retired = before.map(row=>key(row.message_id,row.device_token)).filter(value=>!after.has(value)&&!claims.has(value));
    expect(retired.length).toBeGreaterThan(0);
    for (const value of retired) expect(oldEligible.has(value),`retired old-eligible ${value}`).toBe(false);
    // Retained preferences and working turns can still become deliverable.
    expect(after.has(key('plain','proof-device'))).toBe(true);
    expect(after.has(key('working','proof-device'))).toBe(true);
    expect(after.has(key('retry','proof-device'))).toBe(true);
    expect(after.has(key('claimed','proof-device'))).toBe(true);
    expect(after.has(key('join-parity','proof-device'))).toBe(true);
    await db.query(`UPDATE identities SET push_level='full' WHERE id IN ($1,$2)`,[person,off]);
    await db.query(`UPDATE agent_turns SET status='complete' WHERE request_id='working-turn'`);
    const oldEligibleAfterChange = await eligible(await queued());
    sent.length=0;
    await loop.runOnce();
    expect(new Set(sent)).toEqual(oldEligibleAfterChange);
    expect(sent).toContain(key('plain','proof-device'));
    expect(sent).toContain(key('working','proof-device'));
    expect(sent).toContain(key('join-parity','proof-device'));
    console.info(`Legacy parity: ${oldEligible.size} initial deliveries preserved; ${retired.length} ineligible rows retired; ${sent.length} preference/turn deliveries preserved`);
  } finally { await db.close(); }
});


it('BEELINE-SERVER-17: parks preference backlog until a preference change or expiry', async () => {
  const db = new PgliteDatabase();
  try {
    await setup(db);
    await db.query(`UPDATE identities SET push_level='attention' WHERE id=$1`, [person]);
    await db.query(`INSERT INTO messages(id,room_id,author_id,text)
      SELECT 'preference-'||n,$1,$2,'Ordinary room conversation' FROM generate_series(1,1100) n`, [room,author]);
    const send = vi.fn().mockResolvedValue(undefined);
    const loop = new PushDeliveryLoop(db,{send});
    await loop.runOnce();
    await loop.runOnce();
    expect(send).not.toHaveBeenCalled();
    expect((await db.query(`SELECT * FROM push_outbox WHERE not_before<>expires_at`)).rows).toHaveLength(0);
    expect((await db.query(`SELECT * FROM push_outbox`)).rows).toHaveLength(1100);
    await post(db,'direct-attention');
    expect(await loop.runOnce()).toBe(1);
    expect(send).toHaveBeenCalledWith('proof-device',expect.objectContaining({messageId:'direct-attention'}));
    // Changing preferences wakes the retained prose without waiting for expiry.
    await db.query(`UPDATE identities SET push_level='full' WHERE id=$1`,[person]);
    expect((await db.query(`SELECT * FROM push_outbox WHERE not_before<=now()`)).rows).toHaveLength(1100);
    await loop.runOnce();
    await loop.runOnce();
    expect(send.mock.calls.some(([,message])=>message.messageId.startsWith('preference-'))).toBe(true);
    await db.query(`UPDATE identities SET push_level='off' WHERE id=$1`,[person]);
    await post(db,'off-expiry');
    await loop.runOnce();
    expect((await db.query(`SELECT * FROM push_outbox WHERE message_id='off-expiry' AND not_before=expires_at`)).rows).toHaveLength(1);
    await db.query(`UPDATE push_outbox SET expires_at=now()-interval '1 second' WHERE message_id='off-expiry'`);
    await loop.runOnce();
    expect((await db.query(`SELECT reason FROM push_outbox_retirements WHERE message_id='off-expiry'`)).rows)
      .toEqual([{reason:'expired'}]);
    expect(send.mock.calls.some(([,message])=>message.messageId==='off-expiry')).toBe(false);
  } finally { await db.close(); }
});

it('keeps disabled-platform retries and a preference wake concurrent with parking', async () => {
  const db = new PgliteDatabase();
  try {
    await setup(db);
    await db.query(`UPDATE identities SET push_level='attention' WHERE id=$1`,[person]);
    await db.query(`UPDATE push_devices SET platform='ios' WHERE token='proof-device'`);
    await post(db,'disabled-ios');
    const send = vi.fn().mockResolvedValue(undefined);
    await new PushDeliveryLoop(db,{send}).runOnce();
    expect((await db.query(`SELECT * FROM push_outbox WHERE not_before<expires_at`)).rows).toHaveLength(1);
    await db.query(`UPDATE identities SET push_level='off' WHERE id=$1`,[person]);
    const query = db.query.bind(db);
    let changed = false;
    const spy = vi.spyOn(db,'query').mockImplementation(async (sql,values) => {
      if (!changed && sql.includes('AND queue.not_before=due.lease_until')) {
        changed=true;
        await query(`UPDATE identities SET push_level='attention' WHERE id=$1`,[person]);
      }
      return query(sql,values);
    });
    const loop = new PushDeliveryLoop(db,undefined,{send});
    await loop.runOnce();
    spy.mockRestore();
    expect(changed).toBe(true);
    expect((await db.query(`SELECT * FROM push_outbox WHERE not_before<=now()`)).rows).toHaveLength(1);
    expect(await loop.runOnce()).toBe(1);
    expect(send).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith('proof-device',expect.objectContaining({messageId:'disabled-ios'}));
  } finally { await db.close(); }
});

it('BEELINE-SERVER-17: message edits wake parked mentions but preserve retry deadlines', async () => {
  const db = new PgliteDatabase();
  try {
    await setup(db);
    await db.query(`UPDATE identities SET push_level='attention' WHERE id=$1`,[person]);
    await db.query(`INSERT INTO messages(id,room_id,author_id,text)
      VALUES('edited-prose',$1,$2,'Ordinary conversation')`,[room,author]);
    const send = vi.fn().mockResolvedValue(undefined);
    const loop = new PushDeliveryLoop(db,{send});
    await loop.runOnce();
    expect((await db.query(`SELECT * FROM push_outbox WHERE not_before=expires_at`)).rows).toHaveLength(1);
    await db.query(`UPDATE messages SET text='@owner please read this' WHERE id='edited-prose'`);
    expect(await loop.runOnce()).toBe(1);
    expect(send).toHaveBeenCalledWith('proof-device',expect.objectContaining({messageId:'edited-prose'}));
    await db.query(`UPDATE messages SET text='Ordinary conversation again' WHERE id='edited-prose'`);
    expect(await loop.runOnce()).toBe(0);
    await db.query(`UPDATE messages SET text='@owner mention again' WHERE id='edited-prose'`);
    expect(await loop.runOnce()).toBe(0);
    expect(send).toHaveBeenCalledOnce();
    await post(db,'edited-retry');
    await db.query(`INSERT INTO push_delivery_claims(message_id,device_token,status,next_retry_at)
      VALUES('edited-retry','proof-device','retryable',now()+interval '5 minutes')`);
    const before = (await db.query(`SELECT not_before FROM push_outbox WHERE message_id='edited-retry'`)).rows;
    await db.query(`UPDATE messages SET text='@owner edited retry' WHERE id='edited-retry'`);
    expect((await db.query(`SELECT not_before FROM push_outbox WHERE message_id='edited-retry'`)).rows).toEqual(before);
    expect(await loop.runOnce()).toBe(0);
    expect(send).toHaveBeenCalledOnce();
  } finally { await db.close(); }
});
