import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { type AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { migratedDatabase, type PgliteDatabase } from './test-support.js';
import { readInsightLoss } from './insight-loss.js';
import { createBeelineServer } from './server.js';
import { LiveHub } from './live.js';
import type { TokenAuth } from './auth.js';
import type { PhoneService } from './phone-service.js';
import type { DaemonService } from './daemon-service.js';

let db: PgliteDatabase;
let server: ReturnType<typeof createBeelineServer> | undefined;
const human = 'a'.repeat(64), agent = 'b'.repeat(64), other = 'c'.repeat(64), sha = 'd'.repeat(40);
let workspace: string, room: string, since: string;
const ago = (minutes: number) => new Date(Date.now()-minutes*60_000).toISOString();
beforeEach(async () => {
  db = await migratedDatabase();
  workspace = randomUUID(); room = randomUUID(); since = ago(60);
  await db.query(`INSERT INTO workspaces(id,name,allow_fix_sweep) VALUES($1,'Customers',true)`, [workspace]);
  await db.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Thread')`, [room,workspace]);
  await db.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Person'),($2,'agent','Agent'),($3,'agent','Other')`, [human,agent,other]);
});
afterEach(async () => {
  if (server) { await new Promise<void>(resolve => server!.close(() => resolve())); server = undefined; }
  await db.close(); vi.unstubAllEnvs();
});
async function message(text: string, minutes: number, target?: string, author = human, where = room) {
  const id = randomUUID();
  await db.query(`INSERT INTO messages(id,room_id,author_id,text,created_at) VALUES($1,$2,$3,$4,$5)`, [id,where,author,text,ago(minutes)]);
  if (target) await db.query(`INSERT INTO agent_commands(id,room_id,agent_id,source_message_id,turn_request_id,action,reason,root_command_id,root_source_message_id,agent_depth)
    VALUES($1,$2,$3,$4,$1,'input','human_tag',$1,$4,0)`, [randomUUID(),where,target,id]);
  return id;
}
const read = () => readInsightLoss(db,since,sha);
const kinds = (result: Awaited<ReturnType<typeof read>>) => result.threads.flatMap(t => t.signals.map((s: {kind: string}) => s.kind));
it('scores restatements only to the same agent within 15 minutes, and excludes stale/hidden/internal traffic', async () => {
  await message('Please prepare the quarterly financial report',25,agent);
  await message('Please prepare the quarterly financial report!',20,agent);
  await message('Please prepare the quarterly financial report',19,other);
  await message('Please prepare the quarterly financial report',1,agent);
  await message('why still not working??',120);
  const result = await read();
  expect(kinds(result)).toEqual(['restatement']);
  expect(result.threads[0].score).toBe(3);
  await db.query(`UPDATE workspaces SET internal=true WHERE id=$1`,[workspace]);
  expect((await read()).threads).toEqual([]);
  await db.query(`UPDATE workspaces SET internal=false WHERE id=$1`,[workspace]);
  await db.query(`UPDATE workspaces SET allow_fix_sweep=false WHERE id=$1`,[workspace]);
  expect((await read()).threads).toEqual([]);
  await db.query(`UPDATE workspaces SET allow_fix_sweep=true WHERE id=$1`,[workspace]);
  await db.query(`UPDATE identities SET hidden_from_roster=true WHERE id=$1`,[human]);
  expect((await read()).threads).toEqual([]);
});
it('finds a long silence followed by a nudge, but an agent reply clears the silence signal', async () => {
  await message('Can you prepare the release notes?',45,agent);
  await message('hello, any update?',2,agent);
  expect(kinds(await read())).toContain('silence_nudge');
  await message('I have the release notes.',20,undefined,agent);
  expect(kinds(await read())).not.toContain('silence_nudge');
});
it('scores failures followed by humans, human Stop taps, cancelled commands and both feedback intake paths', async () => {
  const failure = await message('@worker could not answer',10,undefined,agent);
  await db.query(`UPDATE messages SET presentation='system' WHERE id=$1`,[failure]);
  await message('still not working??',9,agent);
  const stop = await message('stopped worker',8);
  await db.query(`UPDATE messages SET presentation='system',system_event='{"kind":"turn-cancelled"}'::jsonb WHERE id=$1`,[stop]);
  // A command started before this release can be stopped on the current one.
  const old = await message('Prepare my report',120,agent);
  await db.query(`UPDATE agent_commands SET state='cancelled',cancellation_reason='stop',completed_at=$2 WHERE source_message_id=$1`,[old,ago(8)]);
  for (const text of ['@system the upload failed','Report issue']) {
    const id = await message(text,5);
    await db.query(`INSERT INTO feedback_items(id,source_kind,reporter_identity_id,workspace_id,room_id,trigger_message_id,category,summary,summary_key,created_at)
      VALUES($1,'human',$2,$3,$4,$1,'human_report','report',$1,$5)`,[id,human,workspace,room,ago(5)]);
  }
  expect(kinds(await read())).toEqual(expect.arrayContaining(['frustration','failure_followup','human_stop','cancelled_command','human_report']));
  expect(kinds(await read()).filter(k => k==='human_report')).toHaveLength(2);
});
it('caps results to the ten highest scoring threads and context to twelve short messages each', async () => {
  for (let i=0; i<12; i++) {
    const thread = randomUUID();
    await db.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Thread')`,[thread,workspace]);
    await message('why not working??',2,undefined,human,thread);
  }
  for (let i=0; i<25; i++) await message('still '+ 'x'.repeat(600),1);
  const result = await read();
  expect(result.threads).toHaveLength(10);
  expect(result.threads[0].room_id).toBe(room);
  expect(result.threads[0].messages).toHaveLength(12);
  expect(result.threads[0].signals).toHaveLength(20);
  expect(result.threads[0].messages.every((m: {text: string}) => m.text.length<=500)).toBe(true);
});
it('requires the private operator credential and current SHA, refuses malformed boundaries, and disables caching/CORS', async () => {
  vi.stubEnv('BEELINE_RELEASE_SHA',sha);
  server = createBeelineServer({ database: db, dashboardSecret:'operator-secret',auth:{} as TokenAuth,
    phone:{} as PhoneService,daemon:{} as DaemonService,live:new LiveHub(),mediaMaximumBytes:1 });
  await new Promise<void>(resolve => server!.listen(0,'127.0.0.1',resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/admin/insights/loss`;
  const query = `?since=${encodeURIComponent(since)}&sourceSha=${sha}`;
  expect((await fetch(base+query)).status).toBe(403);
  const get = (q=query) => fetch(base+q,{headers:{authorization:'Bearer operator-secret',origin:'https://usebeeline.app'}});
  expect((await get(query.replace(sha,'e'.repeat(40)))).status).toBe(409);
  expect((await get(query+'&since='+since)).status).toBe(400);
  expect((await get('?since=invalid&sourceSha='+sha)).status).toBe(400);
  const response = await get();
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  expect(response.headers.has('access-control-allow-origin')).toBe(false);
  expect(await response.json()).toMatchObject({sourceSha:sha,threads:[]});
});

it('samples five distinct eligible active workspaces, excludes named memberships/opt-outs, and reports zero honestly', async () => {
  const sql = readFileSync(new URL('../../../docs/loops/workspace-sample.sql',import.meta.url),'utf8');
  expect((await db.query(sql)).rows[0]).toMatchObject({eligible_count:0,workspace_ids:[]});
  const eligible: string[] = [];
  for(let i=0;i<8;i++) {
    const id=randomUUID(), thread=randomUUID();
    await db.query(`INSERT INTO workspaces(id,name,allow_fix_sweep) VALUES($1,'Sample',$2)`,[id,i!==7]);
    await db.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Sample')`,[thread,id]);
    await message('I finished my task',10,undefined,human,thread);
    if(i<2) {
      const person=String(i+1).repeat(64);
      await db.query(`INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Excluded',$2)`,[person,i===0?'lunchboxfortwo':'methoxine']);
      await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'member')`,[id,i===0?null:thread,person]);
    } else if(i!==7) eligible.push(id);
  }
  const sample=(await db.query(sql)).rows[0];
  expect(sample.eligible_count).toBe(5);
  expect(sample.workspace_ids.sort()).toEqual(eligible.sort());
  await db.query(`UPDATE workspaces SET allow_fix_sweep=false`);
  expect((await db.query(sql)).rows[0]).toMatchObject({eligible_count:0,workspace_ids:[]});
});
