import { afterEach, beforeEach, expect, it } from 'vitest';
import { migrate } from './database.js';
import { COHORT_SQL } from './operator-dashboard-cohort.js';
import { PgliteDatabase } from './test-support.js';
import { completeServiceReview, readServiceReviewPage, reserveServiceReviewWorkspaces } from './service-review.js';

let db: PgliteDatabase;
const agent = 'a'.repeat(64);
const human = 'b'.repeat(64);
const workspaces = ['10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000002'];
const rooms = ['20000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000002'];
beforeEach(async () => {
  db = new PgliteDatabase();
  await migrate(db);
  await db.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Synthetic reader')`,[human]);
  for (let n=0;n<2;n++) {
    await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Synthetic workspace')`,[workspaces[n]]);
    await db.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Synthetic room')`,[rooms[n],workspaces[n]]);
    await db.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'Synthetic request')`,[`message-${n}`,rooms[n],human]);
  }
});
afterEach(async () => { await db.close(); });
async function receipts(run: string) {
  const targets = await db.query<{workspace_id:string}>('SELECT * FROM service_review_targets($1,$2)',[agent,run]);
  return Promise.all(targets.rows.map(async target => {
    const page = await readServiceReviewPage(db,agent,run,target.workspace_id);
    const times = page.rows.map(row => new Date((row.activity as {createdAt:string}).createdAt).toISOString()).sort();
    return {workspace:target.workspace_id,rowsRead:page.rows.length,firstMessageTime:times[0]??null,lastMessageTime:times.at(-1)??null,findings:'none'};
  }));
}
it('walk-scope: a later invalid receipt cannot advance any workspace cursor', async () => {
  await reserveServiceReviewWorkspaces(db,agent,'failed',true);
  const rows = await receipts('failed');
  rows[1]!.rowsRead = 0;
  await expect(completeServiceReview(db,agent,'failed',rows)).rejects.toThrow('receipt must match');
  expect((await db.query(`SELECT * FROM service_review_visits WHERE completed_at IS NOT NULL`)).rows).toHaveLength(0);
  await reserveServiceReviewWorkspaces(db,agent,'retry',true);
  expect(await receipts('retry')).toHaveLength(2);
  await completeServiceReview(db,agent,'retry',await receipts('retry'));
  expect(await reserveServiceReviewWorkspaces(db,agent,'next',true)).toEqual([]);
});
it('walk-scope: internal workspaces are excluded at reservation, read, and validation', async () => {
  await db.query('UPDATE workspaces SET internal=true WHERE id=$1',[workspaces[0]]);
  expect(await reserveServiceReviewWorkspaces(db,agent,'external',true)).toEqual([workspaces[1]]);
  // A pre-migration reservation cannot reopen internal content or require its receipt.
  await db.query(`INSERT INTO service_review_visits(workspace_id,agent_id,run_id,read_from,read_through)
    VALUES($1,$2,'external',now()-interval '1 day',now())`,[workspaces[0],agent]);
  expect((await readServiceReviewPage(db,agent,'external',workspaces[0]!)).rows).toEqual([]);
  const externalReceipts = await receipts('external');
  expect(externalReceipts).toHaveLength(1);
  await completeServiceReview(db,agent,'external',externalReceipts);
  expect((await db.query(`SELECT * FROM service_review_visits WHERE workspace_id=$1 AND completed_at IS NOT NULL`,[workspaces[0]])).rows).toEqual([]);
  await expect(completeServiceReview(db,agent,'external',[...externalReceipts,{workspace:workspaces[0]}])).rejects.toThrow('receipt is required');
});
it('walk-scope: unread backlog survives failed days, including the first reservation', async () => {
  await reserveServiceReviewWorkspaces(db,agent,'interrupted',true);
  // Advance the fixture's clock by moving its timestamps back, including its reserved window.
  await db.query(`UPDATE messages SET created_at=created_at-interval '3 days'`);
  await db.query(`UPDATE service_review_visits SET visited_at=visited_at-interval '3 days',
    read_from=read_from-interval '3 days',read_through=read_through-interval '3 days'`);
  expect(await reserveServiceReviewWorkspaces(db,agent,'catchup',true)).toHaveLength(2);
  const caughtUp = await receipts('catchup');
  expect(caughtUp.map(row=>row.rowsRead)).toEqual([1,1]);
  await completeServiceReview(db,agent,'catchup',caughtUp);
  expect(await reserveServiceReviewWorkspaces(db,agent,'caught-up',true)).toEqual([]);
});
it('walk-scope: first reads are bounded, paginate fully, and the next window includes only new messages and turns', async () => {
  await db.query(`UPDATE workspaces SET allow_fix_sweep=false WHERE id=$1`,[workspaces[1]]);
  await db.query(`INSERT INTO messages(id,room_id,author_id,text,created_at)
    VALUES('old',$1,$2,'Old request',now()-interval '2 days')`,[rooms[0],human]);
  await db.query(`INSERT INTO messages(id,room_id,author_id,text)
    SELECT 'page-'||n,$1,$2,'Synthetic request' FROM generate_series(1,205) n`,[rooms[0],human]);
  await reserveServiceReviewWorkspaces(db,agent,'pages',true);
  let after='', count=0;
  for (;;) {
    const page = await readServiceReviewPage(db,agent,'pages',workspaces[0]!,after);
    if (!page.rows.length) break;
    expect(page.rows.map(row=>row.id)).not.toContain('old');
    count+=page.rows.length;
    after=page.rows.at(-1)!.id;
  }
  expect(count).toBe(206);
  const times = (await db.query<{first:Date;last:Date}>(`SELECT min(created_at) AS first,max(created_at) AS last FROM messages WHERE room_id=$1 AND id<>'old'`,[rooms[0]])).rows[0]!;
  await completeServiceReview(db,agent,'pages',[{workspace:workspaces[0],rowsRead:count,firstMessageTime:times.first.toISOString(),lastMessageTime:times.last.toISOString(),findings:'none'}]);
  await db.query(`INSERT INTO identities(id,kind,name) VALUES($1,'agent','Synthetic agent')`,[agent]);
  await db.query(`INSERT INTO agent_turns(room_id,request_id,agent_id,status) VALUES($1,'new-turn',$2,'failed')`,[rooms[0],agent]);
  expect(await reserveServiceReviewWorkspaces(db,agent,'turn-only',true)).toEqual([workspaces[0]]);
  const next = await readServiceReviewPage(db,agent,'turn-only',workspaces[0]!);
  expect(next.rows).toHaveLength(1);
  expect(next.rows[0]!.activity).toMatchObject({rowKind:'turn',status:'failed'});
  await completeServiceReview(db,agent,'turn-only',[{workspace:workspaces[0],rowsRead:1,firstMessageTime:null,lastMessageTime:null,findings:'Synthetic failure'}]);
});
it('walk-scope: migration seeds confirmed IDs and preserves other classifications', async () => {
  const ids=['bee11e00-0000-4000-8000-000000000105','c2e54c45-cf58-4cc1-a620-89b196096e7b','b81a2815-924c-4bd9-bc04-d38bdee177bc','18e555f7-e191-452b-9b0f-b825f58ee4ba'];
  for (const id of ids) await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Confirmed internal')`,[id]);
  const before = (await db.query<{id:string}>(`SELECT id FROM workspaces WHERE id<>ALL($1::uuid[]) ORDER BY id`,[ids.slice(0,3)])).rows.map(row=>row.id);
  await migrate(db);
  const after = (await db.query<{id:string}>(`WITH ${COHORT_SQL} SELECT id FROM production_workspaces ORDER BY id`)).rows.map(row=>row.id);
  expect(after).toEqual(before.filter(id=>id!==ids[3]));
  await db.query(`UPDATE workspaces SET internal=true WHERE id=$1`,[workspaces[0]]);
  await migrate(db);
  expect((await db.query(`SELECT id FROM workspaces WHERE internal`)).rows).toHaveLength(5);
  expect((await db.query(`SELECT internal FROM workspaces WHERE id=$1`,[workspaces[1]])).rows).toEqual([{internal:false}]);
});
it('walk-scope: legacy reservations remain visible but cannot read unbounded history', async () => {
  await db.query(`UPDATE messages SET created_at=now()-interval '2 days' WHERE room_id=$1`,[rooms[0]]);
  await db.query(`INSERT INTO service_review_visits(workspace_id,agent_id,run_id) VALUES($1,$2,'legacy')`,[workspaces[0],agent]);
  expect((await db.query('SELECT * FROM service_review_targets($1,$2)',[agent,'legacy'])).rows).toHaveLength(1);
  expect((await readServiceReviewPage(db,agent,'legacy',workspaces[0]!)).rows).toEqual([]);
});

