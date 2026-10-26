import assert from 'node:assert/strict';
import { PgliteDatabase } from '../apps/server/src/test-support.ts';
import { migrate } from '../apps/server/dist/database.js';
import { reserveServiceReviewWorkspaces, readServiceReviewPage, completeServiceReview } from '../apps/server/dist/service-review.js';

// Synthetic content only. Exercise the same SQL pages used by the read-only walk.
const db = new PgliteDatabase();
const human = 'a'.repeat(64), agent = 'b'.repeat(64);
const workspace = '10000000-0000-4000-8000-000000000001';
const room = '20000000-0000-4000-8000-000000000001';
try {
  await migrate(db);
  await db.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Synthetic person'),($2,'agent','Synthetic agent')`,[human,agent]);
  await db.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`,[agent,human]);
  await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Synthetic external workspace')`,[workspace]);
  await db.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Synthetic room')`,[room,workspace]);
  await db.query(`INSERT INTO messages(id,room_id,author_id,text,created_at)
    SELECT 'history-'||n,$1,CASE WHEN n%2=0 THEN $2 ELSE $3 END,'Synthetic content',now()-interval '10 days'
    FROM generate_series(1,205) n`,[room,human,agent]);
  assert.deepEqual(await reserveServiceReviewWorkspaces(db,agent,'daily',true),[]);
  assert.deepEqual(await reserveServiceReviewWorkspaces(db,agent,'monday',true,14),[workspace]);
  let after='', count=0, pages=0;
  const people=new Set(), agents=new Set(), times=[];
  for (;;) {
    const page=await readServiceReviewPage(db,agent,'monday',workspace,after);
    if (!page.rows.length) break;
    assert.ok(page.rows.length<=200);
    pages++;
    for (const row of page.rows) {
      const activity=row.activity;
      assert.ok(['human','agent'].includes(activity.authorKind));
      if (activity.authorKind==='human') { people.add(activity.authorId); assert.equal(activity.ownerId,null); }
      else { agents.add(activity.authorId); assert.equal(activity.ownerId,human); }
      times.push(new Date(activity.createdAt).toISOString());
    }
    count+=page.rows.length;
    after=page.rows.at(-1).id;
  }
  assert.equal(count,205); assert.equal(pages,2);
  assert.equal(people.size,1); assert.equal(agents.size,1);
  times.sort();
  await completeServiceReview(db,agent,'monday',[{workspace,rowsRead:count,firstMessageTime:times[0],lastMessageTime:times.at(-1),findings:'none'}]);
  assert.deepEqual(await reserveServiceReviewWorkspaces(db,agent,'next-day',true),[]);
  console.log('PASS: built walk reads historical people and agents across two bounded pages, verifies ownership, commits coverage, and leaves no daily backlog. No message text emitted.');
} finally { await db.close(); }
