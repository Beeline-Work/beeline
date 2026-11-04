import {createHash} from 'node:crypto';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import type {RouterFact,RouterSnapshot,ScheduledWorkAuthorityFrame,RouterAuthorityFence} from '@beeline/api-contract/router-protocol';
import {migratedDatabase,type PgliteDatabase} from './test-support.js';
import {PhoneService} from './phone-service.js';
import {LiveHub} from './live.js';
import {SCHEDULED_WORK_AUTHORITY_SCHEMA,scheduledMemberDomain} from './scheduled-work-authority.js';
import {ROOM_SCHEDULES_CAPTURE_SCHEMA} from './room-schedules-capture.js';
import {encodeRouterBatch,routerAuthority} from './router-projections.js';
import {ScheduledWorkAuthorityDelivery,encodeScheduledWorkAuthority} from './scheduled-work-authority-delivery.js';
const VIEWER='a'.repeat(64),AGENT='b'.repeat(64),WS='11111111-1111-4111-8111-111111111111';
const ROOM='22222222-2222-4222-8222-222222222222',DM='33333333-3333-4333-8333-333333333333';
const input=(roomId=ROOM)=>({family:'room-scheduled-work' as const,roomId,workspaceId:WS});
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return {promise,resolve};}
const fact=(snapshot:RouterSnapshot<'room-scheduled-work'>):RouterFact=>({atomicGroup:snapshot.atomicGroup,authority:snapshot.authority,
  payload:{kind:'scope-replace',family:snapshot.family,scope:snapshot.scope,value:snapshot.value}});
