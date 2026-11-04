import {afterEach,beforeEach,describe,expect,it} from 'vitest';
import {migratedDatabase,type PgliteDatabase} from './test-support.js';
import {SCHEDULED_WORK_AUTHORITY_SCHEMA,scheduledWorkAuthority,currentScheduledWorkFence,scheduledPrincipalDomain,scheduledManagerDomain,scheduledMemberDomain,scheduledRoomDomain} from './scheduled-work-authority.js';
import {ROOM_SCHEDULES_CAPTURE_SCHEMA} from './room-schedules-capture.js';
import {buildRouterSnapshot,readRouterAuthority,fenceRouterEnqueue} from './router-projections.js';
import {buildRoomSchedulesProjection} from './room-schedules-projection.js';
const OWNER='a'.repeat(64),MEMBER='b'.repeat(64),AGENT='c'.repeat(64);
const WS='11111111-1111-4111-8111-111111111111',ROOM='22222222-2222-4222-8222-222222222222',DM='33333333-3333-4333-8333-333333333333';
const input={family:'room-scheduled-work' as const,roomId:ROOM,workspaceId:WS};
describe('Scheduled Work read membership and independent mutation authority',()=>{
  let db:PgliteDatabase;
  beforeEach(async()=>{
    db=await migratedDatabase();await db.query(SCHEDULED_WORK_AUTHORITY_SCHEMA);await db.query(ROOM_SCHEDULES_CAPTURE_SCHEMA);
    await db.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Owner'),($2,'human','Member'),($3,'agent','Helper')`,[OWNER,MEMBER,AGENT]);
    await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Workspace')`,[WS]);
    await db.query(`INSERT INTO rooms(id,workspace_id,created_by,name) VALUES($1,$2,$3,'Room')`,[ROOM,WS,OWNER]);
    await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,NULL,$3,'owner'),($1,$2,$3,'member'),($1,NULL,$4,'member'),($1,$2,$4,'member'),($1,$2,$5,'member')`,[WS,ROOM,OWNER,MEMBER,AGENT]);
  });
  afterEach(async()=>{await db.close();});
  const snapshot=(args=input,viewer=OWNER)=>buildRouterSnapshot(db,args,viewer,(tx,args,reader)=>buildRoomSchedulesProjection(tx,args.roomId!,reader,'https://synthetic.test'));
  const epoch=(authority:Awaited<ReturnType<typeof scheduledWorkAuthority>>['authority'],domain:string)=>authority.scopes.find(scope=>scope.authorityScope===domain)!.epoch;
  async function ownDM(){
    await db.query(`INSERT INTO rooms(id,workspace_id,created_by,name,direct_participants) VALUES($1,$2,$3,'DM',$4::jsonb)`,[DM,WS,OWNER,JSON.stringify([OWNER,MEMBER])]);
    await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'member')`,[WS,DM,MEMBER]);
    await db.query(`DELETE FROM memberships WHERE workspace_id=$1 AND room_id IS NULL AND identity_id=$2`,[WS,MEMBER]);
    return {family:'room-scheduled-work' as const,roomId:DM,workspaceId:WS};
  }
  it('allows an ordinary Room member and refuses a Workspace manager without Room membership',async()=>{
    const value=await snapshot(input,MEMBER);
    expect(value.value).toMatchObject({roomName:'Room',schedules:[],subscriptions:[]});
    expect(value.authority.scopes.map(scope=>scope.authorityScope)).toEqual([scheduledManagerDomain(MEMBER,WS),scheduledMemberDomain(MEMBER,ROOM),scheduledPrincipalDomain(MEMBER),scheduledRoomDomain(ROOM)].sort());
    await db.query(`DELETE FROM memberships WHERE room_id=$1 AND identity_id=$2`,[ROOM,OWNER]);
    await expect(snapshot()).rejects.toMatchObject({reason:'authority'});
    await expect(readRouterAuthority(db,{family:'room-head',roomId:ROOM,workspaceId:WS},MEMBER)).resolves.toBeDefined();
  });
  it('allows humans to manage their own DM without fictitious Workspace membership',async()=>{
    const args=await ownDM(),value=await snapshot(args,MEMBER);
    expect(value.authority.scopes.map(scope=>scope.authorityScope)).toContain(scheduledMemberDomain(MEMBER,DM));
    expect(value.authority.scopes.some(scope=>scope.authorityScope.startsWith('reader:')||scope.authorityScope.startsWith('scheduled-work-manager:'))).toBe(false);
    await expect(readRouterAuthority(db,{family:'room-head',roomId:DM,workspaceId:WS},MEMBER)).rejects.toMatchObject({reason:'authority'});
  });
  it('retires an old certificate after a role change while retaining Room read access',async()=>{
    const value=await snapshot();let sent=0;
    await db.query(`UPDATE memberships SET role='member' WHERE room_id IS NULL AND identity_id=$1`,[OWNER]);
    await expect(fenceRouterEnqueue(db,input,OWNER,value.authority,()=>{sent++;return undefined;})).rejects.toMatchObject({reason:'authority'});
    const denied=await currentScheduledWorkFence(db,OWNER,WS,scheduledManagerDomain(OWNER,WS));expect(denied?.mode).toBe('advance');await expect(snapshot()).resolves.toBeDefined();
    await expect(readRouterAuthority(db,{family:'room-head',roomId:ROOM,workspaceId:WS},OWNER)).resolves.toBeDefined();
    await db.query(`UPDATE memberships SET role='admin' WHERE room_id IS NULL AND identity_id=$1`,[OWNER]);
    const granted=await snapshot();expect(BigInt(epoch(granted.authority,denied!.authorityScope))).toBeGreaterThan(BigInt(denied!.authority.scopes[0]!.epoch));expect(sent).toBe(0);
  });
  it('fences identity kind and hidden policy without changing another reader transcript certificate',async()=>{
    const transcript=await readRouterAuthority(db,{family:'room-head',workspaceId:WS,roomId:ROOM},MEMBER);
    for(const mutation of ["hidden_from_roster=true","kind='agent'"]){
      const value=await snapshot();await db.query(`UPDATE identities SET ${mutation} WHERE id=$1`,[OWNER]);
      expect((await scheduledWorkAuthority(db,ROOM,OWNER)).allowed).toBe(false);
      expect(await currentScheduledWorkFence(db,OWNER,OWNER,scheduledPrincipalDomain(OWNER))).toMatchObject({mode:'deny'});
      await expect(fenceRouterEnqueue(db,input,OWNER,value.authority,()=>undefined)).rejects.toMatchObject({reason:'authority'});
      expect(await readRouterAuthority(db,{family:'room-head',workspaceId:WS,roomId:ROOM},MEMBER)).toEqual(transcript);
      await db.query(`UPDATE identities SET kind='human',hidden_from_roster=false WHERE id=$1`,[OWNER]);
      expect((await snapshot()).authority.digest).not.toBe(value.authority.digest);
    }
  });
  it('a DM participant removal/regrant advances only Room policy, never permanently denying unchanged membership',async()=>{
    const args=await ownDM(),value=await snapshot(args,MEMBER),member=scheduledMemberDomain(MEMBER,DM),policy=scheduledRoomDomain(DM);
    await db.query(`UPDATE rooms SET direct_participants=$1::jsonb WHERE id=$2`,[JSON.stringify([OWNER]),DM]);
    expect(await currentScheduledWorkFence(db,MEMBER,DM,policy)).toMatchObject({mode:'deny'});
    await expect(fenceRouterEnqueue(db,args,MEMBER,value.authority,()=>undefined)).rejects.toMatchObject({reason:'authority'});
    await db.query(`UPDATE rooms SET direct_participants=$1::jsonb WHERE id=$2`,[JSON.stringify([OWNER,MEMBER]),DM]);
    const granted=await snapshot(args,MEMBER);expect(epoch(granted.authority,member)).toBe(epoch(value.authority,member));
    expect(BigInt(epoch(granted.authority,policy))).toBeGreaterThan(BigInt(epoch(value.authority,policy)));
  });
  it('DM membership loss/regrant advances membership without denying unchanged participant policy',async()=>{
    const args=await ownDM(),value=await snapshot(args,MEMBER),member=scheduledMemberDomain(MEMBER,DM),policy=scheduledRoomDomain(DM);
    await db.query(`UPDATE memberships SET removed_at=now() WHERE room_id=$1 AND identity_id=$2`,[DM,MEMBER]);
    expect(await currentScheduledWorkFence(db,MEMBER,DM,member)).toMatchObject({mode:'deny'});
    await expect(fenceRouterEnqueue(db,args,MEMBER,value.authority,()=>undefined)).rejects.toMatchObject({reason:'authority'});
    await db.query(`UPDATE memberships SET removed_at=NULL WHERE room_id=$1 AND identity_id=$2`,[DM,MEMBER]);
    const granted=await snapshot(args,MEMBER);expect(epoch(granted.authority,policy)).toBe(epoch(value.authority,policy));
    expect(BigInt(epoch(granted.authority,member))).toBeGreaterThan(BigInt(epoch(value.authority,member)));
  });
  it('archive, parent and Workspace moves refuse an older certified snapshot',async()=>{
    const parent='44444444-4444-4444-8444-444444444444',other='55555555-5555-4555-8555-555555555555';
    await db.query(`INSERT INTO rooms(id,workspace_id,created_by,name) VALUES($1,$2,$3,'Parent')`,[parent,WS,OWNER]);
    await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Move target')`,[other]);
    for(const [mutation,args]of [[`archived_at=now()`,[]],[`parent_id=$2`,[parent]],[`workspace_id=$2`,[other]]] as const){
      const value=await snapshot();await db.query(`UPDATE rooms SET ${mutation} WHERE id=$1`,[ROOM,...args]);
      await expect(fenceRouterEnqueue(db,input,OWNER,value.authority,()=>undefined)).rejects.toMatchObject({reason:'authority'});
      await db.query(`UPDATE rooms SET archived_at=NULL,parent_id=NULL,workspace_id=$2 WHERE id=$1`,[ROOM,WS]);
    }
  });
});
