import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {migratedDatabase,type PgliteDatabase} from './test-support.js';
import type {SqlDatabase} from './database.js';
import {BackgroundOwnership,BACKGROUND_OWNERSHIP_SCHEMA,type BackgroundEpoch} from './background-ownership.js';
import {TRAY_CLOCK_SOURCE_SCHEMA} from './tray-clock-source.js';
import {TRAY_CLOCK_OWNER_SCHEMA} from './tray-clock-owner.js';
import {TrayClockReadinessOwner} from './tray-clock-readiness-owner.js';
import {TrayClockHealth} from './tray-clock-health.js';
import {TrayClockAvailability} from './tray-clock-availability.js';
import {LiveHub} from './live.js';
import {installBackgroundOwnerTestProof,backgroundOwnerTestLock} from './test-fixtures/background-owner-test-support.js';

const STREAM='jobs:tray-clock-health',WS='11111111-1111-4111-8111-111111111111';
describe('shared server Tray availability from committed control causes',()=>{
  let db:PgliteDatabase,live:LiveHub,actor:TrayClockAvailability,owner:BackgroundOwnership,epoch:BackgroundEpoch;
  let lock:Awaited<ReturnType<typeof backgroundOwnerTestLock>>,queries:number,listenerReady:boolean;
  let unavailable:ReturnType<typeof vi.fn>,afterTransaction:(()=>Promise<void>)|undefined;
  const observed=():SqlDatabase=>({query:(sql,args)=>{queries++;return db.query(sql,args);},transaction:async work=>{
    const result=await db.transaction(tx=>work({query:(sql,args)=>{queries++;return tx.query(sql,args);},transaction:next=>tx.transaction(next)}));
    await afterTransaction?.();return result;
  }});
  const head=async()=>Number((await db.query<{sequence:string}>('SELECT sequence::text FROM live_streams WHERE id=$1',[STREAM])).rows[0]!.sequence);
  const notify=async()=>{live.journalChanged([STREAM]);await actor.start();};
  beforeEach(async()=>{
    db=await migratedDatabase();live=new LiveHub();queries=0;listenerReady=true;afterTransaction=undefined;unavailable=vi.fn();
    await db.query(BACKGROUND_OWNERSHIP_SCHEMA);await db.query(TRAY_CLOCK_SOURCE_SCHEMA);await db.query(TRAY_CLOCK_OWNER_SCHEMA);
    await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Synthetic')`,[WS]);
    await installBackgroundOwnerTestProof(db);lock=await backgroundOwnerTestLock(db);
    await db.query(`INSERT INTO live_server_instances(instance_id) VALUES('availability')`);
    owner=new BackgroundOwnership(db,'availability');epoch=await owner.claim(lock);
    const readiness=new TrayClockReadinessOwner(owner);
    for(let n=0;n<20;n++)if(!(await readiness.run(epoch)).continuation)break;
    await new TrayClockHealth(owner).publish(epoch);
    actor=new TrayClockAvailability(observed(),live,{listenerReady:()=>listenerReady,unavailable});
    await actor.start();expect(actor.ready()).toBe(true);expect(unavailable).not.toHaveBeenCalled();
  });
  afterEach(async()=>{await actor.close();owner.revoke(epoch);await db.close();});

  it('captures exact control changes atomically and emits nothing for no-op writes',async()=>{
    const before=await head();
    await db.query('UPDATE tray_clock_health SET id=id');
    await db.query('UPDATE background_leader_owners SET generation=generation');
    expect(await head()).toBe(before);
    await expect(db.transaction(async tx=>{
      await tx.query('UPDATE background_leader_owners SET released_at=clock_timestamp()');throw new Error('rollback');
    })).rejects.toThrow('rollback');
    expect(await head()).toBe(before);
    await owner.release(epoch);expect(await head()).toBe(before+1);
    expect((await db.query('SELECT event FROM live_journal WHERE stream_id=$1 AND sequence=$2',[STREAM,before+1])).rows)
      .toEqual([{event:{sourceTable:'tray-clock-health',version:1,invalidated:true}}]);
    await notify();expect(actor.ready()).toBe(false);expect(unavailable).toHaveBeenCalledOnce();
  });

  it('stays read-idle on unrelated hints and repeated ownership waits',async()=>{
    const before=queries;
    for(let n=0;n<100;n++){live.journalChanged([`workspace:${WS}`]);await actor.start();}
    expect(queries).toBe(before);expect(unavailable).not.toHaveBeenCalled();
    await notify();expect(queries-before).toBe(2); // transaction mode + unchanged head only
    expect(unavailable).not.toHaveBeenCalled();
  });

  it('retains a coalesced loss even when a new healthy generation already exists',async()=>{
    await owner.release(epoch);epoch=await owner.claim(lock);await new TrayClockHealth(owner).publish(epoch);
    await notify();expect(actor.ready()).toBe(true);expect(unavailable).toHaveBeenCalledOnce();
    await notify();expect(unavailable).toHaveBeenCalledOnce();
  });

  it.each(['gap','unknown'] as const)('parks %s history without retrying ordinary hints',async kind=>{
    await db.query('SELECT beeline_journal($1,$2::jsonb)',[STREAM,JSON.stringify({sourceTable:'tray-clock-health',version:1,
      invalidated:true,...(kind==='unknown'?{unexpected:true}:{})})]);
    if(kind==='gap')await db.query('DELETE FROM live_journal WHERE stream_id=$1 AND sequence=$2',[STREAM,await head()]);
    await notify();expect(actor.ready()).toBe(false);expect(unavailable).toHaveBeenCalledWith('source');
    const before=queries;for(let n=0;n<20;n++)await notify();expect(queries).toBe(before);
    live.resync();await actor.start();expect(actor.ready()).toBe(true);
    // Recovery controls admission for future real demand, never reads client data.
    expect(unavailable).toHaveBeenCalledOnce();
  });

  it('keeps a real opening hint received after the baseline transaction and before local adoption',async()=>{
    await actor.close();let once=true;
    afterTransaction=async()=>{if(once){once=false;await owner.release(epoch);live.journalChanged([STREAM]);}};
    actor=new TrayClockAvailability(observed(),live,{listenerReady:()=>listenerReady,unavailable});
    await actor.start();expect(actor.ready()).toBe(false);expect(unavailable).toHaveBeenCalledOnce();
  });

  it('listener loss parks synchronously and only actual recovery inspects again',async()=>{
    listenerReady=false;live.projectionUnavailable();expect(actor.ready()).toBe(false);
    const before=queries;await notify();await actor.start();expect(queries).toBe(before);
    listenerReady=true;live.resync();await actor.start();expect(actor.ready()).toBe(true);
    expect(unavailable).toHaveBeenCalledOnce();
  });
});
