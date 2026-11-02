import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { describe,expect,it } from 'vitest';
import type { CommandActivationInput } from '@beeline/api-contract/helper-activation';
import { PostgresDatabase,type SqlDatabase } from './database.js';
import { HELPER_ACTIVATION_SCHEMA } from './helper-activation-schema.js';
import { captureCommandActivation,fenceCommandActivationEnqueue,type ActivationReader } from './helper-activation.js';
const url=process.env.BEELINE_COMMAND_TEST_POSTGRES_URL;
if(url&&!['localhost','127.0.0.1','[::1]'].includes(new URL(url).hostname))throw new Error('Activation proofs require isolated loopback PostgreSQL');
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return {resolve,promise};};
const agent='a'.repeat(64),workspace='11111111-1111-4111-8111-111111111111',room='22222222-2222-4222-8222-222222222222';
const input:CommandActivationInput={agentId:agent,workspaceId:workspace,roomId:room,commandId:'claimed-command',generationId:'generation',source:{connectionId:'connection',epoch:1}};
describe.skipIf(!url)('actual PostgreSQL coherent activation and authority contention',()=>{
  it('keeps one RR database cut and waits behind a real source revocation before final enqueue',async()=>{
    const schema='activation_'+randomUUID().replaceAll('-',''),admin=new Pool({connectionString:url,max:1});await admin.query(`CREATE SCHEMA ${schema}`);
    const config={connectionString:url,options:`-c search_path=${schema},public`,max:3};
    const left=new PostgresDatabase('',3,{pool:new Pool(config)}),right=new PostgresDatabase('',3,{pool:new Pool(config)});
    const cutRead=deferred(),resumeCut=deferred(),revokeHeld=deferred(),commitRevoke=deferred(),fenceEntered=deferred();
    let capturing:Promise<unknown>|undefined,revoking:Promise<unknown>|undefined,fencing:Promise<unknown>|undefined;
    try{
      await left.query(`CREATE TABLE workspaces(id uuid PRIMARY KEY,visibility text);
        CREATE TABLE agents(agent_id text PRIMARY KEY,owner_id text,fast_mode boolean NOT NULL DEFAULT false);
        CREATE TABLE identities(id text PRIMARY KEY,name text);
        CREATE TABLE rooms(id uuid PRIMARY KEY,workspace_id uuid,parent_id uuid,archived_at timestamptz);
        CREATE TABLE memberships(workspace_id uuid,room_id uuid,identity_id text,role text,removed_at timestamptz);
        CREATE TABLE agent_connections(agent_id text PRIMARY KEY,connection_id text,epoch bigint,released_at timestamptz);
        CREATE TABLE agent_commands(id text PRIMARY KEY,room_id uuid,agent_id text,generation_id text,state text,lease_expires_at timestamptz);
        CREATE TABLE agent_grants(id uuid PRIMARY KEY,workspace_id uuid,room_id uuid,agent_id text,app_id uuid,status text);
        CREATE TABLE workspace_apps(id uuid PRIMARY KEY,workspace_id uuid,owner_identity_id text);
        CREATE TABLE workspace_connectors(id uuid PRIMARY KEY,workspace_id uuid,owner_identity_id text);
        CREATE TABLE corner_facts(corner_id uuid);CREATE TABLE corner_brief_revisions(corner_id uuid);
        CREATE TABLE corner_merge_holds(corner_id uuid);CREATE TABLE corner_merge_approvals(corner_id uuid);CREATE TABLE free_agents(agent_id text);`);
      await left.query(HELPER_ACTIVATION_SCHEMA);
      await left.query(`INSERT INTO workspaces VALUES($1,'private')`,[workspace]);
      await left.query('INSERT INTO agents(agent_id) VALUES($1)',[agent]);
      await left.query('INSERT INTO rooms(id,workspace_id) VALUES($1,$2)',[room,workspace]);
      await left.query(`INSERT INTO memberships VALUES($1,NULL,$2,'member',NULL),($1,$3,$2,'member',NULL)`,[workspace,agent,room]);
      await left.query(`INSERT INTO agent_connections VALUES($1,'connection',1,NULL)`,[agent]);
      await left.query(`INSERT INTO agent_commands VALUES($1,$2,$3,'generation','claimed',now()+interval '1 day')`,[input.commandId,room,agent]);
      await left.query(`INSERT INTO agent_grants(id,workspace_id,room_id,agent_id,status) VALUES('33333333-3333-4333-8333-333333333333',$1,$2,$3,'approved')`,[workspace,room,agent]);
      const read:ActivationReader=async db=>{
        const fast=(await db.query<{fast_mode:boolean}>('SELECT fast_mode FROM agents WHERE agent_id=$1',[agent])).rows[0]!.fast_mode;
        return {configuration:{fastMode:fast,commands:[],yoloMode:false,isReviewer:false},roster:{members:[]},grants:{grants:[]},repository:{resolution:'none'}};
      };
      const captured=captureCommandActivation(left,input,async(db,command,corner)=>{
        const before=await read(db,command,corner);cutRead.resolve();await resumeCut.promise;
        const after=await read(db,command,corner);expect(after.configuration.fastMode).toBe(before.configuration.fastMode);return after;
      });capturing=captured;await cutRead.promise;
      await right.query('UPDATE agents SET fast_mode=true WHERE agent_id=$1',[agent]);resumeCut.resolve();
      const oldCut=await captured;expect(oldCut.configuration.fastMode).toBe(false);
      const delivered:unknown[]=[];expect(await fenceCommandActivationEnqueue(left,oldCut,value=>{delivered.push(value);})).toBe(false);expect(delivered).toEqual([]);
      const current=await captureCommandActivation(left,input,read);expect(current.configuration.fastMode).toBe(true);
      revoking=right.transaction(async db=>{await db.query(`UPDATE agent_grants SET status='revoked'`);revokeHeld.resolve();await commitRevoke.promise;});
      await revokeHeld.promise;
      const observed:SqlDatabase={query:(sql,values)=>left.query(sql,values),transaction:work=>left.transaction(db=>work({
        transaction:nested=>db.transaction(nested),query:(sql,values)=>{
          const pending=db.query(sql,values);if(sql.includes('FROM helper_activation_authority')&&sql.includes('FOR SHARE'))fenceEntered.resolve();return pending;
        },
      }))};
      fencing=fenceCommandActivationEnqueue(observed,current,value=>{delivered.push(value);});
      await fenceEntered.promise;expect(delivered).toEqual([]);commitRevoke.resolve();await revoking;expect(await fencing).toBe(false);expect(delivered).toEqual([]);
      const newest=await captureCommandActivation(left,input,read);
      await right.query(`UPDATE agent_commands SET generation_id='replacement' WHERE id=$1`,[input.commandId]);
      await expect(fenceCommandActivationEnqueue(left,newest,value=>{delivered.push(value);})).rejects.toThrow('command ownership changed');expect(delivered).toEqual([]);
    }finally{
      resumeCut.resolve();commitRevoke.resolve();await Promise.allSettled([capturing,revoking,fencing].filter((value):value is Promise<unknown>=>value!==undefined));
      await Promise.all([left.close(),right.close()]);await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();
    }
  },20000);
});
