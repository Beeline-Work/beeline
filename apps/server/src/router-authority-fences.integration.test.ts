import {afterEach,beforeEach,describe,expect,it} from 'vitest';
import {ROUTER_MAX_AUTHORITY_FENCE_BYTES} from '@beeline/api-contract/router-protocol';
import {LiveHub} from './live.js';
import {PhoneService} from './phone-service.js';
import {routerSocketProtocol} from './router-socket.js';
import {readRouterAuthority,fenceRouterEnqueue} from './router-projections.js';
import {currentAuthorityFence,subscribeAuthorityFences} from './router-authority-fences.js';
import {readMediaMetadata} from './phone-media.js';
import {migratedDatabase,type PgliteDatabase} from './test-support.js';
const VIEWER='a'.repeat(64),OWNER='b'.repeat(64);
const WORKSPACE='11111111-1111-4111-8111-111111111111',ROOM='22222222-2222-4222-8222-222222222222';
const CHILD='33333333-3333-4333-8333-333333333333',OBJECT='44444444-4444-4444-8444-444444444444';
describe('independent authority control without data coverage',()=>{
  let db:PgliteDatabase;
  beforeEach(async()=>{
    db=await migratedDatabase();
    await db.query(`INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Reader','reader'),($2,'human','Owner','owner')`,[VIEWER,OWNER]);
    await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Workspace')`,[WORKSPACE]);
    await db.query(`INSERT INTO rooms(id,workspace_id,created_by,name) VALUES($1,$2,$3,'Room')`,[ROOM,WORKSPACE,OWNER]);
    await db.query(`INSERT INTO rooms(id,workspace_id,parent_id,created_by,name) VALUES($1,$2,$3,$4,'Child')`,[CHILD,WORKSPACE,ROOM,OWNER]);
    await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,NULL,$3,'owner'),($1,NULL,$4,'member'),($1,$2,$3,'owner'),($1,$2,$4,'member')`,[WORKSPACE,ROOM,OWNER,VIEWER]);
    await db.query(`INSERT INTO objects(id,owner_id,kind,key,sha256,mime,size,state,expires_at) VALUES($1,$2,'artifact','synthetic/key',$3,'text/plain',10,'ready','2099-01-01')`,[OBJECT,OWNER,'a'.repeat(64)]);
    await db.query(`INSERT INTO messages(id,room_id,author_id,text,attachments) VALUES('file',$1,$2,'File',$3::jsonb)`,[CHILD,OWNER,JSON.stringify([{url:`/v1/media/${OBJECT}`}])]);
  });
  afterEach(async()=>{await db.close();});
  it('delivers a bounded object denial on a negotiated metadata-only socket with no Room inventory',async()=>{
    const live=new LiveHub(),frames:Record<string,any>[]=[];
    let delivered!:()=>void;const complete=new Promise<void>(done=>{delivered=done;});
    const protocol=routerSocketProtocol(db,VIEWER,raw=>{const frame=JSON.parse(raw);frames.push(frame);if(frame.kind==='authority-fence')delivered();},
      {families:[],listenerReady:()=>true},{live,phone:new PhoneService(db,'https://example.test'),rooms:()=>[],mediaMetadataV1:true});
    try{
      await protocol.handle({type:'router-negotiate',protocol:1,families:[],authorityFencesV1:true});
      expect(frames[0]).toMatchObject({type:'router-capabilities',families:[],authorityFencesV1:true});
      await readMediaMetadata(db,OBJECT,VIEWER);
      await db.query(`UPDATE messages SET attachments='[]'::jsonb WHERE id='file'`);
      live.journalChanged([`authority:${VIEWER}`]);await complete;
      const frame=frames.at(-1)!;
      expect(frame).toMatchObject({kind:'authority-fence',scope:OBJECT,authorityScope:`object:${OBJECT}`});
      expect(frame.authority.scopes).toEqual([{authorityScope:`object:${OBJECT}`,epoch:expect.any(String)}]);
      expect(Buffer.byteLength(JSON.stringify(frame))).toBeLessThanOrEqual(ROUTER_MAX_AUTHORITY_FENCE_BYTES);
      expect(frame).not.toHaveProperty('cut');expect(frame).not.toHaveProperty('to');
      expect(frames.some(item=>item.kind==='push-commit')).toBe(false);
      await db.query('SELECT 1');
    }finally{protocol.close();}
  });
  it('does not start a private authority stream for an old phone that never requests it',async()=>{
    const live=new LiveHub(),frames:Record<string,any>[]=[];
    const protocol=routerSocketProtocol(db,VIEWER,raw=>frames.push(JSON.parse(raw)),{families:[],listenerReady:()=>true},
      {live,phone:new PhoneService(db,'https://example.test'),rooms:()=>[],mediaMetadataV1:true});
    try{
      await protocol.handle({type:'router-negotiate',protocol:1,families:[]});
      await db.query(`UPDATE messages SET attachments='[]'::jsonb WHERE id='file'`);
      live.journalChanged([`authority:${VIEWER}`]);await db.query('SELECT 1');
      expect(frames).toHaveLength(1);expect(frames[0]!.authorityFencesV1).toBe(false);
    }finally{protocol.close();}
  });
  it('keeps inherited parent denial precise and advances the parent generation on regrant',async()=>{
    const input={family:'room-head' as const,workspaceId:WORKSPACE,roomId:CHILD};
    const initial=await readRouterAuthority(db,input,VIEWER);
    expect(initial.scopes.map(item=>item.authorityScope)).toContain(`room:${ROOM}`);
    await db.query(`UPDATE memberships SET removed_at=now() WHERE identity_id=$1 AND room_id=$2`,[VIEWER,ROOM]);
    const fence=await currentAuthorityFence(db,VIEWER,ROOM,`room:${ROOM}`);
    expect(fence?.authorityScope).toBe(`room:${ROOM}`);
    expect(fence?.authority.scopes).toHaveLength(1);
    await db.query(`UPDATE memberships SET removed_at=NULL WHERE identity_id=$1 AND room_id=$2`,[VIEWER,ROOM]);
    const granted=await readRouterAuthority(db,input,VIEWER);
    expect(BigInt(granted.scopes.find(item=>item.authorityScope===`room:${ROOM}`)!.epoch))
      .toBeGreaterThan(BigInt(fence!.authority.scopes[0]!.epoch));
    // Aggregate Room-list/Needs-you certificates depend on the reader's
    // Workspace generation too, even though the denied resource is precise.
    expect(BigInt(granted.scopes.find(item=>item.authorityScope.startsWith('reader:'))!.epoch))
      .toBeGreaterThan(BigInt(initial.scopes.find(item=>item.authorityScope.startsWith('reader:'))!.epoch));
    expect(await currentAuthorityFence(db,VIEWER,ROOM,`room:${ROOM}`)).toBeUndefined();
  });
  it('new attachment references advance beyond an earlier object denial without denying authorized owners',async()=>{
    await db.query(`UPDATE messages SET attachments='[]'::jsonb WHERE id='file'`);
    const fence=await currentAuthorityFence(db,VIEWER,OBJECT,`object:${OBJECT}`);
    expect(fence).toBeDefined();
    expect(await currentAuthorityFence(db,OWNER,OBJECT,`object:${OBJECT}`)).toBeUndefined();
    await db.query(`INSERT INTO messages(id,room_id,author_id,text,attachments) VALUES('regrant',$1,$2,'Again',$3::jsonb)`,[CHILD,OWNER,JSON.stringify([{url:`/v1/media/${OBJECT}`}])]);
    const metadata=await readMediaMetadata(db,OBJECT,VIEWER);
    expect(BigInt(metadata.authority.scopes.find(item=>item.authorityScope===`object:${OBJECT}`)!.epoch))
      .toBeGreaterThan(BigInt(fence!.authority.scopes[0]!.epoch));
  });
  it('a Room revoke rejects a previously built Workspace aggregate without denying unrelated Room authority',async()=>{
    const input={family:'room-list' as const,workspaceId:WORKSPACE};
    const initial=await readRouterAuthority(db,input,VIEWER);let delivered=0;
    await db.query(`UPDATE memberships SET removed_at=now() WHERE identity_id=$1 AND room_id=$2`,[VIEWER,ROOM]);
    await expect(fenceRouterEnqueue(db,input,VIEWER,initial,()=>{delivered++;return undefined;})).rejects.toThrow('authority');
    expect(delivered).toBe(0);
    expect(await currentAuthorityFence(db,VIEWER,WORKSPACE,`reader:${VIEWER}:workspace:${WORKSPACE}`)).toBeUndefined();
  });
  it('coalesces revoke/regrant before the final fence without emitting a false current denial',async()=>{
    const live=new LiveHub(),frames:unknown[]=[];let ready!:()=>void;
    const barrier=new Promise<void>(done=>{ready=done;});
    const release=await subscribeAuthorityFences(db,live,VIEWER,frame=>{frames.push(frame);return undefined;},reason=>{throw new Error(reason);},barrier);
    try{
      await db.query(`UPDATE memberships SET removed_at=now() WHERE identity_id=$1 AND room_id=$2`,[VIEWER,ROOM]);
      live.journalChanged([`authority:${VIEWER}`]);
      await db.query(`UPDATE memberships SET removed_at=NULL WHERE identity_id=$1 AND room_id=$2`,[VIEWER,ROOM]);
      ready();await db.query('SELECT 1');await new Promise<void>(done=>setImmediate(done));await db.query('SELECT 1');
      expect(frames).toEqual([]);
    }finally{ready();release();}
  });
  it('parks authority delivery immediately on committed-listener loss without polling or repair reads',async()=>{
    const live=new LiveHub(),frames:unknown[]=[],failures:string[]=[];
    const release=await subscribeAuthorityFences(db,live,VIEWER,frame=>{frames.push(frame);return undefined;},reason=>failures.push(reason));
    try{
      live.projectionUnavailable();
      expect(failures).toEqual(['listener']);
      await db.query(`UPDATE memberships SET removed_at=now() WHERE identity_id=$1 AND room_id=$2`,[VIEWER,ROOM]);
      live.journalChanged([`authority:${VIEWER}`]);live.resync();await db.query('SELECT 1');
      expect(frames).toEqual([]);expect(failures).toEqual(['listener']);
    }finally{release();}
  });
});
