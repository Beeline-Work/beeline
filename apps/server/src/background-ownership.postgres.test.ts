import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { describe, expect, it } from 'vitest';
import { PostgresDatabase, type SqlDatabase } from './database.js';
import { BackgroundOwnership, BACKGROUND_OWNERSHIP_SCHEMA, BACKGROUND_LEADER_LOCK_KEY,
  BackgroundOwnershipLost, type BackgroundEpoch, type BackgroundEffectRequest } from './background-ownership.js';

const url=process.env.BEELINE_COMMAND_TEST_POSTGRES_URL;
if(url&&!['127.0.0.1','localhost','[::1]'].includes(new URL(url).hostname))
  throw new Error('Background ownership proofs require isolated loopback PostgreSQL');
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return {promise,resolve};};
const intent:BackgroundEffectRequest<'push.deliver'>={job:'push.deliver',effectId:'synthetic-delivery',sourceClaimId:'source',
  sourceClaimVersion:'v1',provider:'fcm',canonicalRequest:'{"message":"synthetic"}'};
async function fixture(){
  const schema=`background_epoch_${randomUUID().replaceAll('-','')}`;
  const admin=new Pool({connectionString:url,max:1});await admin.query(`CREATE SCHEMA ${schema}`);
  const config={connectionString:url,options:`-c search_path=${schema},public -c lock_timeout=100ms`,max:2};
  const first=new PostgresDatabase('',2,{pool:new Pool(config)}),second=new PostgresDatabase('',2,{pool:new Pool(config)});
  const locks=new Pool({connectionString:url,max:2,statement_timeout:0,options:'-c lock_timeout=0'});
  await first.query(`CREATE TABLE live_server_instances(instance_id text PRIMARY KEY,renewed_at timestamptz NOT NULL);
    INSERT INTO live_server_instances VALUES('first',clock_timestamp()),('second',clock_timestamp());${BACKGROUND_OWNERSHIP_SCHEMA}`);
  const scopes:Array<{owner:BackgroundOwnership;epoch:BackgroundEpoch}>=[];const held=new Set<PoolClient>();
  const acquire=async()=>{const client=await locks.connect();held.add(client);await client.query('SELECT pg_advisory_lock($1)',[BACKGROUND_LEADER_LOCK_KEY]);return client;};
  const drop=(client:PoolClient)=>{if(held.delete(client))client.release(true);};
  return {first,second,acquire,drop,scopes,close:async()=>{
    for(const {owner,epoch}of scopes)owner.revoke(epoch);
    for(const client of held)client.release(true);held.clear();
    await Promise.all([first.close(),second.close(),locks.end()]);await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();
  }};
}