it('walk-authors: SQL pages identify people and agent owners without conflating them', async () => {
  await db.query(`INSERT INTO identities(id,kind,name) VALUES($1,'agent','Synthetic agent')`,[agent]);
  await db.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`,[agent,human]);
  await db.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES('agent-reply',$1,$2,'Synthetic reply')`,[rooms[0],agent]);
  await reserveServiceReviewWorkspaces(db,agent,'authors',true);
  const page = await readServiceReviewPage(db,agent,'authors',workspaces[0]!);
  expect(page.rows.find(row=>row.id==='message-0')!.activity).toMatchObject({authorId:human,authorKind:'human',ownerId:null});
  expect(page.rows.find(row=>row.id==='agent-reply')!.activity).toMatchObject({authorId:agent,authorKind:'agent',ownerId:human});
});

it('walk-fortnight: weekly reads reopen completed history, page it, and recheck consent', async () => {
  await db.query(`UPDATE messages SET created_at=now()-interval '5 days'`);
  expect(await reserveServiceReviewWorkspaces(db,agent,'daily-empty',true)).toEqual([]);
  await db.query(`INSERT INTO messages(id,room_id,author_id,text,created_at)
    SELECT 'history-'||n,$1,$2,'Synthetic history',now()-interval '13 days' FROM generate_series(1,205) n`,[rooms[0],human]);
  await db.query(`INSERT INTO messages(id,room_id,author_id,text,created_at)
    VALUES('outside',$1,$2,'Outside window',now()-interval '15 days')`,[rooms[0],human]);
  await db.query(`UPDATE workspaces SET internal=true WHERE id=$1`,[workspaces[1]]);
  expect(await reserveServiceReviewWorkspaces(db,agent,'weekly',true,14)).toEqual([workspaces[0]]);
  let after='',count=0;
  const times:string[]=[];
  for (;;) {
    const page=await readServiceReviewPage(db,agent,'weekly',workspaces[0]!,after);
    if (!page.rows.length) break;
    expect(page.rows.length).toBeLessThanOrEqual(200);
    expect(page.rows.map(row=>row.id)).not.toContain('outside');
    count+=page.rows.length;
    times.push(...page.rows.map(row=>new Date((row.activity as {createdAt:string}).createdAt).toISOString()));
    after=page.rows.at(-1)!.id;
  }
  expect(count).toBe(206);
  times.sort();
  await completeServiceReview(db,agent,'weekly',[{workspace:workspaces[0],rowsRead:count,firstMessageTime:times[0],lastMessageTime:times.at(-1),findings:'none'}]);
  expect(await reserveServiceReviewWorkspaces(db,agent,'daily-after-weekly',true)).toEqual([]);
  expect(await reserveServiceReviewWorkspaces(db,agent,'weekly-again',true,14)).toEqual([workspaces[0]]);
  await db.query(`UPDATE workspaces SET allow_fix_sweep=false WHERE id=$1`,[workspaces[0]]);
  expect((await readServiceReviewPage(db,agent,'weekly-again',workspaces[0]!)).rows).toEqual([]);
});
