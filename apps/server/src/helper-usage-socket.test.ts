import { afterEach,describe,expect,it,vi } from 'vitest';
import { DaemonAgentSession,DaemonConnectionRegistry,type DaemonLiveDependencies } from './daemon-live.js';
import { LiveHub } from './live.js';
const agent='a'.repeat(64),owner='b'.repeat(64);
const sessions:DaemonAgentSession[]=[];
afterEach(()=>{for(const session of sessions.splice(0))session.close();vi.unstubAllEnvs();});
async function fixture(){
  vi.stubEnv('BEELINE_NETWORK_ROUTER_V1','1');const execute=vi.fn(async()=>({id:'ok',createdAt:1}));
  const replies:Record<string,unknown>[]=[],waiters:Array<(reply:Record<string,unknown>)=>void>=[];
  const database={query:vi.fn(async()=>({rows:[{owner_id:owner}],rowCount:1}))};
  const deps={database,live:new LiveHub(),daemon:{execute},registry:new DaemonConnectionRegistry(),
    connectionPresence:{claimConnection:async()=>1,releaseConnection:async()=>undefined},
    acquireLiveDbTask:async()=>()=>undefined,shuttingDown:()=>false,errors:{database:0,invalid:0,internal:0,overload:0},counters:{helperVersionRefusals:0,helperForceUpdates:0}} as unknown as DaemonLiveDependencies;
  const session=new DaemonAgentSession(deps,agent,{send:reply=>{replies.push(reply);waiters.shift()?.(reply);},isOpen:()=>true,drop:()=>undefined,admit:()=>true},{usageAccountV1:true});
  sessions.push(session);await session.claim();
  const source={connectionId:session.connectionId,epoch:1};
  const send=(operation:string,input:unknown)=>{
    const answer=new Promise<Record<string,unknown>>(resolve=>{waiters.push(resolve);});
    const request={type:'usage-operation',requestId:'fixture-request',operation,input};session.frame(request,Buffer.byteLength(JSON.stringify(request)));return answer;
  };
  return {execute,replies,send,source};
}
describe('owned server usage machine adapter codecs',()=>{
  it('refuses malformed params before dispatch and a forged source after exact parsing',async()=>{
    const {execute,send,source}=await fixture();
    expect(await send('attachAgentUsageAccount',{agentId:agent,source,account:{provider:'claude',key:'id:'+'e'.repeat(32)},revision:'c'.repeat(64),unknown:true})).toMatchObject({error:'usage_operation_invalid'});
    expect(execute).not.toHaveBeenCalled();
    expect(await send('attachAgentUsageAccount',{agentId:agent,source:{...source,connectionId:'forged'},account:{provider:'claude',key:'id:'+'e'.repeat(32)},revision:'c'.repeat(64)})).toMatchObject({error:'usage_operation_refused'});
    expect(execute).not.toHaveBeenCalled();
  });
  it('refuses an incomplete service result instead of serializing a successful reply',async()=>{
    const {execute,send,source}=await fixture();execute.mockResolvedValueOnce({} as never);
    expect(await send('attachAgentUsageAccount',{agentId:agent,source,account:{provider:'claude',key:'id:'+'e'.repeat(32)},revision:'c'.repeat(64)})).toMatchObject({error:'usage_operation_refused'});
    expect(execute).toHaveBeenCalledOnce();
  });
});
