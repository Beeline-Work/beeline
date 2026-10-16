// Run after the server build: node --import tsx docs/evidence/free-agent-guide/removal-proof.mjs
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { PgliteDatabase } from '../../../apps/server/src/test-support.ts';
import { migrate } from '../../../apps/server/dist/database.js';
import { PhoneService } from '../../../apps/server/dist/phone-service.js';
import { FreeAgentService, addFreeAgentToWorkspace, FREE_AGENT_REMOVAL_NOTE } from '../../../apps/server/dist/free-agents.js';
import { handleFreeAgentModelRequest } from '../../../apps/server/dist/free-agent-model-proxy.js';
const db = new PgliteDatabase();
await migrate(db);
const owner = 'a'.repeat(64);
await db.query("INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Owner','owner')", [owner]);
const config = { model:'deepseek/deepseek-v4.1-flash', idleSeconds:60, maxPerOwner:3, dailyTokenCap:300000, lifetimeTokenCap:0, sealSecret:'isolated-proof', publicOrigin:'https://server.test', image:'proof', region:'iad', cpus:1, memoryMb:1024, sleepMode:'stop', reapIdleMs:300000, deleteAfterMs:2592000000 };
const calls = []; let spec; let failDelete = true;
const machines = {
  async create(value) { spec=value; calls.push('create m1'); return { id:'m1' }; },
  async find() { return undefined; },
  async start() { calls.push('start m1'); },
  async destroy(id) { calls.push(`destroy ${id}`); if(failDelete) throw Error('simulated Fly outage'); },
  async stop() {}, async suspend() {}, async state() {return 'started';}, async waitFor() {},
};
const free = new FreeAgentService(db,config,machines,async()=>({exchangeToken:'proof-exchange'}),()=>{});
const phone = new PhoneService(db,config.publicOrigin);
phone.setFreeAgents(free);
const workspace = await phone.execute('createWorkspace',{name:'Removal proof'},owner);
for(let i=0;i<100&&!spec;i++) await new Promise(r=>setTimeout(r,10));
await new Promise(r=>setTimeout(r,100));
const agent = (await db.query('SELECT agent_id FROM free_agents WHERE workspace_id=$1',[workspace.id])).rows[0].agent_id;
const grant = await free.bootstrap(spec.env.BEELINE_FREE_AGENT_BOOTSTRAP);
assert(grant.soul.includes(FREE_AGENT_REMOVAL_NOTE));
let upstreamCalls=0;
const server=createServer((req,res)=>void handleFreeAgentModelRequest(req,res,new URL(req.url,'http://x').pathname,{database:db,config,upstreamKey:'proof-only',fetchImpl:async()=>{upstreamCalls++;return Response.json({});}}));
await new Promise(r=>server.listen(0,'127.0.0.1',r));
try {
  const before=await phone.readWorkspaceMembers(workspace.id,owner);
  assert(JSON.stringify(before).includes('Beebee'));
  await phone.execute('removeAgent',{workspaceId:workspace.id,agentId:agent},owner);
  await new Promise(r=>setTimeout(r,100));
  const row=(await db.query('SELECT removed_at,removal_cleaned_at,bootstrap_hash,model_token_hash FROM free_agents WHERE agent_id=$1',[agent])).rows[0];
  assert(row.removed_at); assert.equal(row.removal_cleaned_at,null); assert.equal(row.bootstrap_hash,null); assert.equal(row.model_token_hash,null);
  const after=await phone.readWorkspaceMembers(workspace.id,owner);
  assert(!JSON.stringify(after).includes('Beebee'));
  assert.equal(await free.bootstrap(spec.env.BEELINE_FREE_AGENT_BOOTSTRAP),undefined);
  const response=await fetch(`http://127.0.0.1:${server.address().port}/v1/free-agents/model/chat/completions`,{method:'POST',headers:{authorization:`Bearer ${grant.modelToken}`,'content-type':'application/json'},body:JSON.stringify({messages:[]})});
  assert.equal(response.status,401); assert.equal(upstreamCalls,0);
  failDelete=false;
  await free.sweep();
  assert((await db.query('SELECT removal_cleaned_at FROM free_agents WHERE agent_id=$1',[agent])).rows[0].removal_cleaned_at);
  const count=calls.length;
  await phone.execute('sendRoomMessage',{roomId:workspace.roomId,messageId:'f'.repeat(64),text:'@beebee hello',mentions:[agent]},owner);
  free.kickIfFree(agent); free.kick(agent);
  assert.equal(await free.wake(agent),false); assert.equal(await free.provision(agent),false);
  assert.equal(await addFreeAgentToWorkspace(db,free,workspace.id),undefined);
  await free.sweep(); await new Promise(r=>setTimeout(r,100));
  assert.equal(calls.length,count);
  console.log(JSON.stringify({proof:'FREE-REMOVE-1',membersBefore:'Beebee',membersAfter:'absent',removalCommittedDuringFlyFailure:true,bootstrap:'refused',modelHTTP:response.status,upstreamCalls,machineCalls:calls,afterRemovalMentionWakeAndOperatorAdd:'no Machine',helloEndsWith:FREE_AGENT_REMOVAL_NOTE}));
} finally {await new Promise(r=>server.close(r));await db.close();}
