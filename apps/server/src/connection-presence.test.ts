import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {migratedDatabase,type PgliteDatabase} from './test-support.js';
import {ConnectionPresence,recordAgentEvidence,RecentIdentityTimes} from './connection-presence.js';
import {createAgentCommand,claimAgentCommand,createClaimedMcpAgentCommand} from './agent-command.js';
import {randomUUID} from 'node:crypto';
import {LiveHub} from './live.js';

const ROOM='22222222-2222-4222-8222-222222222222',WORKSPACE='11111111-1111-4111-8111-111111111111';
const AGENT='b'.repeat(64),HUMAN='a'.repeat(64);
let database:PgliteDatabase,live:LiveHub,presence:ConnectionPresence;
beforeEach(async()=>{
  database=await migratedDatabase();live=new LiveHub();
  await database.query(`INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Owner',NULL),($2,'agent','Bee','bee')`,[HUMAN,AGENT]);
  await database.query('INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)',[AGENT,HUMAN]);
  await database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Hive')`,[WORKSPACE]);
  await database.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'General')`,[ROOM,WORKSPACE]);
  await database.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
    VALUES($1,$2,$3,'member'),($1,NULL,$3,'member'),($1,$2,$4,'owner')`,[WORKSPACE,ROOM,AGENT,HUMAN]);
  presence=new ConnectionPresence(database,live);
});
afterEach(async()=>{await presence.stop();vi.restoreAllMocks();await database.close();});
const body=async()=>(await database.query<{body:Record<string,unknown>}>(`SELECT body FROM live_outputs WHERE agent_id=$1 AND kind='presence' LIMIT 1`,[AGENT])).rows[0]?.body;
async function claimed(connectionId='connection'){
  const source={connectionId,epoch:await presence.claimConnection(AGENT,{connectionId})};
  const command=(await createAgentCommand(database,{roomId:ROOM,agentId:AGENT,sourceMessageId:null,reason:'system'}))!;
  await database.transaction(db=>claimAgentCommand(db,ROOM,AGENT,command.id,'generation',source));
  return {source,command};
}
it('hands a closed connection’s commands back to pending without ending their turns',async()=>{
  const {source,command}=await claimed();await presence.releaseConnection(AGENT,source.connectionId);
  expect((await database.query('SELECT state,generation_id,turn_owner_connection_id,lease_expires_at FROM agent_commands WHERE id=$1',[command.id])).rows)
    .toEqual([{state:'pending',generation_id:null,turn_owner_connection_id:null,lease_expires_at:null}]);
  expect((await database.query('SELECT status FROM agent_turns WHERE request_id=$1',[command.turn_request_id])).rows).toEqual([{status:'working'}]);
  expect(await body()).toMatchObject({status:'offline'});
});
it('a late close of an older socket cannot release the current owner',async()=>{
  await presence.claimConnection(AGENT,{connectionId:'old'});const {source,command}=await claimed('new');
  await presence.releaseConnection(AGENT,'old');
  expect((await database.query('SELECT state,turn_owner_connection_id FROM agent_commands WHERE id=$1',[command.id])).rows)
    .toEqual([{state:'claimed',turn_owner_connection_id:source.connectionId}]);
  expect(await body()).toMatchObject({status:'online',held:true,connectionId:'new'});
});
it('a new authenticated connection returns the displaced owner’s commands to pending',async()=>{
  const {command}=await claimed('old');await presence.claimConnection(AGENT,{connectionId:'new'});
  await vi.waitFor(async()=>expect((await database.query('SELECT state FROM agent_commands WHERE id=$1',[command.id])).rows).toEqual([{state:'pending'}]));
  expect((await database.query('SELECT status FROM agent_turns WHERE request_id=$1',[command.turn_request_id])).rows).toEqual([{status:'working'}]);
});
it('turn age and incoming messages never arm a presence or stalled-turn watchdog',async()=>{
  const {command}=await claimed();const schedule=vi.spyOn(globalThis,'setTimeout');
  await database.query(`UPDATE agent_turns SET created_at=now()-interval '1 day' WHERE request_id=$1`,[command.turn_request_id]);
  live.publish({type:'invalidate',roomId:ROOM,reason:'postgres:agent_turns',requestId:command.turn_request_id,agentId:AGENT});
  live.publish({type:'invalidate',roomId:ROOM,reason:'message'});await Promise.resolve();
  expect(schedule).not.toHaveBeenCalled();
  expect((await database.query('SELECT state FROM agent_commands WHERE id=$1',[command.id])).rows).toEqual([{state:'claimed'}]);
});
it('retains one aggregate server lease while actual connections are held',async()=>{
  const release=presence.holdServerConnection();await presence.renewLease();
  expect((await database.query('SELECT 1 FROM live_server_instances WHERE instance_id=$1',[presence.instanceId])).rowCount).toBe(1);
  release();release();await presence.stop();
});
it('actual authenticated evidence advances the current lifecycle without a timer',async()=>{
  await presence.announce(ROOM,AGENT,{lifecycleId:'boot',releaseVersion:'v1.0.0'});const before=await body();
  await presence.evidence(ROOM,AGENT);await presence.evidence(ROOM,AGENT);
  expect(await body()).toMatchObject({lifecycleId:'boot',releaseVersion:'v1.0.0',status:'online'});
  expect(Number((await body())?.observedAt)).toBeGreaterThan(Number(before?.observedAt));
});
it('evidence merges with a concurrent lifecycle announcement',async()=>{
  await presence.announce(ROOM,AGENT,{lifecycleId:'boot-1'});
  await Promise.all([presence.announce(ROOM,AGENT,{lifecycleId:'boot-2',releaseVersion:'v2.0.0'}),recordAgentEvidence(database,live,ROOM,AGENT)]);
  expect(await body()).toMatchObject({lifecycleId:'boot-2',releaseVersion:'v2.0.0',status:'online'});
});
it('bounded observation timestamps require no maintenance timer',()=>{
  const times=new RecentIdentityTimes(2,100);times.set('one',1);times.set('two',2);times.set('three',3);
  expect(times.size).toBe(2);expect(times.get('one')).toBeUndefined();times.set('four',200);expect(times.size).toBe(1);
});

