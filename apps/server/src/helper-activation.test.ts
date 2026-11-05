import { afterAll,beforeAll,describe,expect,it,vi } from 'vitest';
import { DaemonService } from './daemon-service.js';
import { LiveHub } from './live.js';
import { migratedDatabase,type PgliteDatabase } from './test-support.js';
import { HELPER_ACTIVATION_SCHEMA } from './helper-activation-schema.js';
import { captureCommandActivation,fenceCommandActivationEnqueue } from './helper-activation.js';
import { FREE_AGENT_REPOSITORY_GUIDE,FREE_AGENT_TURN_GUIDE } from './free-agents.js';
import type { CommandActivationInput } from '@beeline/api-contract/helper-activation';
const owner='1'.repeat(64),agent='2'.repeat(64);
const workspace='11111111-1111-4111-8111-111111111111',room='22222222-2222-4222-8222-222222222222';
const input:CommandActivationInput={agentId:agent,roomId:room,workspaceId:workspace,commandId:'activation-command',generationId:'activation-generation',source:{connectionId:'activation-source',epoch:1}};

describe('command-owned coherent activation context',()=>{
  let db:PgliteDatabase,daemon:DaemonService;
  beforeAll(async()=>{
    db=await migratedDatabase();await db.query(HELPER_ACTIVATION_SCHEMA);
    await db.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Synthetic owner'),($2,'agent','Synthetic agent')`,[owner,agent]);
    await db.query(`INSERT INTO agents(agent_id,owner_id,soul) VALUES($1,$2,'{"name":"Synthetic agent","instructions":"Synthetic setup"}')`,[agent,owner]);
    await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Activation proof')`,[workspace]);
    await db.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Room')`,[room,workspace]);
    await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,NULL,$2,'owner'),($1,$3,$2,'owner')`,[workspace,agent,room]);
    await db.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES('synthetic-source',$1,$2,'Synthetic command requester')`,[room,owner]);
    await db.query(`INSERT INTO agent_connections(agent_id,epoch,connection_id,instance_id) VALUES($1,1,'activation-source','proof')`,[agent]);
    await db.query(`INSERT INTO agent_commands(id,room_id,agent_id,source_message_id,turn_request_id,action,reason,root_command_id,
      root_source_message_id,agent_depth,state,generation_id,lease_expires_at)
      VALUES($1,$2,$3,NULL,'activation-turn','input','system',$1,'synthetic-source',0,'claimed',$4,now()+interval '1 day')`,
      [input.commandId,room,agent,input.generationId]);
    daemon=new DaemonService(db,new LiveHub());vi.stubEnv('BEELINE_NETWORK_ROUTER_V1','1');
  },60000);
  afterAll(async()=>{vi.unstubAllEnvs();await db.close();});
  it('uses real DB-only configuration/roster/grant/repository readers without durable setup writes',async()=>{
    const before=(await db.query(`SELECT (SELECT count(*) FROM live_journal)::text journal,
      (SELECT count(*) FROM agent_commands)::text commands,(SELECT revision::text FROM helper_activation_authority WHERE workspace_id=$1) revision`,[workspace])).rows;
    const snapshot=await daemon.readCommandActivation(input,agent);
    expect(snapshot).toMatchObject({v:1,...input,configuration:{soul:{instructions:'Synthetic setup'}},roster:{members:[{identityId:agent}]},grants:{grants:[]},repository:{resolution:'none'}});
    expect(snapshot.corner).toBeUndefined();
    expect((await db.query(`SELECT (SELECT count(*) FROM live_journal)::text journal,
      (SELECT count(*) FROM agent_commands)::text commands,(SELECT revision::text FROM helper_activation_authority WHERE workspace_id=$1) revision`,[workspace])).rows).toEqual(before);
    const delivered=vi.fn();expect(await fenceCommandActivationEnqueue(db,snapshot,delivered)).toBe(true);expect(delivered).toHaveBeenCalledWith(snapshot);
  });
  it('ignores usage/progress timestamps but refuses config mutation and membership revocation before enqueue',async()=>{
    const snapshot=await daemon.readCommandActivation(input,agent),delivered=vi.fn();
    await db.query(`UPDATE agents SET updated_at=clock_timestamp(),usage_snapshot='{"updatedAt":100,"windows":[]}' WHERE agent_id=$1`,[agent]);
    expect(await fenceCommandActivationEnqueue(db,snapshot,delivered)).toBe(true);
    await db.query(`UPDATE agents SET fast_mode=NOT fast_mode WHERE agent_id=$1`,[agent]);
    expect(await fenceCommandActivationEnqueue(db,snapshot,delivered)).toBe(false);expect(delivered).toHaveBeenCalledTimes(1);
    const fresh=await daemon.readCommandActivation(input,agent);
    await db.query(`UPDATE memberships SET removed_at=clock_timestamp() WHERE room_id=$1 AND identity_id=$2`,[room,agent]);
    expect(await fenceCommandActivationEnqueue(db,fresh,delivered)).toBe(false);expect(delivered).toHaveBeenCalledTimes(1);
    await db.query(`UPDATE memberships SET removed_at=NULL WHERE room_id=$1 AND identity_id=$2`,[room,agent]);
  });
  it('refuses stale command/connection identity, expiry, and setup writes in the read-only cut',async()=>{
    await expect(daemon.readCommandActivation({...input,generationId:'stale'},agent)).rejects.toThrow('command ownership');
    await expect(daemon.readCommandActivation({...input,source:{connectionId:'stale',epoch:1}},agent)).rejects.toThrow('source ownership');
    const snapshot=await daemon.readCommandActivation(input,agent),delivered=vi.fn();
    expect(await fenceCommandActivationEnqueue(db,{...snapshot,validUntil:snapshot.capturedAt-1},delivered)).toBe(false);
    await db.query(`UPDATE agent_commands SET root_source_message_id='changed-source' WHERE id=$1`,[input.commandId]);
    expect(await fenceCommandActivationEnqueue(db,snapshot,delivered)).toBe(false);
    await db.query(`UPDATE agent_commands SET root_source_message_id='synthetic-source' WHERE id=$1`,[input.commandId]);
    await expect(captureCommandActivation(db,input,async tx=>{await tx.query('UPDATE agents SET fast_mode=false');return snapshot;})).rejects.toThrow();
    expect(delivered).not.toHaveBeenCalled();
    vi.stubEnv('BEELINE_NETWORK_ROUTER_V1','0');
    await expect(daemon.readCommandActivation(input,agent)).rejects.toThrow('capability unavailable');
    vi.stubEnv('BEELINE_NETWORK_ROUTER_V1','1');
  });
  it('keeps held grant setup separate from the existing current grant effect gate',async()=>{
    const grantId='33333333-3333-4333-8333-333333333333';
    await db.query(`INSERT INTO agent_grants(id,agent_id,workspace_id,room_id,kind,target,reason,status,requested_by,decided_by)
      VALUES($1,$2,$3,$4,'mcp','synthetic-route','Synthetic setup grant','once',$5,$5)`,[grantId,agent,workspace,room,owner]);
    const snapshot=await daemon.readCommandActivation(input,agent);
    expect(snapshot.grants.grants.some(grant=>grant.grantId===grantId)).toBe(true);
    await db.query(`UPDATE agent_grants SET status='revoked' WHERE id=$1`,[grantId]);
    // A helper can still hold the old setup DTO; it cannot spend that DTO.
    expect(snapshot.grants.grants.some(grant=>grant.grantId===grantId)).toBe(true);
    await expect(daemon.execute('consumeAgentGrant',{grantId},agent)).rejects.toThrow('once grant not found');
    const delivered=vi.fn();expect(await fenceCommandActivationEnqueue(db,snapshot,delivered)).toBe(false);expect(delivered).not.toHaveBeenCalled();
  });
  it.each(['room','corner','repository-corner'] as const)('activates a source-less MCP delegation in a %s with its issuing owner as requester',async place=>{
    const roomId=place==='room'?room:place==='corner'?'44444444-4444-4444-8444-444444444444':'55555555-5555-4555-8555-555555555555';
    if(place!=='room'){
      await db.query(`INSERT INTO rooms(id,workspace_id,parent_id,name,repository_resolution,repository_key,repository_remote)
        VALUES($1,$2,$3,$4,$5,$6,$7)`,[roomId,workspace,room,place,place==='repository-corner'?'repository':'none',
        place==='repository-corner'?'synthetic/project':null,place==='repository-corner'?'https://github.com/synthetic/project.git':null]);
      await db.query(`INSERT INTO corner_facts(corner_id) VALUES($1)`,[roomId]);
    }
    const rootId=`mcp-root-${place}`,commandId=`mcp-delegation-${place}`,generationId=`mcp-generation-${place}`;
    // createClaimedMcpAgentCommand's no-mention shape: no message, payload or
    // human message. A legitimate order inherits the issuing agent's owner.
    await db.query(`INSERT INTO agent_commands(id,room_id,agent_id,turn_request_id,action,reason,root_command_id,root_source_message_id,agent_depth,state)
      VALUES($1,$2,$3,$1,'input','mcp_call',$1,$1,0,'complete')`,[rootId,room,agent]);
    await db.query(`INSERT INTO agent_commands(id,room_id,agent_id,turn_request_id,action,reason,root_command_id,parent_command_id,
      root_source_message_id,agent_depth,private_payload,state,generation_id,lease_expires_at)
      VALUES($1,$2,$3,$1,'input','order',$4,$4,$4,1,$5::jsonb,'claimed',$6,now()+interval '1 day')`,
      [commandId,roomId,agent,rootId,JSON.stringify({kind:'order',authorId:agent,fromRoomId:room,text:'Synthetic delegated task'}),generationId]);
    const activation={...input,roomId,commandId,generationId};
    const snapshot=await daemon.readCommandActivation(activation,agent);
    expect(snapshot).toMatchObject({configuration:{soul:{instructions:'Synthetic setup'}},repository:{resolution:place==='repository-corner'?'repository':'none'}});
    expect(snapshot.repository).toHaveProperty('repositoryOnboarding',true);
    if(place!=='room')expect(snapshot.corner).toMatchObject({cornerId:roomId,parentRoomId:room});
    const delivered=vi.fn();expect(await fenceCommandActivationEnqueue(db,snapshot,delivered)).toBe(true);
    expect(delivered).toHaveBeenCalledWith(snapshot);
    const context={roomId,requestId:commandId,generationId};
    expect(await daemon.execute('getRoomRepositoryState',context,agent)).toHaveProperty('repositoryOnboarding',true);
    // Resolving the owner does not invent their missing Workspace membership.
    await expect(daemon.execute('authorizeSquireCall',context,agent)).rejects.toThrow('resource owner access denied');
  });
  it('omits optional repository guidance from free-agent configuration with no verified requester',async()=>{
    await db.query(`INSERT INTO free_agents(agent_id,workspace_id,owner_id,sealed_keys) VALUES($1,$2,$3,'synthetic')`,[agent,workspace,owner]);
    try{
      expect((await daemon.readCommandActivation(input,agent)).configuration.soul?.instructions).toContain(FREE_AGENT_REPOSITORY_GUIDE);
      await db.query(`UPDATE agent_commands SET root_source_message_id=id WHERE id=$1`,[input.commandId]);
      const snapshot=await daemon.readCommandActivation(input,agent);
      expect(snapshot.configuration.soul?.instructions).toContain(FREE_AGENT_TURN_GUIDE);
      expect(snapshot.configuration.soul?.instructions).not.toContain(FREE_AGENT_REPOSITORY_GUIDE);
      expect(snapshot.repository).not.toHaveProperty('repositoryOnboarding');
    }finally{
      await db.query(`DELETE FROM free_agents WHERE agent_id=$1`,[agent]);
      await db.query(`UPDATE agent_commands SET root_command_id=id,root_source_message_id='synthetic-source' WHERE id=$1`,[input.commandId]);
    }
  });
});
