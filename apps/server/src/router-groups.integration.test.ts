import {createHash} from 'node:crypto';
import {afterEach,beforeEach,describe,expect,it} from 'vitest';
import type {RouterFact,RouterSnapshotInput} from '@beeline/api-contract/router-protocol';
import {ReadLanes,type LaneBatch} from '../../../packages/net/src/private/read-lanes.js';
import {RouterBatchAssembly} from '../../../packages/net/src/private/batch-assembly.js';
import type {SqlDatabase} from './database.js';
import {LiveHub} from './live.js';
import {PhoneService} from './phone-service.js';
import {buildRouterSnapshot,encodeRouterBatch,fenceRouterBatch,routerAuthority,readRouterAuthority} from './router-projections.js';
import {currentAuthorityFence} from './router-authority-fences.js';
import {routerSocketProtocol} from './router-socket.js';
import {migratedDatabase,type PgliteDatabase} from "../../../tests/helpers/server.js";
const VIEWER='a'.repeat(64),OTHER='b'.repeat(64);
const WS='11111111-1111-4111-8111-111111111111',A='22222222-2222-4222-8222-222222222222',B='33333333-3333-4333-8333-333333333333';
const P='44444444-4444-4444-8444-444444444444';
const room=(roomId:string)=>({family:'room-head' as const,workspaceId:WS,roomId});
const count={family:'needs-you-count' as const,workspaceId:WS},tray={family:'needs-you' as const,workspaceId:WS};
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const settle=async()=>{for(let i=0;i<60;i++)await Promise.resolve();};
describe('per-group final authority fence',()=>{
  let db:PgliteDatabase,phone:PhoneService;
  beforeEach(async()=>{
    db=await migratedDatabase();phone=new PhoneService(db,'https://synthetic.test');
    await db.query(`INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Reader','reader'),($2,'human','Other','other')`,[VIEWER,OTHER]);
    await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Workspace')`,[WS]);
    await db.query(`INSERT INTO rooms(id,workspace_id,created_by,name) VALUES($1,$3,$4,'Allowed A'),($2,$3,$4,'Private B')`,[A,B,WS,OTHER]);
    await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,NULL,$4,'member'),($1,$2,$4,'member'),($1,$3,$4,'member')`,[WS,A,B,VIEWER]);
  });
  afterEach(async()=>{await db.close();});
  const snapshot=(input:RouterSnapshotInput)=>buildRouterSnapshot(db,input,VIEWER,(tx,args,reader)=>phone.buildRouterValue(tx,args,reader));
  const fact=(value:Awaited<ReturnType<typeof snapshot>>):RouterFact=>({atomicGroup:value.atomicGroup,authority:value.authority,
    payload:{kind:'scope-replace',family:value.family,scope:value.scope,value:value.value}} as RouterFact);
  const revoke=()=>db.query(`UPDATE memberships SET removed_at=now() WHERE room_id=$1 AND identity_id=$2`,[B,VIEWER]);
  it('preserves allowed A, suppresses the whole stale count/cells group and serializes only current content-free B controls',async()=>{
    const initial=await Promise.all([snapshot(room(A)),snapshot(room(B)),snapshot(count),snapshot(tray)]);
    await revoke();let safe:readonly RouterFact[]=[];
    await fenceRouterBatch(db,WS,VIEWER,initial.map(fact),facts=>{safe=facts;return undefined;});
    expect(safe.filter(item=>item.payload.kind==='scope-replace').map(item=>item.atomicGroup)).toEqual([initial[0]!.atomicGroup]);
    expect(safe).toContainEqual(expect.objectContaining({atomicGroup:initial[1]!.atomicGroup,payload:{kind:'authority-fence',scope:B,authorityScope:`room:${B}`,mode:'deny'}}));
    expect(safe).toContainEqual(expect.objectContaining({atomicGroup:initial[2]!.atomicGroup,payload:{kind:'authority-fence',scope:WS,authorityScope:`reader:${VIEWER}:workspace:${WS}:visibility`,mode:'advance'}}));
    const encoded=JSON.stringify(encodeRouterBatch(initial[0]!.cut,{...initial[0]!.cut,through:initial[0]!.cut.through+1},safe));
    expect(encoded).not.toContain('Private B');expect(encoded).not.toContain('"items"');
  });
  it('missing B authority parks only B and does not classify unknown coverage',async()=>{
    const initial=await Promise.all([snapshot(room(A)),snapshot(room(B))]);
    await db.query(`DELETE FROM router_authority WHERE scope=$1`,[`room:${B}`]);
    let safe:readonly RouterFact[]=[];await fenceRouterBatch(db,WS,VIEWER,initial.map(fact),facts=>{safe=facts;return undefined;});
    expect(safe[0]!.payload.kind).toBe('scope-replace');expect(safe[1]!.payload).toEqual({kind:'group-unavailable',scope:B,reason:'authority'});
    const lanes=new ReadLanes({origin:'https://synthetic.test',principal:VIEWER,sessionEpoch:1},()=>true);
    let reads=0;lanes.connected(1,['room-head'],async input=>{reads++;return initial.find(value=>value.scope===input.roomId)!;});
    lanes.demand(room(A),{}, {isCurrent:()=>true});lanes.demand(room(B),{}, {isCurrent:()=>true});await settle();
    await lanes.accept({from:initial[0]!.cut,to:{...initial[0]!.cut,through:initial[0]!.cut.through+1},facts:safe});
    expect(lanes.peek(room(A)).state).toBe('LIVE');expect(lanes.peek(room(B))).toMatchObject({state:'PARKED',value:null,cut:null});expect(reads).toBe(2);
  });
  it('actual socket build-to-enqueue revoke keeps A live and the next source batch restores the aggregate without a read',async()=>{
    const inputs=[room(A),room(B),count] as const,initial=await Promise.all(inputs.map(snapshot));
    let reads=0;const lanes=new ReadLanes({origin:'https://synthetic.test',principal:VIEWER,sessionEpoch:1},()=>true);
    lanes.connected(1,['room-head','needs-you-count'],async input=>{reads++;return initial.find(value=>value.family===input.family&&(input.family!=='room-head'||value.scope===input.roomId))!;});
    for(const input of inputs)lanes.demand(input,{}, {isCurrent:()=>true});await settle();
    let armed=false,raced=0;
    const intercepted:SqlDatabase={query:(sql,args)=>db.query(sql,args),transaction:async work=>{
      const result=await db.transaction(work);
      // The RP transaction has committed and released its connection. Commit
      // B's revoke exactly before this real socket drain's enqueue fence.
      if(armed&&result&&typeof result==='object'&&'deliver'in result&&typeof result.deliver==='function'){
        armed=false;raced++;await revoke();
      }
      return result;
    }};
    let applied=Promise.resolve();const batches:LaneBatch[]=[],frames:Record<string,any>[]=[];
    const assembly=new RouterBatchAssembly(hash,batch=>{batches.push(batch);applied=lanes.accept(batch);},()=>{throw new Error('Unexpected assembly fault');});
    let completed:(()=>void)|undefined;const live=new LiveHub();
    const protocol=routerSocketProtocol(intercepted,VIEWER,raw=>{
      const frame=JSON.parse(raw);frames.push(frame);
      if(frame.kind==='push-part'||frame.kind==='push-commit')assembly.accept(frame);
      if(frame.kind==='push-commit')completed?.();
    },{families:['room-head','needs-you-count'],listenerReady:()=>true},{live,phone,rooms:()=>[A,B]});
    try{
      await protocol.handle({type:'router-negotiate',protocol:1,families:['room-head','needs-you-count']});
      await db.transaction(async tx=>{
        await tx.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES('allowed',$1,$3,'Allowed update'),('private',$2,$3,'@reader please approve private?')`,[A,B,OTHER]);
      });
      armed=true;const first=new Promise<void>(done=>{completed=done;});live.journalChanged([`workspace:${WS}`]);await first;await applied;
      expect(raced).toBe(1);expect(lanes.peek(room(A))).toMatchObject({state:'LIVE',cut:{through:batches[0]!.to.through}});
      expect(lanes.peek(room(B))).toMatchObject({state:'REVOKED',value:null});expect(lanes.peek(count).value).toBeNull();
      expect(JSON.stringify(frames)).not.toContain('please approve private');
      const second=new Promise<void>(done=>{completed=done;});live.journalChanged([`workspace:${WS}`]);await second;await applied;
      expect(lanes.peek(count)).toMatchObject({state:'LIVE',value:{count:0},cut:{through:batches[1]!.to.through}});
      expect(lanes.peek(room(A)).state).toBe('LIVE');expect(lanes.peek(room(B)).value).toBeNull();expect(reads).toBe(3);
    }finally{protocol.close();}
  });
  it('reparenting uses a child floor and exact parent denial, so a parent-only regrant is usable',async()=>{
    const initial=await snapshot(room(B));
    await db.query(`INSERT INTO rooms(id,workspace_id,created_by,name) VALUES($1,$2,$3,'Private parent')`,[P,WS,OTHER]);
    await db.query(`UPDATE rooms SET parent_id=$1 WHERE id=$2`,[P,B]);
    let safe:readonly RouterFact[]=[];await fenceRouterBatch(db,WS,VIEWER,[fact(initial)],facts=>{safe=facts;return undefined;});
    expect(safe.map(value=>value.payload)).toEqual([
      {kind:'authority-fence',scope:B,authorityScope:`room:${B}`,mode:'advance'},
      {kind:'authority-fence',scope:P,authorityScope:`room:${P}`,mode:'deny'},
    ]);
    expect(await currentAuthorityFence(db,VIEWER,B,`room:${B}`)).toMatchObject({mode:'advance'});
    const denied=safe[0]!.authority;
    await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'member')`,[WS,P,VIEWER]);
    const granted=await readRouterAuthority(db,room(B),VIEWER);
    expect(granted.scopes.find(value=>value.authorityScope===`room:${B}`)).toEqual(denied.scopes.find(value=>value.authorityScope===`room:${B}`));
    expect(BigInt(granted.scopes.find(value=>value.authorityScope===`room:${P}`)!.epoch)).toBeGreaterThan(BigInt(denied.scopes.find(value=>value.authorityScope===`room:${P}`)!.epoch));
    expect(routerAuthority(granted.scopes)).toEqual(granted);
  });
});