describe.skipIf(!url)('F16 private final epoch fences, real PostgreSQL',()=>{
  it('binds the actual backend start identity and rejects a shared-only advisory lock',async()=>{
    const f=await fixture();
    try{
      const lock=await f.acquire(),core=new BackgroundOwnership(f.first,'first'),epoch=await core.claim(lock);f.scopes.push({owner:core,epoch});
      expect((await f.first.query(`SELECT beeline_background_backend_holds(lock_backend_pid,lock_backend_start) exact,
        beeline_background_backend_holds(lock_backend_pid,lock_backend_start+interval '1 microsecond') reused
        FROM background_leader_owners`)).rows).toEqual([{exact:true,reused:false}]);
      await lock.query('SELECT pg_advisory_unlock($1)',[BACKGROUND_LEADER_LOCK_KEY]);
      await lock.query('SELECT pg_advisory_lock_shared($1)',[BACKGROUND_LEADER_LOCK_KEY]);
      await expect(new BackgroundOwnership(f.first,'first').claim(lock)).rejects.toBeInstanceOf(BackgroundOwnershipLost);
      expect((await f.first.query(`SELECT beeline_background_backend_holds(lock_backend_pid,lock_backend_start) exact FROM background_leader_owners`)).rows).toEqual([{exact:false}]);
    }finally{await f.close();}
  });
  it('blocks an old delayed effect after lock transfer even when its local connection-loss signal was withheld',async()=>{
    const f=await fixture();
    try{
      const lockA=await f.acquire(),first=new BackgroundOwnership(f.first,'first');
      const epochA=await first.claim(lockA);f.scopes.push({owner:first,epoch:epochA});
      const prepared=await first.prepareEffect(epochA,intent);expect(prepared.kind).toBe('new');if(prepared.kind!=='new')return;
      f.drop(lockA); // Deliberately do not tell the old private epoch about loss.
      const lockB=await f.acquire(),second=new BackgroundOwnership(f.second,'second');
      const epochB=await second.claim(lockB);f.scopes.push({owner:second,epoch:epochB});
      expect(epochA.signal.aborted).toBe(false);let sends=0;
      await expect(first.enqueue(epochA,prepared.attempt,()=>{sends++;return undefined;})).rejects.toBeInstanceOf(BackgroundOwnershipLost);
      expect(sends).toBe(0);expect(epochA.signal.aborted).toBe(true);
      expect((await f.second.query('SELECT state FROM background_effect_attempts')).rows).toEqual([{state:'unknown'}]);
    }finally{await f.close();}
  });

  it('holds the exact owner row through synchronous enqueue while takeover blocks, without awaiting provider completion',async()=>{
    const f=await fixture(),reached=deferred(),release=deferred(),provider=deferred();let pause=false,reads=0;
    const wrap=(database:SqlDatabase):SqlDatabase=>({
      query:async(sql,values)=>{const result=await database.query(sql,values);
        if(pause&&sql.includes('FROM background_leader_owners owner JOIN')&&++reads===2){reached.resolve();await release.promise;}return result;},
      transaction:work=>database.transaction(tx=>work(wrap(tx))),
    });
    try{
      const lockA=await f.acquire(),first=new BackgroundOwnership(wrap(f.first),'first');
      const epochA=await first.claim(lockA);f.scopes.push({owner:first,epoch:epochA});
      const prepared=await first.prepareEffect(epochA,intent);if(prepared.kind!=='new')throw new Error('Expected fresh attempt');
      pause=true;let sends=0;let completion:Promise<void>|undefined;
      const dispatch=first.enqueue(epochA,prepared.attempt,()=>{sends++;completion=provider.promise;return undefined;});
      await reached.promise;expect(sends).toBe(1);f.drop(lockA);
      const lockB=await f.acquire(),second=new BackgroundOwnership(f.second,'second');
      await expect(second.claim(lockB)).rejects.toMatchObject({code:'55P03'});
      release.resolve();expect((await dispatch).state).toBe('unknown');expect(completion).toBe(provider.promise);
      const epochB=await second.claim(lockB);f.scopes.push({owner:second,epoch:epochB});
      expect(BigInt(epochB.generation)).toBeGreaterThan(BigInt(epochA.generation));
      provider.resolve();await completion;
      expect((await first.recordOutcome(prepared.attempt,'succeeded','verified synthetic provider receipt')).state).toBe('succeeded');
      await expect(first.enqueue(epochA,prepared.attempt,()=>{sends++;return undefined;})).rejects.toBeInstanceOf(BackgroundOwnershipLost);
      expect(sends).toBe(1);
    }finally{release.resolve();provider.resolve();await f.close();}
  });

  it('retains UNKNOWN across final commit-ack loss and offers no duplicate dispatch after restart/takeover',async()=>{
    const f=await fixture();let loseAck=false;
    const observed:SqlDatabase={query:(sql,values)=>f.first.query(sql,values),transaction:async work=>{
      const value=await f.first.transaction(work);if(loseAck){loseAck=false;throw new Error('lost final fence acknowledgment');}return value;
    }};
    try{
      const lockA=await f.acquire(),first=new BackgroundOwnership(observed,'first');
      const epochA=await first.claim(lockA);f.scopes.push({owner:first,epoch:epochA});
      const prepared=await first.prepareEffect(epochA,intent);if(prepared.kind!=='new')throw new Error('Expected fresh attempt');
      loseAck=true;let sends=0;
      await expect(first.enqueue(epochA,prepared.attempt,()=>{sends++;return undefined;})).rejects.toThrow('lost final fence');
      expect(sends).toBe(1);expect((await f.second.query('SELECT state FROM background_effect_attempts')).rows).toEqual([{state:'unknown'}]);
      f.drop(lockA);const lockB=await f.acquire(),second=new BackgroundOwnership(f.second,'second');
      const epochB=await second.claim(lockB);f.scopes.push({owner:second,epoch:epochB});
      const duplicate=await second.prepareEffect(epochB,intent);expect(duplicate.kind).toBe('existing');
      if(duplicate.kind==='existing')expect(duplicate.receipt.state).toBe('unknown');expect(sends).toBe(1);
    }finally{await f.close();}
  });
});
