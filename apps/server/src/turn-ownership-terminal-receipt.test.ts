import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAgentCommand } from './agent-command.js';
import { DaemonService } from './daemon-service.js';
import { LiveHub } from './live.js';
import { migratedDatabase, type PgliteDatabase } from "../../../tests/helpers/server.js";

const room='11111111-1111-4111-8111-111111111111',workspace='22222222-2222-4222-8222-222222222222';
const owner='b'.repeat(64),agent='a'.repeat(64),source={connectionId:'receipt-owner',epoch:1};
const input={roomId:room,requestId:'receipt-request',generationId:'receipt-generation'};
describe('owned terminal receipt after committed requeue',()=>{
  let db:PgliteDatabase,daemon:DaemonService,commandId:string;
  beforeEach(async()=>{
    db=await migratedDatabase();daemon=new DaemonService(db,new LiveHub());
    await db.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Synthetic owner'),($2,'agent','Synthetic agent')`,[owner,agent]);
    await db.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`,[agent,owner]);
    await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Synthetic workspace')`,[workspace]);
    await db.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Synthetic Room')`,[room,workspace]);
    await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
      VALUES($1,NULL,$2,'owner'),($1,$3,$2,'owner'),($1,NULL,$4,'member'),($1,$3,$4,'member')`,[workspace,owner,room,agent]);
    await db.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'Synthetic request')`,[input.requestId,room,owner]);
    await db.query(`INSERT INTO live_server_instances(instance_id,renewed_at) VALUES('receipt-server',clock_timestamp());`);
    await db.query(`INSERT INTO agent_connections(agent_id,connection_id,epoch,instance_id)
      VALUES($1,$2,$3,'receipt-server')`,[agent,source.connectionId,source.epoch]);
    commandId=(await createAgentCommand(db,{roomId:room,agentId:agent,sourceMessageId:input.requestId,reason:'human_mention'}))!.id;
    await daemon.execute('claimAgentCommand',{roomId:room,commandId,generationId:input.generationId},agent,source);
    // The failed receipt's durable state: old terminal turn and immutable
    // generation binding remain, while the command reopens without an owner.
    await db.transaction(async tx=>{
      await tx.query(`UPDATE agent_turns SET status='failed' WHERE room_id=$1 AND agent_id=$2 AND request_id=$3`,[room,agent,input.requestId]);
      await tx.query(`UPDATE agent_commands SET state='pending',generation_id=NULL,
        turn_owner_connection_id=NULL,turn_owner_epoch=NULL,lease_expires_at=NULL WHERE id=$1`,[commandId]);
    });
  },60_000);
  afterEach(async()=>{await db?.close();});

  it('confirms only the exact committed terminal requeue without writes or implicit new claim',async()=>{
    const versions=async()=>({
      command:(await db.query(`SELECT xmin::text version,state,generation_id,turn_owner_connection_id FROM agent_commands WHERE id=$1`,[commandId])).rows,
      turn:(await db.query(`SELECT xmin::text version,status,generation_id FROM agent_turns WHERE room_id=$1 AND agent_id=$2`,[room,agent])).rows,
      binding:(await db.query(`SELECT xmin::text version,connection_id,connection_epoch FROM agent_command_generation_owners WHERE command_id=$1`,[commandId])).rows,
    });
    const before=await versions(),frames:string[]=[];
    await daemon.fenceOwnedTurnReply(agent,source,input,()=>frames.push('terminal-requeued'));
    await daemon.fenceOwnedTurnReply(agent,source,input,()=>frames.push('same-terminal-replayed'));
    expect(frames).toEqual(['terminal-requeued','same-terminal-replayed']);expect(await versions()).toEqual(before);
    await expect(daemon.fenceOwnedTurnReply(agent,source,{...input,commandId},()=>frames.push('must-not-confirm-claim'),true)).rejects.toThrow();
    expect((await db.query('SELECT * FROM turn_owned_effect_fences')).rowCount).toBe(0);
    await db.query(`UPDATE live_server_instances SET renewed_at=clock_timestamp()-interval '91 seconds' WHERE instance_id='receipt-server'`);
    await expect(daemon.fenceOwnedTurnReply(agent,source,input,()=>frames.push('must-not-confirm-expired'))).rejects.toThrow('source changed');
    await db.query(`UPDATE live_server_instances SET renewed_at=clock_timestamp() WHERE instance_id='receipt-server'`);
    await daemon.execute('claimAgentCommand',{roomId:room,commandId,generationId:'next-generation'},agent,source);
    await expect(daemon.fenceOwnedTurnReply(agent,source,input,()=>frames.push('must-not-confirm-new-generation'))).rejects.toThrow();
    expect(frames).toHaveLength(2);
  });

  it('refuses a missing terminal fact, non-cleared pending row, or a foreign current registration',async()=>{
    const frames:string[]=[];
    await db.query(`UPDATE agent_turns SET status='working' WHERE room_id=$1 AND agent_id=$2`,[room,agent]);
    await expect(daemon.fenceOwnedTurnReply(agent,source,input,()=>frames.push('must-not-confirm-working'))).rejects.toThrow();
    await db.query(`UPDATE agent_turns SET status='failed' WHERE room_id=$1 AND agent_id=$2`,[room,agent]);
    await db.query(`UPDATE agent_commands SET state='cancelled' WHERE id=$1`,[commandId]);
    await expect(daemon.fenceOwnedTurnReply(agent,source,input,()=>frames.push('must-not-confirm-nonpending'))).rejects.toThrow();
    await db.query(`UPDATE agent_commands SET state='pending' WHERE id=$1`,[commandId]);
    await db.query(`UPDATE agent_connections SET connection_id='foreign-current-source',epoch=2 WHERE agent_id=$1`,[agent]);
    await expect(daemon.fenceOwnedTurnReply(agent,{connectionId:'foreign-current-source',epoch:2},input,
      ()=>frames.push('must-not-confirm-foreign-binding'))).rejects.toThrow();
    expect(frames).toEqual([]);
  });
});
