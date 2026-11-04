import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RoomsMcp } from './rooms-mcp.js';
import { RoomsMcpOAuth } from './rooms-mcp-oauth.js';
import type { TokenAuth } from './auth.js';
import type { SqlDatabase } from './database.js';
import type { PhoneService } from './phone-service.js';
import { LiveHub } from './live.js';
const cleanups:Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const cleanup of cleanups.splice(0))await cleanup();vi.unstubAllEnvs();});
async function fixture(ready:boolean){
  const query=vi.fn(async()=>{throw new Error('unexpected application read');});
  // Keep origin/resource initialization identical to production; only the
  // authenticated principal and admission are synthetic in this zero-read proof.
  const oauth=new RoomsMcpOAuth({query} as unknown as SqlDatabase,'http://127.0.0.1',{} as TokenAuth);
  vi.spyOn(oauth,'principal').mockResolvedValue({hash:'synthetic',client_id:'client',identity_id:'owner',member_id:'member',scope:'rooms:read'});
  vi.spyOn(oauth,'take').mockResolvedValue(true);
  vi.spyOn(oauth,'audit').mockResolvedValue(undefined);
  const mcp=new RoomsMcp(oauth,{} as PhoneService,new LiveHub(),undefined,undefined,undefined,()=>ready);
  const server=createServer((request,response)=>{void mcp.handle(request,response).catch(()=>{response.statusCode=500;response.end();});});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  cleanups.push(async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));});
  return {origin,query};
}
describe('MCP member stream server-first negotiation',()=>{
  it.each([[undefined,false],[undefined,true],['0',false],['0',true],['1',false],['1',true]] as const)('advertises the enabled default or override with a ready listener (%s,%s)',async(setting,ready)=>{
    vi.stubEnv('BEELINE_NETWORK_ROUTER_V1',setting);
    const enabled=setting!=='0';
    const {origin,query}=await fixture(ready);
    const discovery=await fetch(origin+'/mcp',{method:'POST',headers:{authorization:'Bearer synthetic','content-type':'application/json'},
      body:JSON.stringify({jsonrpc:'2.0',id:1,method:'server/discover',params:{}})});
    expect(discovery.status).toBe(200);
    expect((await discovery.json() as any).result.capabilities.memberStreamV1).toBe(enabled&&ready);
    if(!enabled||!ready){
      const stream=await fetch(origin+'/mcp/member-stream?mentions=0',{headers:{authorization:'Bearer synthetic'}});
      expect(stream.status).toBe(409);expect(await stream.json()).toEqual({error:'member_stream_unavailable'});
    }
    expect(query).not.toHaveBeenCalled();
  });
});
