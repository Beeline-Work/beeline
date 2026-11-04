import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DaemonApiClient } from './daemon-api-client.js';
import { HarnessQuotaReader } from './harness-quota.js';
import { QUOTA_AXI_CLAUDE_REPORT } from './harness-quota.fixtures.js';
import { helperUsageBinding } from './helper-usage-binding.js';
afterEach(()=>vi.restoreAllMocks());
describe('real quota reader through negotiated daemon publication adapter',()=>{
  it('shares one provider read and one account publication across two actual agent readers',async()=>{
    const origin=`https://${randomUUID()}.invalid`,ownerId='synthetic-owner',calls:Array<{agent:string;name:string;input:any}>=[];
    const report={...QUOTA_AXI_CLAUDE_REPORT,providers:[{...QUOTA_AXI_CLAUDE_REPORT.providers[0],account:{accountId:'synthetic-account',organization:'synthetic-org',identityStatus:'verified'}}]};
    const run=vi.fn(async()=>JSON.stringify(report)),slots=new Map();
    const reader=(agentId:string)=>{
      const api={agentId,channel:{usageAccountScope:()=>({origin,ownerId,generation:1,source:{connectionId:'fixture-source',epoch:1}})},execute:async(name:string,input:unknown)=>{
        calls.push({agent:agentId,name,input});return name==='publishAgentUsageAccount'?{ownerId,accountId:'1',revision:'b'.repeat(64)}:{id:'ok'};
      }} as unknown as DaemonApiClient;
      return new HarnessQuotaReader({agentId,slots,run,accountPublisher:helperUsageBinding(api),post:usage=>api.execute('postAgentUsage',{agentId,usage}),
        now:()=>100_000,credentialPath:()=>'/synthetic/fixture/credentials',fingerprint:()=> 'fixture-only',launch:()=>({command:'synthetic-node',args:[]})});
    };
    const first=reader('agent-a'),second=reader('agent-b');
    await Promise.all([first.publish('claude',{}),second.publish('claude',{})]);
    expect(run).toHaveBeenCalledTimes(1);
    expect(calls.map(call=>call.name).sort()).toEqual(['attachAgentUsageAccount','publishAgentUsageAccount']);
    await first.publish('claude',{});await second.publish('claude',{});expect(calls).toHaveLength(2);
    expect(calls.find(call=>call.name==='publishAgentUsageAccount')?.input).toMatchObject({ownerId,revision:expect.stringMatching(/^[a-f0-9]{64}$/)});
  });
  it('preserves initial legacy mode and never downgrades a selected account publication after capability loss',async()=>{
    const scope={origin:`https://${randomUUID()}.invalid`,ownerId:'owner',generation:1,source:{connectionId:'fixture-source',epoch:1}};let capable=false;
    const execute=vi.fn(async()=>({ownerId:'owner',accountId:'1',revision:'c'.repeat(64)}));
    const api={agentId:'agent',channel:{usageAccountScope:()=>capable?scope:undefined},execute} as unknown as DaemonApiClient;
    const binding=helperUsageBinding(api),usage={updatedAt:100,windows:[],account:{provider:'claude',key:'id:'+'e'.repeat(32)}};
    expect(await binding.deliver(usage)).toBe(false);expect(execute).not.toHaveBeenCalled();
    capable=true;expect(await binding.deliver(usage)).toBe(true);expect(execute).toHaveBeenCalledTimes(1);
    capable=false;await expect(binding.deliver(usage)).rejects.toThrow('unavailable');expect(execute).toHaveBeenCalledTimes(1);
  });
  it.each(['owner','connection'] as const)('never republishes a late provider read across a changed %s source',async changed=>{
    let ownerId='old-owner',generation=1,finish!:(report:string)=>void;
    const scope=()=>({origin:`https://late-owner.invalid`,ownerId,generation,source:{connectionId:'fixture-source-'+generation,epoch:generation}});
    const execute=vi.fn(async()=>({ownerId,accountId:'1',revision:'d'.repeat(64)}));
    const api={agentId:'late-agent',channel:{usageAccountScope:scope},execute} as unknown as DaemonApiClient;
    const run=vi.fn(()=>new Promise<string>(resolve=>{finish=resolve;}));
    const reader=new HarnessQuotaReader({agentId:'late-agent',slots:new Map(),run,accountPublisher:helperUsageBinding(api),post:usage=>api.execute('postAgentUsage',{agentId:'late-agent',usage}),
      now:()=>100_000,credentialPath:()=>'/synthetic/owner-change/credentials',fingerprint:()=> 'fixture',launch:()=>({command:'synthetic',args:[]})});
    const reading=reader.publish('claude',{});if(changed==='owner')ownerId='new-owner';else generation++;finish(JSON.stringify(QUOTA_AXI_CLAUDE_REPORT));
    expect(await reading).toEqual({status:'failed',reason:'usage ownership changed during read'});expect(execute).not.toHaveBeenCalled();
  });

  it('resolves a completed cached provider revision once on a new authenticated actor, without another provider read',async()=>{
    let generation=1;
    const origin=`https://${randomUUID()}.invalid`,ownerId='recovery-owner';
    const scope=()=>({origin,ownerId,generation,source:{connectionId:'source-'+generation,epoch:generation}});
    const execute=vi.fn(async(name:string)=>{
      if(name==='publishAgentUsageAccount'&&generation<3)throw new Error('uncertain response');
      return {ownerId,accountId:'1',revision:'d'.repeat(64)};
    });
    const api={agentId:'recovery-agent',channel:{usageAccountScope:scope},execute} as unknown as DaemonApiClient;
    const run=vi.fn(async()=>JSON.stringify(QUOTA_AXI_CLAUDE_REPORT));
    const reader=new HarnessQuotaReader({agentId:api.agentId,slots:new Map(),run,accountPublisher:helperUsageBinding(api),post:usage=>api.execute('postAgentUsage',{agentId:api.agentId,usage}),
      now:()=>100_000,credentialPath:()=>'/synthetic/recovery/credentials',fingerprint:()=> 'fixture',launch:()=>({command:'synthetic',args:[]})});
    const publish=()=>reader.publish('claude',{});
    expect(await publish()).toMatchObject({status:'failed'});await publish();expect(execute).toHaveBeenCalledTimes(1);
    generation=2;expect(await publish()).toMatchObject({status:'failed'});await publish();expect(execute).toHaveBeenCalledTimes(2);
    generation=3;await publish();await publish();expect(execute).toHaveBeenCalledTimes(3);
    generation=4;await publish();await publish();
    expect(execute.mock.calls.map(([name])=>name)).toEqual(['publishAgentUsageAccount','publishAgentUsageAccount','publishAgentUsageAccount','attachAgentUsageAccount']);
    expect(run).toHaveBeenCalledTimes(1);
  });

});
