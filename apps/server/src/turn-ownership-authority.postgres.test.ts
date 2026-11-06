import {randomUUID} from 'node:crypto';
import {Pool,type QueryResultRow} from 'pg';
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {migrate,PostgresDatabase,type SqlDatabase} from './database.js';
import {authorizeCommandOutput,claimAgentCommand,createAgentCommand} from './agent-command.js';
import {claimAgentConnection} from './connection-presence.js';
import {DaemonService} from './daemon-service.js';
import {LiveHub} from './live.js';
import {concurrentWriters} from './test-fixtures/concurrent-writers.js';
import {PhoneService} from './phone-service.js';
import {createPhoneOperationDispatcher} from './phone-operations.js';
import type {ServerOptions} from './server.js';
import {ROUTER_AUTHORITY_LOCK} from './router-authority-lock.js';
import {lockOwnedTurnRoomAccess,TURN_OWNERSHIP_SCHEMA} from './turn-ownership.js';
import {PRECEDING_OWNED_EFFECT_SCHEMA} from './test-fixtures/preceding-owned-effect.js';

const url=process.env.BEELINE_COMMAND_TEST_POSTGRES_URL;
if(url&&!['127.0.0.1','localhost','[::1]'].includes(new URL(url).hostname))throw new Error('Isolated loopback PostgreSQL required');
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(done=>resolve=done);return {promise,resolve};};
describe.skipIf(!url)('native current authority on real PostgreSQL',()=>{
  const name='native_authority_'+randomUUID().replaceAll('-',''),admin=new Pool({connectionString:url,max:1});
  const target=new URL(url??'postgresql://localhost/postgres');target.pathname='/'+name;
  const config={connectionString:target.toString(),max:1,options:'-c statement_timeout=8000'};
  const first=new PostgresDatabase('',1,{pool:new Pool(config)}),second=new PostgresDatabase('',1,{pool:new Pool(config)});
  const workspace=randomUUID(),person='1'.repeat(64),agent='2'.repeat(64);
  let owner:{connectionId:string;epoch:number};
  beforeAll(async()=>{
    await admin.query(`CREATE DATABASE ${name}`);await migrate(first);
    await first.query('CREATE TABLE authority_effects(id uuid PRIMARY KEY)');
    await first.query(`INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Owner','owner'),($2,'agent','Helper','helper')`,[person,agent]);
    await first.query('INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)',[agent,person]);
    await first.query(`INSERT INTO workspaces(id,name) VALUES($1,'Authority proof')`,[workspace]);
    await first.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,NULL,$2,'owner'),($1,NULL,$3,'member')`,[workspace,person,agent]);
    await first.query(`INSERT INTO live_server_instances(instance_id,renewed_at) VALUES('authority-proof',clock_timestamp())`);
    owner={connectionId:'authority-connection',epoch:await claimAgentConnection(first,new LiveHub(),agent,{},
      {connectionId:'authority-connection',instanceId:'authority-proof'})};
  },60_000);
  afterAll(async()=>{await first.close();await second.close();await admin.query(`DROP DATABASE IF EXISTS ${name} WITH(FORCE)`);await admin.end();});
  async function command(){
    const room=randomUUID(),request=randomUUID();
    await first.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Authority')`,[room,workspace]);
    await first.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'owner'),($1,$2,$4,'member')`,[workspace,room,person,agent]);
    await first.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'Please work')`,[request,room,person]);
    const queued=(await createAgentCommand(first,{roomId:room,agentId:agent,sourceMessageId:request,reason:'human_tag'}))!;
    await claimAgentCommand(first,room,agent,queued.id,'generation',owner);
    return {room,request,queued};
  }
  it.each(['membership','workspace','archive'] as const)('rolls back an admitted database effect when %s changes before commit',async kind=>{
    const {room,request}=await command(),entered=deferred(),release=deferred();
    const observe=(db:SqlDatabase):SqlDatabase=>({
      query:async<Row extends QueryResultRow>(sql:string,values?:unknown[])=>{
        if(sql.includes('INSERT INTO messages(')){entered.resolve();await release.promise;}
        return db.query<Row>(sql,values);
      },transaction:work=>db.transaction(tx=>work(observe(tx))),
    });
    const effect=new DaemonService(observe(first),new LiveHub()).execute('postAgentActivity',
      {roomId:room,requestId:request,generationId:'generation',activity:[]},agent);
    const refused=expect(effect).rejects.toThrow('authority expired before commit');
    try{
      await Promise.race([entered.promise,effect.then(()=>{throw new Error('Effect did not reach its write');})]);
      if(kind==='membership')await second.query('UPDATE memberships SET removed_at=clock_timestamp() WHERE room_id=$1 AND identity_id=$2',[room,agent]);
      else if(kind==='workspace')await second.query('UPDATE memberships SET removed_at=clock_timestamp() WHERE workspace_id=$1 AND room_id IS NULL AND identity_id=$2',[workspace,agent]);
      else await second.query('UPDATE rooms SET archived_at=clock_timestamp() WHERE id=$1',[room]);
      release.resolve();await refused;
      expect((await first.query('SELECT id FROM messages WHERE room_id=$1 AND author_id=$2',[room,agent])).rowCount).toBe(0);
      expect((await first.query('SELECT * FROM turn_owned_effect_fences')).rowCount).toBe(0);
    }finally{
      release.resolve();await Promise.allSettled([effect,refused]);
      if(kind==='workspace')await second.query('UPDATE memberships SET removed_at=NULL WHERE workspace_id=$1 AND room_id IS NULL AND identity_id=$2',[workspace,agent]);
    }
  },20_000);
  it.each(['commit','rollback'] as const)('refuses a contended final enqueue without sending private content; revocation %s stays authoritative',async outcome=>{
    const {room,queued}=await command(),entered=deferred(),release=deferred(),rollback=new Error('Synthetic rollback');
    const frames:string[]=[],daemon=new DaemonService(first,new LiveHub());
    const writer=second.transaction(async tx=>{
      await tx.query('UPDATE memberships SET removed_at=clock_timestamp() WHERE room_id=$1 AND identity_id=$2',[room,agent]);
      entered.resolve();await release.promise;if(outcome==='rollback')throw rollback;
    });
    const settled=writer.catch(error=>{if(error!==rollback)throw error;});
    const enqueue=()=>daemon.fenceOwnedTurnReply(agent,owner,{roomId:room,commandId:queued.id,generationId:'generation'},()=>frames.push('current'),true);
    try{
      await Promise.race([entered.promise,writer.then(()=>{throw new Error('Revoker did not reach its write');})]);
      const started=performance.now();
      await expect(enqueue()).rejects.toMatchObject({code:'55P03'});expect(frames).toEqual([]);
      expect(performance.now()-started).toBeGreaterThanOrEqual(400);
      expect(performance.now()-started).toBeLessThan(2000);
      release.resolve();await settled;
      if(outcome==='rollback'){await enqueue();expect(frames).toEqual(['current']);}
      else{await expect(enqueue()).rejects.toThrow('source changed');expect(frames).toEqual([]);}
    }finally{release.resolve();await Promise.allSettled([writer,settled]);}
  },20_000);
  // Reproduction MEMBERSHIP-503: normal queue serialization must not lose an owned reply.
  it.each(['commit','enqueue'].flatMap(path=>['room','workspace'].map(scope=>({path,scope}))))(
    'waits for a short $scope membership lock before $path and delivers the reply',async({path,scope})=>{
    const {room,request,queued}=await command(),entered=deferred(),release=deferred();
    const writer=second.transaction(async tx=>{
      await tx.query(`SELECT id FROM memberships WHERE workspace_id=$1 AND identity_id=$2
        AND ${scope==='room'?'room_id=$3':'room_id IS NULL'} FOR UPDATE`,scope==='room'?[workspace,agent,room]:[workspace,agent]);
      entered.resolve();await release.promise;
    });
    const frames:string[]=[],daemon=new DaemonService(first,new LiveHub());
    let result:Promise<PromiseSettledResult<unknown>[]>|undefined;
    try{
      await entered.promise;
      const effect=path==='commit'
        ? daemon.execute('postAgentActivity',{roomId:room,requestId:request,generationId:'generation',activity:[]},agent)
        : daemon.fenceOwnedTurnReply(agent,owner,{roomId:room,commandId:queued.id,generationId:'generation'},()=>frames.push('reply'),true);
      result=Promise.allSettled([effect]);
      await new Promise(resolve=>setTimeout(resolve,100));
      release.resolve();await writer;
      expect((await result)[0]).toMatchObject({status:'fulfilled'});
      if(path==='enqueue')expect(frames).toEqual(['reply']);
      else expect((await first.query('SELECT id FROM messages WHERE room_id=$1 AND author_id=$2',[room,agent])).rowCount).toBe(1);
      expect((await first.query('SHOW lock_timeout')).rows).toEqual([{lock_timeout:'0'}]);
    }finally{release.resolve();await Promise.allSettled([writer,...(result?[result]:[])]);}
  });
  it.each([false,true])('an owned message read cannot return revoked content (preceding installer: %s)',async precedingInstaller=>{
    if(precedingInstaller)await first.query(PRECEDING_OWNED_EFFECT_SCHEMA);
    const {room,request}=await command(),entered=deferred(),release=deferred();
    const observe=(db:SqlDatabase):SqlDatabase=>({
      query:async<Row extends QueryResultRow>(sql:string,values?:unknown[])=>{
        if(sql.includes("command.private_payload->>'authorId' author_id")){entered.resolve();await release.promise;}
        return db.query<Row>(sql,values);
      },transaction:work=>db.transaction(tx=>work(observe(tx))),
    });
    const reading=new DaemonService(observe(first),new LiveHub()).execute('getRoomMessage',
      {roomId:room,messageId:request,requestId:request,generationId:'generation'},agent);
    const refused=expect(reading).rejects.toThrow('authority expired before commit');
    try{
      await Promise.race([entered.promise,reading.then(()=>{throw new Error('Read did not reach its lookup');})]);
      await second.query('UPDATE memberships SET removed_at=clock_timestamp() WHERE room_id=$1 AND identity_id=$2',[room,agent]);
      release.resolve();await refused;
      expect((await first.query('SELECT * FROM turn_owned_effect_fences')).rowCount).toBe(0);
    }finally{
      release.resolve();await Promise.allSettled([reading,refused]);
      if(precedingInstaller)await first.query(TURN_OWNERSHIP_SCHEMA);
    }
  },20_000);
  it('the final commit check refuses a pending revocation rather than committing through its row lock',async()=>{
    const {room,request}=await command(),effectId=randomUUID(),entered=deferred(),commitEffect=deferred(),writerHeld=deferred(),commitWriter=deferred();
    const effect=first.transaction(async tx=>{
      await authorizeCommandOutput(tx,room,agent,request,'generation');
      await tx.query('INSERT INTO authority_effects(id) VALUES($1)',[effectId]);
      entered.resolve();await commitEffect.promise;
    });
    const refused=expect(effect).rejects.toMatchObject({code:'55P03'});
    let writer:Promise<void>|undefined;
    try{
      await Promise.race([entered.promise,effect.then(()=>{throw new Error('Effect did not reach its commit');})]);
      writer=second.transaction(async tx=>{
        await tx.query('UPDATE memberships SET removed_at=clock_timestamp() WHERE room_id=$1 AND identity_id=$2',[room,agent]);
        writerHeld.resolve();await commitWriter.promise;
      });
      await Promise.race([writerHeld.promise,writer.then(()=>{throw new Error('Revoker did not reach its mutation');})]);
      commitEffect.resolve();await refused;commitWriter.resolve();await writer;
      expect((await first.query('SELECT id FROM authority_effects WHERE id=$1',[effectId])).rowCount).toBe(0);
    }finally{commitEffect.resolve();commitWriter.resolve();await Promise.allSettled([effect,refused,...(writer?[writer]:[])]);}
  },20_000);
  it('retains every old/new epoch increment when two different members change concurrently',async()=>{
    const {room}=await command();
    const before=Number((await first.query<{epoch:string}>('SELECT epoch::text FROM router_authority WHERE scope=$1',['room:'+room])).rows[0]!.epoch);
    let writer=0;
    await concurrentWriters(first,second,db=>db.transaction(tx=>tx.query(
      'UPDATE memberships SET role=$3 WHERE room_id=$1 AND identity_id=$2',[room,writer++?agent:person,'admin'])),'UPDATE memberships');
    expect(Number((await first.query<{epoch:string}>('SELECT epoch::text FROM router_authority WHERE scope=$1',['room:'+room])).rows[0]!.epoch)).toBe(before+4);
  });
  it('keeps preceding readers behind the authority writer until this reader release drains',async()=>{
    const {room}=await command(),entered=deferred(),release=deferred();
    const writer=second.transaction(async tx=>{
      await tx.query('UPDATE memberships SET removed_at=clock_timestamp() WHERE room_id=$1 AND identity_id=$2',[room,agent]);
      entered.resolve();await release.promise;
    });
    try{
      await Promise.race([entered.promise,writer.then(()=>{throw new Error('Writer did not reach its mutation');})]);
      // This is the preceding reader's advisory key. A blocking acquisition
      // cannot pass the actual production trigger while revocation is pending.
      expect((await first.query<{available:boolean}>(
        'SELECT pg_try_advisory_xact_lock_shared(hashtextextended($1,0)) available',[ROUTER_AUTHORITY_LOCK])).rows)
        .toEqual([{available:false}]);
      release.resolve();await writer;
      expect((await first.query<{available:boolean}>(
        'SELECT pg_try_advisory_xact_lock_shared(hashtextextended($1,0)) available',[ROUTER_AUTHORITY_LOCK])).rows)
        .toEqual([{available:true}]);
      expect(await lockOwnedTurnRoomAccess(first,room,agent)).toBe(false);
    }finally{release.resolve();await Promise.allSettled([writer]);}
  });
  it('keeps archived cleanup controls limited to corners with current parent membership',async()=>{
    const {room,queued}=await command(),corner=randomUUID();
    await first.query(`INSERT INTO rooms(id,workspace_id,parent_id,name) VALUES($1,$2,$3,'Cleanup')`,[corner,workspace,room]);
    const input={agentId:agent,sourceMessageId:queued.source_message_id,action:'stop' as const,reason:'corner_close'};
    const childStop=(await createAgentCommand(first,{...input,roomId:corner}))!;
    const rootStop=(await createAgentCommand(first,{...input,roomId:room}))!;
    await first.query('UPDATE rooms SET archived_at=clock_timestamp() WHERE id=ANY($1::uuid[])',[[room,corner]]);
    await claimAgentCommand(first,corner,agent,childStop.id,'cleanup',owner);
    const frames:string[]=[],daemon=new DaemonService(first,new LiveHub());
    await daemon.fenceOwnedTurnReply(agent,owner,{roomId:corner,commandId:childStop.id,generationId:'cleanup'},()=>frames.push('cleanup'));
    await expect(claimAgentCommand(first,room,agent,rootStop.id,'cleanup',owner)).rejects.toThrow('authority expired before commit');
    await second.query('UPDATE memberships SET removed_at=clock_timestamp() WHERE room_id=$1 AND identity_id=$2',[room,agent]);
    await expect(daemon.fenceOwnedTurnReply(agent,owner,{roomId:corner,commandId:childStop.id,generationId:'cleanup'},()=>frames.push('must not send')))
      .rejects.toThrow('source changed');
    expect(frames).toEqual(['cleanup']);
  });
  it('two managers can stop the same schedule concurrently without transcript membership',async()=>{
    const {room}=await command(),schedule=randomUUID();
    await first.query('DELETE FROM memberships WHERE room_id=$1 AND identity_id=$2',[room,person]);
    await first.query(`INSERT INTO agent_schedules(id,workspace_id,room_id,agent_id,creator_id,cadence,message,next_run_at)
      VALUES($1,$2,$3,$4,$5,'{"kind":"interval","everyMinutes":10}','Do work','2099-01-01')`,[schedule,workspace,room,agent,person]);
    const results=await concurrentWriters(first,second,async database=>{
      const live=new LiveHub(),phone=new PhoneService(database,'https://synthetic.invalid',undefined,undefined,live);
      const dispatch=createPhoneOperationDispatcher({database,phone,live} as ServerOptions);
      return dispatch('deleteRoomSchedule',{roomId:room,scheduleId:schedule},person,undefined,undefined,{v:1,id:randomUUID()});
    },'DELETE FROM agent_schedules schedule');
    expect(results).toEqual([expect.objectContaining({state:'committed'}),expect.objectContaining({state:'committed'})]);
    expect((await first.query('SELECT id FROM agent_schedules WHERE id=$1',[schedule])).rowCount).toBe(0);
  },20_000);
  it('a DM stop retains its Workspace role through the mutation',async()=>{
    const {room}=await command(),schedule=randomUUID(),entered=deferred(),release=deferred();
    await first.query('UPDATE rooms SET direct_participants=$2::jsonb WHERE id=$1',[room,JSON.stringify([person,agent])]);
    await first.query(`INSERT INTO agent_schedules(id,workspace_id,room_id,agent_id,creator_id,cadence,message,next_run_at)
      VALUES($1,$2,$3,$4,$5,'{"kind":"interval","everyMinutes":10}','Do work','2099-01-01')`,[schedule,workspace,room,agent,person]);
    const observe=(db:SqlDatabase):SqlDatabase=>({
      query:async<Row extends QueryResultRow>(sql:string,values?:unknown[])=>{
        const result=await db.query<Row>(sql,values);
        if(sql.includes('SELECT member.role FROM memberships member')){entered.resolve();await release.promise;}
        return result;
      },transaction:work=>db.transaction(tx=>work(observe(tx))),
    });
    const phone=new PhoneService(first,'https://synthetic.invalid');
    const stopping=first.transaction(tx=>phone.withCommandTransaction(observe(tx),()=>phone.stopScheduledWorkCommand(
      'deleteRoomSchedule',{roomId:room,scheduleId:schedule},person)));
    const demote=`WITH current_member AS (SELECT id FROM memberships WHERE workspace_id=$1 AND room_id IS NULL
      AND identity_id=$2 FOR UPDATE NOWAIT)
      UPDATE memberships member SET role='spectator' FROM current_member WHERE member.id=current_member.id`;
    try{
      await Promise.race([entered.promise,stopping.then(()=>{throw new Error('Stop did not reach its role read');})]);
      await expect(second.query(demote,[workspace,person])).rejects.toMatchObject({code:'55P03'});
      release.resolve();await stopping;await second.query(demote,[workspace,person]);
      expect((await first.query('SELECT id FROM agent_schedules WHERE id=$1',[schedule])).rowCount).toBe(0);
    }finally{
      release.resolve();await Promise.allSettled([stopping]);
      await second.query("UPDATE memberships SET role='owner' WHERE workspace_id=$1 AND room_id IS NULL AND identity_id=$2",[workspace,person]);
    }
  },20_000);
});
