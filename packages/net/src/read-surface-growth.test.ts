import {createHash} from 'node:crypto';
import {describe,expect,it} from 'vitest';
import {routes} from './routes.js';
import {validateScheduledWorkProjection,validateWorkflowProjection} from './display-projections.js';
import {validateTrayProjection} from './private/owner-inputs.js';
import {validateNeedsProjection} from './private/projection-codecs.js';
import {validateNeedsRoomsPayload} from './private/needs-you-rooms.js';
import {ReadLanes,type LaneFact} from './private/read-lanes.js';
import {RouterBatchAssembly} from './private/batch-assembly.js';

const workspace='11111111-1111-4111-8111-111111111111';
const room='22222222-2222-4222-8222-222222222222';
const item=(n:number)=>({messageId:`question-${n}`,workspaceId:workspace,roomId:room,roomName:'Room',roomKind:'room' as const,text:'Please review?',createdAt:1});

describe('large complete read results',()=>{
  it('validates results above the former byte, node, validation-work and row quotas',()=>{
    const items=Array.from({length:6000},(_,n)=>item(n));
    const result={needs:{items},saved:{bookmarks:[]}};
    expect(Buffer.byteLength(JSON.stringify(result))).toBeGreaterThan(256*1024);
    expect(routes['phone.readTray'].result.parse(result)).toBe(result);
    expect(validateNeedsProjection(result.needs)).toBe(true);
    expect(validateTrayProjection({needs:result.needs,saved:{windowId:`saved1:${'a'.repeat(64)}`,rows:[]}},workspace)).toBe(true);
    expect(validateNeedsRoomsPayload({kind:'needs-you-rooms-replace',scope:workspace,count:items.length,
      order:items.map(item=>item.messageId),rooms:[{roomId:room,items}]})).toBe(true);
    expect(validateScheduledWorkProjection({roomName:'Room',agentNames:Array.from({length:101},(_,n)=>[String(n),'x'.repeat(1024)]),
      schedules:[],subscriptions:[]})).toBe(true);
    const workflows=Array.from({length:51},(_,n)=>({runId:String(n),workflowSlug:'review',description:'x'.repeat(2048),roomId:room,
      roomName:'Room',state:'review',status:'live',viewerHolds:false,startedAt:1,updatedAt:1}));
    expect(validateWorkflowProjection({workflows})).toBe(true);
    expect(()=>routes['phone.readTray'].result.parse({...result,needs:{items:[{...item(1),createdAt:'bad'}]}})).toThrow('contract mismatch');
  });

  it('assembles more than 16 parts and 256 authority domains with a large complete fact',()=>{
    const digest=(facts:unknown)=>createHash('sha256').update(JSON.stringify(facts)).digest('hex');
    const from={stream:`workspace:${workspace}`,epoch:'epoch',through:1,protocol:1 as const},to={...from,through:2};
    const facts:LaneFact[]=Array.from({length:1895},(_,n)=>({atomicGroup:`room-${n}`,authority:{digest:'valid',scopes:[{authorityScope:`room:${n}`,epoch:'1'}]},
      payload:{kind:'scope-replace',family:'room-head',scope:String(n),value:{text:n===0?'x'.repeat(1024*1024+1):'text'}}}));
    let committed=0,faults=0;
    const assembly=new RouterBatchAssembly(digest,batch=>{expect(batch.facts).toEqual(facts);committed++;},()=>{faults++;});
    const parts=Array.from({length:20},(_,n)=>facts.slice(n*100,(n+1)*100));
    const header={batchId:'large',from,to,partCount:parts.length,contentDigest:digest(facts)};
    for(const [partIndex,part]of parts.entries())assembly.accept({kind:'push-part',...header,partIndex,facts:part});
    expect(committed).toBe(0);assembly.accept({kind:'push-commit',...header});
    expect(faults).toBe(0);expect(committed).toBe(1);
  });

  it('automatically rebases an active roster search on a current authority floor and still hides it on denial',async()=>{
    const request={family:'workspace-roster',workspaceId:workspace,query:{revision:'1',q:'Helper'}} as const;
    const domain=`roster:${workspace}`;let reads=0,epoch='1';
    const lanes=new ReadLanes({origin:'https://example.test',principal:'reader',sessionEpoch:1},()=>true);
    lanes.connected(1,['workspace-roster'],async()=>({kind:'snapshot',family:'workspace-roster',scope:workspace,
      value:{revision:epoch,query:'Helper',result:++reads},cut:{stream:`workspace:${workspace}`,epoch:'stream',through:reads,protocol:1},
      atomicGroup:'roster-query',authority:{digest:`certificate-${epoch}`,scopes:[{authorityScope:domain,epoch}]}}));
    const live=()=>new Promise<void>(resolve=>{const stop=lanes.subscribe(request,()=>{if(lanes.peek(request).state==='LIVE'){stop();resolve();}});});
    let ready=live();const release=lanes.demand(request,{}, {isCurrent:()=>true});await ready;
    epoch='2';ready=live();await lanes.advance(domain,epoch,false);await ready;
    expect(reads).toBe(2);expect(lanes.peek(request)).toMatchObject({state:'LIVE',error:null,value:{revision:'2',query:'Helper'}});
    await lanes.revoke(domain,'3',false);expect(lanes.peek(request)).toMatchObject({state:'REVOKED',value:null});expect(reads).toBe(2);release();
  });
});