it('registration recovers only its agent’s ownerless helper claims once and preserves live MCP claims',async()=>{
  const legacy=(await createAgentCommand(database,{roomId:ROOM,agentId:AGENT,sourceMessageId:null,reason:'system'}))!;
  await database.transaction(db=>claimAgentCommand(db,ROOM,AGENT,legacy.id,'pre-upgrade-helper'));
  const peer='c'.repeat(64);
  await database.query(`INSERT INTO identities(id,kind,name) VALUES($1,'agent','Other helper')`,[peer]);
  await database.query('INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)',[peer,HUMAN]);
  await database.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
    VALUES($1,$2,$3,'member'),($1,NULL,$3,'member')`,[WORKSPACE,ROOM,peer]);
  const other=(await createAgentCommand(database,{roomId:ROOM,agentId:peer,sourceMessageId:null,reason:'system'}))!;
  await database.transaction(db=>claimAgentCommand(db,ROOM,peer,other.id,'other-helper'));
  const mcpRooms=[randomUUID(),randomUUID()];
  for(const roomId of mcpRooms){
    await database.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'MCP')`,[roomId,WORKSPACE]);
    await database.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
      VALUES($1,$2,$3,'member')`,[WORKSPACE,roomId,AGENT]);
  }
  // Explicit app calls and app-claimed orders identify MCP ownership differently.
  const mcpCall=await createClaimedMcpAgentCommand(database,{roomId:mcpRooms[0]!,agentId:AGENT,generationId:'older-app-call'});
  const mcpOrder=(await createAgentCommand(database,{roomId:mcpRooms[1]!,agentId:AGENT,sourceMessageId:null,reason:'order',
    privatePayload:{kind:'order',text:'Live app order',authorId:HUMAN,fromRoomId:ROOM}}))!;
  await database.transaction(db=>claimAgentCommand(db,mcpRooms[1]!,AGENT,mcpOrder.id,'mcp:live-order'));
  const untouched=async()=>(await database.query(`SELECT id,xmin::text version,state,generation_id,claimed_at,lease_expires_at
    FROM agent_commands WHERE id=ANY($1::text[]) ORDER BY id`,[[other.id,mcpCall,mcpOrder.id]])).rows;
  const before=await untouched();
  await presence.claimConnection(AGENT,{connectionId:'upgraded'});
  expect((await database.query(`SELECT state,generation_id,claimed_at,lease_expires_at,turn_owner_connection_id,turn_owner_epoch
    FROM agent_commands WHERE id=$1`,[legacy.id])).rows).toEqual([{state:'pending',generation_id:null,claimed_at:null,
      lease_expires_at:null,turn_owner_connection_id:null,turn_owner_epoch:null}]);
  expect((await database.query('SELECT status FROM agent_turns WHERE request_id=$1',[legacy.turn_request_id])).rows)
    .toEqual([{status:'working'}]);
  expect(await untouched()).toEqual(before);
  const version=(await database.query('SELECT xmin::text version FROM agent_commands WHERE id=$1',[legacy.id])).rows;
  const source={connectionId:'again',epoch:await presence.claimConnection(AGENT,{connectionId:'again'})};
  expect((await database.query('SELECT xmin::text version FROM agent_commands WHERE id=$1',[legacy.id])).rows).toEqual(version);
  await database.transaction(db=>claimAgentCommand(db,ROOM,AGENT,legacy.id,'upgraded-generation',source));
  await presence.releaseConnection(AGENT,source.connectionId);
  expect(await untouched()).toEqual(before);
});
