// Reproduction wake-storm-83: built HTTP service and original person's phone read.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PgliteDatabase, insertCornerFacts } from '../apps/server/src/test-support.ts';
import { migrate } from '../apps/server/dist/database.js';
import { createAgentCommand } from '../apps/server/dist/agent-command.js';
import { DaemonService } from '../apps/server/dist/daemon-service.js';
import { PhoneService } from '../apps/server/dist/phone-service.js';
import { LiveHub } from '../apps/server/dist/live.js';
import { TokenAuth, tokenHash } from '../apps/server/dist/auth.js';
import { createBeelineServer } from '../apps/server/dist/server.js';
const H = 'a'.repeat(64), A = 'b'.repeat(64), B = 'c'.repeat(64);
const W = '11111111-1111-4111-8111-111111111111', R = '22222222-2222-4222-8222-222222222222', C = '33333333-3333-4333-8333-333333333333';
const db = new PgliteDatabase();
let server;
try {
  await migrate(db);
  await db.query(`INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Person','person'),($2,'agent','Agent','agent'),($3,'agent','Commander','commander')`, [H,A,B]);
  await db.query('INSERT INTO agents(agent_id,owner_id) VALUES($1,$3),($2,$3)', [A,B,H]);
  await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Isolated replay')`, [W]);
  await db.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$3,'Original conversation'),($2,$3,'Work')`, [R,C,W]);
  await db.query('UPDATE rooms SET parent_id=$1 WHERE id=$2', [R,C]);
  await insertCornerFacts(db, { cornerId:C,ownerAgentId:A,lifecycle:'{"checks":"unknown"}' });
  for (const member of [H,A,B]) for (const room of [null,R])
    await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'owner')`, [W,room,member]);
  await db.query(`INSERT INTO free_agents(agent_id,workspace_id,owner_id,sealed_keys,state) VALUES($1,$2,$3,'fixture','running')`, [A,W,H]);
  const daemonToken = 'bdt_silent_wake_local_fixture';
  await db.query('INSERT INTO daemon_tokens(token_hash,agent_id) VALUES($1,$2)', [tokenHash(daemonToken),A]);
  const live = new LiveHub(), daemon = new DaemonService(db,live), phone = new PhoneService(db,'http://proof',undefined,undefined,live);
  const auth = new TokenAuth(db,async () => ({ subject:'wake-storm-person',login:'person',name:'Person' }));
  await db.query(`INSERT INTO identity_external_links(provider,subject,identity_id,issuer,audience,provider_login) VALUES('github','wake-storm-person',$1,'https://github.com','beeline','person')`, [H]);
  const phoneToken = (await auth.exchangeGitHubOidc('fixture')).accessToken;
  server = createBeelineServer({ database:db,daemon,phone,live,auth,mediaMaximumBytes:1024 });
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  async function call(name,input,surface='daemon') {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/v1/${surface}/operations/${name}`, {
      method:'POST',headers:{ authorization:`Bearer ${surface === 'phone' ? phoneToken : daemonToken}`,'content-type':'application/json' },body:JSON.stringify(input),
    });
    const body = await response.json();
    assert.equal(response.status,200,`${name}: ${JSON.stringify(body)}`);
    return body;
  }
  const root = await call('sendRoomMessage',{roomId:R,text:'Make the README useful'},'phone');
  const opening = await createAgentCommand(db,{roomId:C,agentId:A,sourceMessageId:null,reason:'corner_objective',scheduledHumanCommandMessageId:root.messageId,
    privatePayload:{kind:'order',authorId:H,fromRoomId:R,text:'Make the README useful'}});
  await db.query("UPDATE agent_commands SET state='complete' WHERE id=$1",[opening.id]);
  const commands = async () => (await call('getAgentCommands',{roomId:C})).commands;
  const replay = JSON.parse(readFileSync(new URL('../apps/server/src/fixtures/wake-storm-83.json',import.meta.url),'utf8'));
  const queued = new Map();
  let turns = 0;
  for (const [index,event] of replay.entries()) {
    if (event.reason === 'report') {
      const command = await createAgentCommand(db,{roomId:C,agentId:A,sourceMessageId:null,parent:opening,retainDepth:true,reason:'report',
        privatePayload:{kind:'report',authorId:B,fromRoomId:C,automatic:true,text:'blocked: Corner is idle. Resume it, set a hold, or close it.'}});
      if (command) queued.set(index,(await commands()).find(c=>c.id===command.id));
    }
    const command = queued.get(index);
    if (!command || !(await commands()).some(c=>c.id===command.id)) continue;
    await call('claimAgentCommand',{roomId:C,commandId:command.id,generationId:`replay-${index}`});
    turns++;
    const turn = {roomId:C,requestId:command.turnRequestId,generationId:`replay-${index}`};
    if (event.completionKind) await call('markAgentTurnSilent',turn);
    for (const [childIndex,child] of replay.entries()) {
      if (child.parent !== index) continue;
      await call('postBackgroundToolCompletion',{...turn,title:child.title,toolCallId:child.toolCallId,status:child.toolStatus});
      const next = (await commands()).find(c=>c.reason==='corner_background_tool' && ![...queued.values()].some(old=>old.id===c.id));
      if (next) queued.set(childIndex,next);
    }
    if (event.reply) await call('postCornerMessage',{...turn,cornerId:C,text:event.reply});
    await call('postAgentTurnReceipt',{...turn,status:event.status,...(event.completionKind ? {completionKind:event.completionKind}:{}),toolCalls:event.toolCalls ?? undefined});
    await db.query("UPDATE agent_commands SET state='complete' WHERE id=$1 AND state='claimed'",[command.id]);
  }
  assert.equal(turns,3,`unbounded replay: ${turns}`);
  assert.equal((await commands()).length,0);
  const view = await call('readRoom',{roomId:R},'phone');
  const noticeIds = (await db.query(`SELECT id FROM messages WHERE room_id=$1 AND card->>'silentWakeLimit'='true'`,[R])).rows.map(m=>m.id);
  assert.equal(noticeIds.length,1);
  const notices = view.messages.filter(m=>noticeIds.includes(m.id));
  assert.equal(notices.length,1);
  assert.match(notices[0].text,/could not answer/);
  assert.match(notices[0].text,/continue/);
  const fresh = await call('sendRoomMessage',{roomId:C,text:'@agent Continue the README work'},'phone');
  assert.ok((await commands()).some(c=>c.sourceMessageId===fresh.messageId));
  console.log(`wake-storm-83 PASS: production metadata (${replay.length} events) → (${turns} turns), one visible notice in original phone conversation, fresh human input accepted.`);
  console.log(notices[0].text);
} finally {
  if (server) { server.closeAllConnections(); await new Promise(resolve=>server.close(resolve)); }
  await db.close();
}
