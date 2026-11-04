import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import { PostgresDatabase, type SqlDatabase } from './database.js';
import { DaemonService } from './daemon-service.js';
import { DURABLE_LIVE_SCHEMA } from './durable-live.js';
import { LiveHub } from './live.js';
import { MEMBERSHIP_AUTHORITY_SCHEMA } from './membership-authority-schema.js';
import { TURN_OWNERSHIP_SCHEMA } from './turn-ownership.js';
import { lockCornerLifecycle } from './corner-lifecycle.js';
import { cancelCornerAgentCommands } from './corner-close.js';

const url=process.env.BEELINE_COMMAND_TEST_POSTGRES_URL;
if(url&&!['127.0.0.1','localhost','[::1]'].includes(new URL(url).hostname))
  throw new Error('Turn authority proofs require isolated loopback PostgreSQL');
const room='11111111-1111-4111-8111-111111111111',workspace='22222222-2222-4222-8222-222222222222';
const source={connectionId:'registered-source',epoch:1};
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>{resolve=done;});return {promise,resolve};}
async function blocked(admin:Pool,pid:number){
  // Fixture synchronization against one admitted, nonempty row-lock obligation.
  for(let attempt=0;attempt<200;attempt++){
    if((await admin.query<{blocked:boolean}>('SELECT cardinality(pg_blocking_pids($1))>0 blocked',[pid])).rows[0]!.blocked)return;
    await new Promise(resolve=>setTimeout(resolve,5));
  }
  throw new Error('Expected current authority writer to wait behind final enqueue');
}
describe.skipIf(!url)('real PostgreSQL owned control current authority',()=>{
  it('fences actual effects and control enqueue against current revocation, replacement and lease expiry',async()=>{
    const schema='turn_authority_'+randomUUID().replaceAll('-',''),admin=new Pool({connectionString:url,max:1});
    await admin.query(`CREATE SCHEMA ${schema}`);
    const config={connectionString:url,options:`-c search_path=${schema},public`,max:2};
    const reader=new PostgresDatabase('',2,{pool:new Pool(config)}),writer=new PostgresDatabase('',2,{pool:new Pool(config)});
    let gate:ReturnType<typeof deferred<void>>|undefined,entered:ReturnType<typeof deferred<void>>|undefined;
    let pause:'before-authority'|'before-effect'|'after-command'|undefined;
    let lifecyclePid:ReturnType<typeof deferred<number>>|undefined;
    let authorityPid:ReturnType<typeof deferred<number>>|undefined;
    const archiveAllowed=deferred<void>();
    const closeRollbackAllowed=deferred<void>();
    let pending:Promise<unknown>|undefined,competing:Promise<unknown>|undefined,error:unknown;
    const frames:string[]=[];
    try{
      await reader.query(`CREATE TABLE workspaces(id uuid PRIMARY KEY);
        CREATE TABLE rooms(id uuid PRIMARY KEY,workspace_id uuid,parent_id uuid,archived_at timestamptz,
          reviewer_agent_id text,reviewer_fallback_ids text[] DEFAULT ARRAY[]::text[]);
        CREATE TABLE memberships(workspace_id uuid,room_id uuid,identity_id text,role text,removed_at timestamptz);
        CREATE VIEW room_access AS
          SELECT member.* FROM memberships member WHERE member.room_id IS NULL OR EXISTS(
            SELECT 1 FROM rooms surface WHERE surface.id=member.room_id AND surface.parent_id IS NULL)
          UNION ALL SELECT corner.workspace_id,corner.id,parent.identity_id,parent.role,parent.removed_at
            FROM rooms corner JOIN memberships parent ON parent.room_id=corner.parent_id
            WHERE corner.parent_id IS NOT NULL AND corner.archived_at IS NULL;
        CREATE TABLE identities(id text PRIMARY KEY,name text);
        CREATE TABLE corner_facts(corner_id uuid PRIMARY KEY,reviewer_agent_id text);
        CREATE TABLE voice_orders(source_message_id text,agent_id text);
        CREATE TABLE agent_commands(id text PRIMARY KEY,room_id uuid,agent_id text,turn_request_id text,source_message_id text,
          action text,state text,generation_id text,lease_expires_at timestamptz,private_payload jsonb,created_at timestamptz DEFAULT now());
        CREATE TABLE agent_turns(room_id uuid,request_id text,agent_id text,generation_id text,status text,created_at timestamptz DEFAULT now());
        CREATE TABLE agents(agent_id text PRIMARY KEY,selected_model text);
        CREATE TABLE messages(id text PRIMARY KEY,room_id uuid,author_id text,text text,presentation text,request_id text,
          activity jsonb,agent_model text,created_at timestamptz DEFAULT now());
        CREATE TABLE agent_connections(agent_id text PRIMARY KEY,connection_id text,epoch bigint,instance_id text,released_at timestamptz);
        CREATE TABLE live_server_instances(instance_id text PRIMARY KEY,renewed_at timestamptz);`);
      await reader.query(DURABLE_LIVE_SCHEMA);await reader.query(MEMBERSHIP_AUTHORITY_SCHEMA);await reader.query(TURN_OWNERSHIP_SCHEMA);
      await reader.query(`INSERT INTO workspaces VALUES($1);`,[workspace]);
      await reader.query(`INSERT INTO rooms(id,workspace_id) VALUES($1,$2)`,[room,workspace]);
      await reader.query(`INSERT INTO memberships VALUES($1,NULL,'agent','member',NULL),($1,$2,'agent','member',NULL)`,[workspace,room]);
      await reader.query(`INSERT INTO live_server_instances VALUES('owner-server',clock_timestamp());
        INSERT INTO agent_connections VALUES('agent','registered-source',1,'owner-server',NULL);`);
      await reader.query(`INSERT INTO agent_commands(id,room_id,agent_id,turn_request_id,action,state,generation_id,turn_owner_connection_id,turn_owner_epoch)
        VALUES('command',$1,'agent','request','input','claimed','generation','registered-source',1)`,[room]);
      await reader.query(`INSERT INTO agent_turns(room_id,request_id,agent_id,generation_id,status)
        VALUES($1,'request','agent','generation','working')`,[room]);
      const wrap=(tx:SqlDatabase):SqlDatabase=>({
        transaction:nested=>tx.transaction(inner=>nested(wrap(inner))),query:async(sql,args)=>{
          if(lifecyclePid&&sql.includes('pg_advisory_xact_lock(hashtext($1))')){
            lifecyclePid.resolve(Number((await tx.query<{pid:number}>('SELECT pg_backend_pid() pid')).rows[0]!.pid));
          }
          if(authorityPid&&sql.includes('pg_advisory_xact_lock_shared'))
            authorityPid.resolve(Number((await tx.query<{pid:number}>('SELECT pg_backend_pid() pid')).rows[0]!.pid));
          if(gate&&((pause==='before-authority'&&sql.includes('pg_advisory_xact_lock_shared'))||
              (pause==='before-effect'&&sql.includes('INSERT INTO messages(')))){
            pause=undefined;entered!.resolve();await gate.promise;
          }
          const result=await tx.query(sql,args);
          if(pause==='after-command'&&sql.includes('SELECT command.id FROM agent_commands command')&&gate){
            pause=undefined;entered!.resolve();await gate.promise;
          }
          return result;
        },
      });
      const observed:SqlDatabase={query:(sql,args)=>reader.query(sql,args),transaction:work=>reader.transaction(tx=>work(wrap(tx)))};
      const daemon=new DaemonService(observed,new LiveHub()),input={roomId:room,commandId:'command',generationId:'generation'};
      const effect={roomId:room,requestId:'request',generationId:'generation',activity:[]};
      // Revoke after execute's initial access read, before its real transaction
      // authority fence. The actual production activity writer must do no DML.
      gate=deferred<void>();entered=deferred<void>();pause='before-authority';
      pending=daemon.execute('postAgentActivity',effect,'agent');
      void pending.catch(reason=>{error=reason;entered!.resolve();});await entered.promise;if(error)throw error;
      await writer.query(`UPDATE memberships SET removed_at=clock_timestamp() WHERE room_id=$1 AND identity_id='agent'`,[room]);
      gate.resolve();await expect(pending).rejects.toThrow();gate=undefined;
      expect((await reader.query('SELECT * FROM messages')).rowCount).toBe(0);
      await writer.query(`UPDATE memberships SET removed_at=NULL WHERE room_id=$1 AND identity_id='agent'`,[room]);
      // Revoke after each control's initial access read too, before its claim
      // or stop-ack transaction can acquire source rows or modify commands.
      for(const operation of ['claimAgentCommand','acknowledgeAgentCommand'] as const){
        gate=deferred<void>();entered=deferred<void>();pause='before-authority';error=undefined;
        pending=daemon.execute(operation,input,'agent',source);
        void pending.catch(reason=>{error=reason;entered!.resolve();});await entered.promise;if(error)throw error;
        await writer.query(`UPDATE memberships SET removed_at=clock_timestamp() WHERE room_id=$1 AND identity_id='agent'`,[room]);
        gate.resolve();await expect(pending).rejects.toThrow();gate=undefined;
        expect((await reader.query('SELECT * FROM messages')).rowCount).toBe(0);
        await writer.query(`UPDATE memberships SET removed_at=NULL WHERE room_id=$1 AND identity_id='agent'`,[room]);
      }

      gate=deferred<void>();entered=deferred<void>();pause='before-effect';error=undefined;
      pending=daemon.execute('postAgentActivity',effect,'agent');
      void pending.catch(reason=>{error=reason;entered!.resolve();});await entered.promise;if(error)throw error;
      const effectPid=deferred<number>();
      competing=writer.transaction(async tx=>{
        effectPid.resolve(Number((await tx.query<{pid:number}>('SELECT pg_backend_pid() pid')).rows[0]!.pid));
        await tx.query(`UPDATE memberships SET removed_at=clock_timestamp() WHERE room_id=$1 AND identity_id='agent'`,[room]);
      });
      await blocked(admin,await effectPid.promise);
      expect((await reader.query('SELECT * FROM messages')).rowCount).toBe(0);
      gate.resolve();await pending;await competing;gate=undefined;
      expect((await reader.query('SELECT * FROM messages')).rowCount).toBe(1);
      await writer.query(`UPDATE memberships SET removed_at=NULL WHERE room_id=$1 AND identity_id='agent'`,[room]);

      const progressBeforeExpiry=(await reader.query('SELECT xmin::text version,created_at::text FROM agent_turns')).rows;
      gate=deferred<void>();entered=deferred<void>();pause='before-effect';error=undefined;
      pending=daemon.execute('postAgentActivity',effect,'agent');
      void pending.catch(reason=>{error=reason;entered!.resolve();});await entered.promise;if(error)throw error;
      await writer.query(`UPDATE live_server_instances SET renewed_at=clock_timestamp()-interval '91 seconds' WHERE instance_id='owner-server'`);
      gate.resolve();await expect(pending).rejects.toThrow('authority expired before commit');gate=undefined;
      expect((await reader.query('SELECT * FROM messages')).rowCount).toBe(1);
      expect((await reader.query('SELECT * FROM turn_owned_effect_fences')).rowCount).toBe(0);
      expect((await reader.query('SELECT xmin::text version,created_at::text FROM agent_turns')).rows).toEqual(progressBeforeExpiry);
      await writer.query(`UPDATE live_server_instances SET renewed_at=clock_timestamp() WHERE instance_id='owner-server'`);
      await writer.query(`UPDATE memberships SET removed_at=clock_timestamp() WHERE room_id IS NULL AND identity_id='agent'`);
      await expect(daemon.execute('postAgentActivity',effect,'agent')).rejects.toThrow();
      expect((await reader.query('SELECT * FROM messages')).rowCount).toBe(1);
      await writer.query(`UPDATE memberships SET removed_at=NULL WHERE room_id IS NULL AND identity_id='agent'`);

      gate=deferred<void>();entered=deferred<void>();
      pause='after-command';error=undefined;
      pending=daemon.fenceOwnedTurnReply('agent',source,input,()=>frames.push('admitted-before-revoke'),true);
      void pending.catch(reason=>{error=reason;entered!.resolve();});await entered.promise;if(error)throw error;
      const pid=deferred<number>();
      competing=writer.transaction(async tx=>{
        pid.resolve(Number((await tx.query<{pid:number}>('SELECT pg_backend_pid() pid')).rows[0]!.pid));
        await tx.query(`UPDATE memberships SET removed_at=clock_timestamp() WHERE room_id=$1 AND identity_id='agent'`,[room]);
      });
      await blocked(admin,await pid.promise);expect(frames).toEqual([]);
      gate.resolve();await pending;await competing;gate=undefined;
      expect(frames).toEqual(['admitted-before-revoke']);
      await expect(daemon.fenceOwnedTurnReply('agent',source,input,()=>frames.push('must-not-send-revoked'),true)).rejects.toThrow();
      expect(frames).toHaveLength(1); // The aggregate lease is still fresh.

      await writer.query(`UPDATE memberships SET removed_at=NULL WHERE room_id=$1 AND identity_id='agent'`,[room]);
      gate=deferred<void>();entered=deferred<void>();error=undefined;
      pause='after-command';
      pending=daemon.fenceOwnedTurnReply('agent',source,input,()=>frames.push('must-not-send-expired'),true);
      void pending.catch(reason=>{error=reason;entered!.resolve();});await entered.promise;if(error)throw error;
      await writer.query(`UPDATE live_server_instances SET renewed_at=clock_timestamp()-interval '91 seconds' WHERE instance_id='owner-server'`);
      gate.resolve();await expect(pending).rejects.toThrow('source changed');gate=undefined;expect(frames).toHaveLength(1);

      await writer.query(`UPDATE live_server_instances SET renewed_at=clock_timestamp() WHERE instance_id='owner-server'`);
      gate=deferred<void>();entered=deferred<void>();error=undefined;
      pause='after-command';
      pending=daemon.fenceOwnedTurnReply('agent',source,input,()=>frames.push('admitted-before-replacement'),true);
      void pending.catch(reason=>{error=reason;entered!.resolve();});await entered.promise;if(error)throw error;
      const replacementPid=deferred<number>();
      competing=writer.transaction(async tx=>{
        replacementPid.resolve(Number((await tx.query<{pid:number}>('SELECT pg_backend_pid() pid')).rows[0]!.pid));
        await tx.query(`UPDATE agent_connections SET connection_id='replacement',epoch=2 WHERE agent_id='agent'`);
      });
      await blocked(admin,await replacementPid.promise);expect(frames).toHaveLength(1);
      gate.resolve();await pending;await competing;gate=undefined;
      await expect(daemon.fenceOwnedTurnReply('agent',source,input,()=>frames.push('must-not-send-old-owner'),true)).rejects.toThrow('source changed');
      expect(frames).toEqual(['admitted-before-revoke','admitted-before-replacement']);

      // The account/close writer's real ordering is lifecycle -> command/Room
      // authority. Start an actual failed-corner receipt while that writer
      // holds lifecycle, then let its real Room archival trigger run. Taking
      // shared authority before waiting for lifecycle creates a deadlock here.
      const parent='33333333-3333-4333-8333-333333333333';
      await writer.query(`INSERT INTO rooms(id,workspace_id) VALUES($1,$2)`,[parent,workspace]);
      await writer.query(`INSERT INTO memberships VALUES($1,$2,'agent','member',NULL)`,[workspace,parent]);
      await writer.query(`UPDATE rooms SET parent_id=$2 WHERE id=$1`,[room,parent]);
      await writer.query(`INSERT INTO agent_commands(id,room_id,agent_id,turn_request_id,action,state,generation_id,turn_owner_connection_id,turn_owner_epoch)
        VALUES('lifecycle-command',$1,'agent','lifecycle-request','input','claimed','lifecycle-generation','replacement',2)`,[room]);
      const lifecycleHeld=deferred<void>();lifecyclePid=deferred<number>();
      competing=writer.transaction(async tx=>{
        await lockCornerLifecycle(tx,room);lifecycleHeld.resolve();await archiveAllowed.promise;
        await tx.query(`UPDATE rooms SET archived_at=clock_timestamp() WHERE id=$1`,[room]);
      });
      void competing.catch(()=>lifecycleHeld.resolve());await lifecycleHeld.promise;
      pending=daemon.execute('postAgentTurnReceipt',{agentId:'agent',roomId:room,requestId:'lifecycle-request',
        generationId:'lifecycle-generation',status:'failed',reason:'Synthetic harness failure'},'agent',{connectionId:'replacement',epoch:2});
      let receiptError:unknown;
      void pending.catch(reason=>{receiptError=reason;lifecyclePid!.resolve(0);});
      const receiptPid=await lifecyclePid.promise;if(receiptError)throw receiptError;expect(receiptPid).toBeGreaterThan(0);
      await blocked(admin,receiptPid);archiveAllowed.resolve();await competing;
      await expect(pending).rejects.toThrow('access denied');
      expect((await reader.query('SELECT * FROM messages')).rowCount).toBe(1);
      expect((await reader.query('SELECT * FROM turn_owned_effect_fences')).rowCount).toBe(0);

      await writer.query(`UPDATE rooms SET archived_at=NULL WHERE id=$1`,[room]);
      lifecyclePid=undefined;
      const commandHeld=deferred<void>(),closeRollback=new Error('Synthetic close rollback');
      let closeError:unknown;
      // Enter the actual common cancellation boundary and retain its first
      // nonempty command lock. Roll back deliberately after the real archival
      // trigger, before cancellation's later stop-delivery business work.
      competing=writer.transaction(async tx=>{
        await lockCornerLifecycle(tx,room);
        await cancelCornerAgentCommands({transaction:nested=>tx.transaction(nested),query:async(sql,args)=>{
          const result=await tx.query(sql,args);
          if(sql.includes('SELECT * FROM agent_commands')&&sql.includes('FOR UPDATE')){
            expect(result.rowCount).toBeGreaterThan(0);commandHeld.resolve();await closeRollbackAllowed.promise;
            await tx.query(`UPDATE rooms SET archived_at=clock_timestamp() WHERE id=$1`,[room]);
            throw closeRollback;
          }
          return result;
        }},room);
      });
      const closed=competing.catch(reason=>{closeError=reason;commandHeld.resolve();});await commandHeld.promise;if(closeError)throw closeError;
      authorityPid=deferred<number>();
      pending=daemon.fenceOwnedTurnReply('agent',{connectionId:'replacement',epoch:2},
        {roomId:room,commandId:'lifecycle-command',generationId:'lifecycle-generation'},()=>frames.push('current-after-close-rollback'),true);
      void pending.catch(()=>authorityPid!.resolve(0));
      const enqueuePid=await authorityPid.promise;expect(enqueuePid).toBeGreaterThan(0);await blocked(admin,enqueuePid);
      expect((await admin.query<{wait_event:string}>('SELECT wait_event FROM pg_stat_activity WHERE pid=$1',[enqueuePid])).rows[0]!.wait_event).toBe('advisory');
      expect(frames).toHaveLength(2);closeRollbackAllowed.resolve();await closed;expect(closeError).toBe(closeRollback);
      await pending;expect(frames).toEqual(['admitted-before-revoke','admitted-before-replacement','current-after-close-rollback']);
    }finally{
      gate?.resolve();archiveAllowed.resolve();closeRollbackAllowed.resolve();await Promise.allSettled([pending,competing].filter((work):work is Promise<unknown>=>work!==undefined));
      await Promise.all([reader.close(),writer.close()]);await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();
    }
  },20_000);
});
