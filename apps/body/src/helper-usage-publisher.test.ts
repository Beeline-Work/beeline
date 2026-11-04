import { describe, expect, it, vi } from 'vitest';
import type { AgentUsage } from '@beeline/api-contract/daemon';
import { UsageAccountPublisher, type UsageAccountTransport } from './helper-usage-publisher.js';
const usage:AgentUsage={updatedAt:100,windows:[{rateLimitType:'five_hour',status:'allowed',utilization:0.4,updatedAt:100}],
  account:{provider:'claude',key:'id:'+'a'.repeat(32)},read:{status:'fresh',at:100}};
function fixture(){
  let ownerId='owner-1';
  const publish=vi.fn(async()=>({ownerId,accountId:'1',revision:'b'.repeat(64)})),attach=vi.fn(async()=>undefined);
  const transport:UsageAccountTransport={scope:()=>({origin:'https://synthetic.invalid',ownerId,generation:1,source:{connectionId:'fixture-source',epoch:1}}),publish,attach};
  return {publisher:new UsageAccountPublisher(transport),publish,attach,transport,owner:(value:string)=>{ownerId=value;}};
}
describe('one source account publication per authenticated owner revision',()=>{
  it('joins concurrent sibling reads, attaches once, and posts zero repeated full snapshots',async()=>{
    const {publisher,publish,attach}=fixture();
    await Promise.all([publisher.deliver('agent-a',usage),publisher.deliver('agent-b',usage)]);
    expect(publish).toHaveBeenCalledTimes(1);expect(attach).toHaveBeenCalledTimes(1);
    for(let i=0;i<20;i++)await publisher.deliver('agent-b',usage);
    expect(publish).toHaveBeenCalledTimes(1);expect(attach).toHaveBeenCalledTimes(1);
    const newer={...usage,updatedAt:101,read:{status:'fresh' as const,at:101}};
    await Promise.all([publisher.deliver('agent-b',newer),publisher.deliver('agent-a',newer)]);
    expect(publish).toHaveBeenCalledTimes(2);expect(attach).toHaveBeenCalledTimes(1);
  });
  it('never reuses an old owner snapshot/reference after identity changes',async()=>{
    const {publisher,publish,attach,owner}=fixture();let finish!:(value:{ownerId:string;accountId:string;revision:string})=>void;
    publish.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
    const pending=publisher.deliver('agent-a',usage);owner('owner-2');finish({ownerId:'owner-1',accountId:'1',revision:'b'.repeat(64)});
    await expect(pending).rejects.toThrow('owner changed');expect(attach).not.toHaveBeenCalled();
    await publisher.deliver('agent-a',usage);expect(publish).toHaveBeenCalledTimes(2);
    expect(publish.mock.calls[0]?.[0]).not.toEqual(publish.mock.calls[1]?.[0]);
  });
  it('parks a failed immutable publication until an actual new source revision',async()=>{
    const {publisher,publish}=fixture();publish.mockRejectedValueOnce(new Error('uncertain response'));
    await expect(publisher.deliver('agent-a',usage)).rejects.toThrow('uncertain');
    await expect(publisher.deliver('agent-a',usage)).rejects.toThrow('uncertain');expect(publish).toHaveBeenCalledTimes(1);
    await publisher.deliver('agent-a',{...usage,updatedAt:102});expect(publish).toHaveBeenCalledTimes(2);
  });
  it('selects legacy explicitly when capability is absent, without a new publication',async()=>{
    const {transport,publish}=fixture();transport.scope=()=>undefined;
    expect(await new UsageAccountPublisher(transport).deliver('agent',usage)).toBe(false);expect(publish).not.toHaveBeenCalled();
  });
  it('resumes one uncertain immutable revision on a new authenticated actor and never repeats a confirmed publication',async()=>{
    const {publisher,publish,attach,transport}=fixture();let generation=1;
    transport.scope=()=>({origin:'https://recovery.invalid',ownerId:'owner-1',generation,source:{connectionId:'connection-'+generation,epoch:generation}});
    publish.mockRejectedValueOnce(new Error('receipt lost')).mockRejectedValueOnce(new Error('replacement receipt lost'));
    await expect(publisher.deliver('agent',usage)).rejects.toThrow('receipt lost');
    await expect(publisher.deliver('agent',usage)).rejects.toThrow('receipt lost');expect(publish).toHaveBeenCalledTimes(1);
    generation=2;await expect(publisher.deliver('agent',usage)).rejects.toThrow('replacement');
    await expect(publisher.deliver('agent',usage)).rejects.toThrow('replacement');expect(publish).toHaveBeenCalledTimes(2);
    generation=3;await publisher.deliver('agent',usage);expect(publish).toHaveBeenCalledTimes(3);
    expect(publish.mock.calls[0]?.[0].revision).toBe(publish.mock.calls[1]?.[0].revision);
    generation=4;await publisher.deliver('agent',usage);expect(publish).toHaveBeenCalledTimes(3);
    expect(attach).toHaveBeenCalledTimes(1);
    await publisher.deliver('agent',usage);expect(attach).toHaveBeenCalledTimes(1);
  });

});
