import {afterEach,expect,it,vi} from 'vitest';
import {SquireShareRenewals,renewSquireShareOnViewerActivity} from './squire-share-renewals.js';
import type {StdioSquireMcpClient} from './squire-mcp-client.js';
const url='https://browser.trycloudflare.com/s/'+'a'.repeat(43)+'/';
const result=(expiresAt:number)=>({content:[{type:'text',text:JSON.stringify({url,expires_at:new Date(expiresAt).toISOString()})}]});
const closes:(()=>void)[]=[];
afterEach(()=>{for(const close of closes.splice(0))close();vi.useRealTimers();});
const flush=async()=>{for(let i=0;i<8;i++)await Promise.resolve();};
it('renews only on actual viewer activity and persists that lease once',async()=>{
  vi.useFakeTimers();const now=Date.now(),requestMcp=vi.fn(async()=>result(now+120_000)),persist=vi.fn(async()=>true);
  const renewals=new SquireShareRenewals(()=>true,persist,()=>{});closes.push(()=>renewals.close());
  renewals.track('session',{requestMcp} as unknown as StdioSquireMcpClient,result(now+60_000));
  await vi.advanceTimersByTimeAsync(30_000);expect(requestMcp).not.toHaveBeenCalled();
  renewSquireShareOnViewerActivity('session');await flush();
  expect(requestMcp).toHaveBeenCalledTimes(1);expect(requestMcp).toHaveBeenCalledWith('tools/call',{name:'operate_share',arguments:{session_id:'session'}});
  expect(persist).toHaveBeenCalledTimes(1);expect(persist).toHaveBeenCalledWith({sessionId:'session',upstreamUrl:url,expiresAt:now+120_000});
  await vi.advanceTimersByTimeAsync(60_000);expect(requestMcp).toHaveBeenCalledOnce();
});
it('coalesces overlapping viewer activity and never revives an expired or replaced owner',async()=>{
  const now=Date.now();let release!:(value:unknown)=>void;
  const requestMcp=vi.fn(()=>new Promise(resolve=>{release=resolve;})),persist=vi.fn(async()=>true);
  let owned=true;const reaped=vi.fn();const renewals=new SquireShareRenewals(()=>owned,persist,reaped);closes.push(()=>renewals.close());
  renewals.track('session',{requestMcp} as unknown as StdioSquireMcpClient,result(now+60_000));
  renewSquireShareOnViewerActivity('session');renewSquireShareOnViewerActivity('session');expect(requestMcp).toHaveBeenCalledOnce();
  owned=false;release(result(now+120_000));await flush();expect(persist).not.toHaveBeenCalled();expect(reaped).toHaveBeenCalledWith('session');
  renewSquireShareOnViewerActivity('session');expect(requestMcp).toHaveBeenCalledOnce();
});