describe('complete Scheduled Work authority delivery source',()=>{
  let db:PgliteDatabase,phone:PhoneService,live:LiveHub;
  const owners:ScheduledWorkAuthorityDelivery[]=[];
  beforeEach(async()=>{
    db=await migratedDatabase();await db.query(SCHEDULED_WORK_AUTHORITY_SCHEMA);await db.query(ROOM_SCHEDULES_CAPTURE_SCHEMA);
    await db.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Manager'),($2,'agent','Helper')`,[VIEWER,AGENT]);
    await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Synthetic')`,[WS]);
    await db.query(`INSERT INTO rooms(id,workspace_id,created_by,name,direct_participants) VALUES($1,$3,$4,'Public A',NULL),($2,$3,$4,'Own DM B',$5::jsonb)`,[ROOM,DM,WS,VIEWER,JSON.stringify([VIEWER,AGENT])]);
    await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,NULL,$4,'owner'),($1,$2,$4,'member'),($1,$2,$5,'member'),($1,$3,$4,'member'),($1,$3,$5,'member')`,[WS,ROOM,DM,VIEWER,AGENT]);
    phone=new PhoneService(db,'https://synthetic.test');live=new LiveHub();
  });
  afterEach(async()=>{for(const owner of owners.splice(0))owner.close();await db.close();});
  const snapshot=async(roomId=ROOM)=>await phone.readRouterSnapshot(input(roomId),VIEWER) as RouterSnapshot<'room-scheduled-work'>;
  async function owner(send?:(frame:RouterAuthorityFence|ScheduledWorkAuthorityFrame)=>undefined){
    const frames:(RouterAuthorityFence|ScheduledWorkAuthorityFrame)[]=[],unavailable=vi.fn();
    const delivery=await ScheduledWorkAuthorityDelivery.open(db,live,VIEWER,frame=>{frames.push(frame);return send?.(frame);},unavailable);
    owners.push(delivery);return {delivery,frames,unavailable};
  }
  const revoke=()=>db.query(`UPDATE memberships SET removed_at=now() WHERE room_id=$1 AND identity_id=$2`,[DM,VIEWER]);
  const regrant=()=>db.query(`UPDATE memberships SET removed_at=NULL WHERE room_id=$1 AND identity_id=$2`,[DM,VIEWER]);
  it('flushes a revoke committed after build before data enqueue, suppresses B and preserves independent allowed A',async()=>{
    const c=await owner(),a=await snapshot(),b=await snapshot(DM);await revoke();
    let safe:readonly RouterFact[]=[],barrier:unknown;
    await c.delivery.fenceBatch(WS,[fact(a),fact(b)],c.delivery.start.segment,(facts,current)=>{
      safe=facts;barrier=current;expect(c.frames.at(-1)?.kind).toBe('scheduled-work-authority-commit');return undefined;
    });
    expect(safe.filter(item=>item.payload.kind==='scope-replace').map(item=>item.atomicGroup)).toEqual([a.atomicGroup]);
    expect(safe).toContainEqual(expect.objectContaining({atomicGroup:b.atomicGroup,payload:expect.objectContaining({kind:'authority-fence',mode:'deny',authorityScope:scheduledMemberDomain(VIEWER,DM)})}));
    const committed=c.frames.filter(frame=>frame.kind==='scheduled-work-authority-commit').at(-1);expect(barrier).toEqual(committed&&'to'in committed?committed.to:null);
    const controls=c.frames.flatMap(frame=>'fences'in frame?frame.fences:[]);
    expect(controls).toContainEqual(expect.objectContaining({mode:'deny',authorityScope:scheduledMemberDomain(VIEWER,DM)}));
    expect(c.unavailable).not.toHaveBeenCalled();
  });
  it('coalesced revoke/regrant emits a strictly newer allowed floor and never relabels old B data',async()=>{
    const c=await owner(),b=await snapshot(DM);await revoke();await regrant();
    let safe:readonly RouterFact[]=[];await c.delivery.fenceBatch(WS,[fact(b)],c.delivery.start.segment,facts=>{safe=facts;return undefined;});
    const floor=c.frames.flatMap(frame=>'fences'in frame?frame.fences:[]).find(item=>item.authorityScope===scheduledMemberDomain(VIEWER,DM));
    expect(floor?.mode).toBe('advance');expect(BigInt(floor!.authority.scopes[0]!.epoch)).toBeGreaterThan(BigInt(b.authority.scopes.find(item=>item.authorityScope===floor!.authorityScope)!.epoch));
    expect(safe.some(item=>item.payload.kind==='scope-replace')).toBe(false);expect(c.unavailable).not.toHaveBeenCalled();
  });
  it('a stale snapshot refuses only its datum; the next allowed snapshot receives its current independent barrier',async()=>{
    const c=await owner(),a=await snapshot(),b=await snapshot(DM),send=vi.fn(()=>undefined),segment=c.delivery.start.segment;await revoke();
    await expect(c.delivery.fenceSnapshot(input(DM),b,segment,send)).rejects.toMatchObject({reason:'authority'});
    expect(send).not.toHaveBeenCalled();expect(c.unavailable).not.toHaveBeenCalled();
    let safe:RouterSnapshot<'room-scheduled-work'>|undefined;
    await c.delivery.fenceSnapshot(input(),a,segment,value=>{safe=value;return undefined;});
    expect(safe).toMatchObject({cut:a.cut,value:a.value,authority:a.authority,authorityBarrier:{segment,stream:`authority:${VIEWER}`}});
  });
  it('a missing retained authority cause cannot create a barrier; actual recovery starts a discontinuous segment without restoring old snapshots',async()=>{
    const restarted=deferred(),c=await owner(frame=>{if(frame.kind==='scheduled-work-authority-restart')restarted.resolve();return undefined;});
    const old=await snapshot(),segment=c.delivery.start.segment;await revoke();
    await db.query(`DELETE FROM live_journal WHERE stream_id=$1 AND sequence=$2`,[`authority:${VIEWER}`,c.delivery.start.through+1]);
    await db.query(`DELETE FROM router_authority_reader_coverage WHERE reader=$1`,[VIEWER]);
    const sent=vi.fn(()=>undefined);await expect(c.delivery.fenceBatch(WS,[],c.delivery.start.segment,sent)).rejects.toMatchObject({reason:'retention'});
    expect(sent).not.toHaveBeenCalled();expect(c.delivery.segment).toBeUndefined();expect(c.unavailable).toHaveBeenCalledWith('retention');
    const queries=vi.spyOn(db,'query'),before=queries.mock.calls.length;
    await expect(c.delivery.fenceBatch(WS,[],c.delivery.start.segment,sent)).rejects.toMatchObject({reason:'listener'});expect(queries.mock.calls.length).toBe(before);
    live.resync();await restarted.promise;expect(c.delivery.segment).not.toBe(segment);
    await expect(c.delivery.fenceBatch(WS,[],segment,sent)).rejects.toMatchObject({reason:'dependency'});
    await expect(c.delivery.fenceSnapshot(input(),old,segment,sent)).rejects.toMatchObject({reason:'dependency'});
    const fresh=await snapshot();await c.delivery.fenceSnapshot(input(),fresh,c.delivery.segment!,sent);expect(sent).toHaveBeenCalledTimes(1);
  });
  it('unknown authority causes quarantine controls instead of becoming an empty complete interval',async()=>{
    const c=await owner();await db.query(`SELECT beeline_journal($1,'{"kind":"unknown-authority-cause"}'::jsonb)`,[`authority:${VIEWER}`]);
    const sent=vi.fn(()=>undefined);await expect(c.delivery.fenceBatch(WS,[],c.delivery.start.segment,sent)).rejects.toMatchObject({reason:'dependency'});
    expect(c.frames.some(frame=>frame.kind==='scheduled-work-authority-commit')).toBe(false);expect(sent).not.toHaveBeenCalled();expect(c.unavailable).toHaveBeenCalledWith('dependency');
  });
  it('a partially enqueued control interval cannot advance the source or admit data',async()=>{
    const accepted:(RouterAuthorityFence|ScheduledWorkAuthorityFrame)[]=[];
    const c=await owner(frame=>{if(frame.kind==='scheduled-work-authority-commit')throw new Error('enqueue lost');accepted.push(frame);return undefined;});await revoke();
    const sent=vi.fn(()=>undefined);await expect(c.delivery.fenceBatch(WS,[],c.delivery.start.segment,sent)).rejects.toThrow('enqueue lost');
    expect(accepted.some(frame=>frame.kind==='scheduled-work-authority-part')).toBe(true);expect(accepted.some(frame=>frame.kind==='scheduled-work-authority-commit')).toBe(false);
    expect(c.delivery.segment).toBeUndefined();expect(sent).not.toHaveBeenCalled();expect(c.unavailable).toHaveBeenCalledWith('projection');
  });
  it('actual listener loss parks once; repeated queued requests do not inspect or invent an empty interval',async()=>{
    const c=await owner(),queries=vi.spyOn(db,'query');live.projectionUnavailable();const count=queries.mock.calls.length;
    await expect(c.delivery.fenceBatch(WS,[],c.delivery.start.segment,()=>undefined)).rejects.toMatchObject({reason:'listener'});
    live.journalChanged([`authority:${VIEWER}`]);await expect(c.delivery.fenceBatch(WS,[],c.delivery.start.segment,()=>undefined)).rejects.toThrow();
    expect(queries.mock.calls.length).toBe(count);expect(c.unavailable).toHaveBeenCalledTimes(1);expect(c.frames).toEqual([]);
  });
});

describe('closed compact control packetization',()=>{
  const start={stream:`authority:${VIEWER}` as const,epoch:'source',segment:'segment',through:1,protocol:1 as const};
  it('partitions actual complete controls with a digest and final marker without truncation',()=>{
    const fences=Array.from({length:256},(_,i)=>{const scope=`44444444-4444-4444-8444-${String(i).padStart(12,'0')}`,authorityScope=`scheduled-work-room:${scope}`;
      return {kind:'authority-fence' as const,scope,authorityScope,mode:'advance' as const,authority:routerAuthority([{authorityScope,epoch:'2'}])};});
    const frames=encodeScheduledWorkAuthority(start,{...start,through:257},fences),parts=frames.filter(frame=>frame.kind==='scheduled-work-authority-part');
    expect(parts.length).toBeGreaterThan(1);expect(parts.flatMap(part=>part.fences)).toEqual(fences);expect(frames.at(-1)?.kind).toBe('scheduled-work-authority-commit');
    expect(frames.every(frame=>Buffer.byteLength(JSON.stringify(frame))<=64*1024)).toBe(true);
    expect(parts[0]!.contentDigest).toBe(createHash('sha256').update(JSON.stringify(fences)).digest('hex'));
  });
  it('hashes the closed classification inside the existing complete data batch and rejects malformed or duplicate markers',()=>{
    const cut={stream:`workspace:${WS}`,epoch:'data',through:1,protocol:1 as const},marker={kind:'scheduled-work-classification' as const,version:1 as const,authorityBarrier:start};
    const frames=encodeRouterBatch(cut,{...cut,through:2},[marker]);expect(frames[0]!.contentDigest).toBe(createHash('sha256').update(JSON.stringify([marker])).digest('hex'));
    expect(()=>encodeRouterBatch(cut,{...cut,through:2},[marker,marker])).toThrow();
    expect(()=>encodeRouterBatch(cut,{...cut,through:2},[{...marker,authorityBarrier:{...start,through:NaN}}])).toThrow();
    expect(()=>encodeScheduledWorkAuthority(start,{...start,segment:'unannounced',through:2},[])).toThrow();
  });
});
