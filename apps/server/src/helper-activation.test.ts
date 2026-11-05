import { afterAll,beforeAll,describe,expect,it,vi } from 'vitest';
import { DaemonService } from './daemon-service.js';
import { LiveHub } from './live.js';
import { migratedDatabase,type PgliteDatabase } from "../../../tests/helpers/server.js";
import { HELPER_ACTIVATION_SCHEMA } from './helper-activation-schema.js';
import { captureCommandActivation,fenceCommandActivationEnqueue } from './helper-activation.js';
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
});
