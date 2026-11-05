import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, link, symlink, rm, stat, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { countCornerFolders, sampleHelperUsage } from './helper-usage.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
describe.skipIf(process.platform !== 'linux')('host usage observations', () => {
  it('counts allocated blocks once, does not follow links, and preserves directory access time', async () => {
    const root = await mkdtemp(join(tmpdir(), 'beeline-usage-')); roots.push(root);
    const modules = join(root, 'corners', 'example', 'node_modules');
    await mkdir(modules, { recursive: true });
    const file = join(modules, 'package');
    await writeFile(file, 'x'.repeat(8192));
    await link(file, join(modules, 'duplicate'));
    await symlink('/usr', join(root, 'external'));
    const old = new Date('2000-01-01'); await utimes(modules, old, old);
    const result = await sampleHelperUsage(root, 'disk') as { categories: Record<string, { allocatedBytes: number; entries: number }>; errors: number };
    expect(result.errors).toBe(0);
    expect(result.categories['corners:dependencies'].entries).toBe(2);
    expect(result.categories['corners:dependencies'].allocatedBytes).toBe(((await stat(file)).blocks + (await stat(modules)).blocks) * 512);
    expect(result.categories['external:other'].entries).toBe(1);
    expect((await stat(modules)).atimeMs).toBe(old.getTime());
  });
  it('observes the calling helper without reporting command arguments', async () => {
    const root = await mkdtemp(join(tmpdir(), 'beeline-usage-')); roots.push(root);
    const result = await sampleHelperUsage(root, 'process') as { categories: Record<string, { count: number; rssBytes: number }> };
    expect(result.categories.helper.count).toBe(1);
    expect(result.categories.helper.rssBytes).toBeGreaterThan(0);
    expect(JSON.stringify(result)).not.toContain(root);
  });
});

it('counts open, orphaned and unknown folders from lifecycle evidence, preserving unknown on missing facts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'beeline-folder-count-')); roots.push(root);
  for (const name of ['open', 'archived', 'ended', 'unknown'])
    await mkdir(join(root, 'beeline/corners', name), { recursive: true });
  await mkdir(join(root, 'beeline/storage-owners'));
  await writeFile(join(root, 'beeline/storage-owners/corners-ended.json'), JSON.stringify({
    kind: 'corners', itemId: 'ended', roomId: 'ended', ended: true,
  }));
  await symlink('/usr', join(root, 'beeline/corners/link'));
  expect(await countCornerFolders(root, new Map([['open', false], ['archived', true]])))
    .toEqual({ open: 1, orphaned: 2, unknown: 1 });
  expect(await countCornerFolders(root, new Map()))
    .toEqual({ open: 0, orphaned: 1, unknown: 3 });
});

import { randomUUID as m19_randomUUID } from 'node:crypto';

import { afterEach as m19_afterEach, describe as m19_describe, expect as m19_expect, it as m19_it, vi as m19_vi } from 'vitest';

import type { DaemonApiClient as m19_DaemonApiClient } from "./daemon-api-client.js";

import { HarnessQuotaReader as m19_HarnessQuotaReader } from "./harness-quota.js";

import { QUOTA_AXI_CLAUDE_REPORT as m19_QUOTA_AXI_CLAUDE_REPORT } from "../../../tests/helpers/helper.js";

import { helperUsageBinding as m19_helperUsageBinding } from "./helper-usage-binding.js";
import { describe as mergedDescribe19 } from 'vitest';
mergedDescribe19("helper-usage.integration.test.ts", () => {

m19_afterEach(()=>m19_vi.restoreAllMocks());

m19_describe('real quota reader through negotiated daemon publication adapter',()=>{
  m19_it('shares one provider read and one account publication across two actual agent readers',async()=>{
    const origin=`https://${m19_randomUUID()}.invalid`,ownerId='synthetic-owner',calls:Array<{agent:string;name:string;input:any}>=[];
    const report={...m19_QUOTA_AXI_CLAUDE_REPORT,providers:[{...m19_QUOTA_AXI_CLAUDE_REPORT.providers[0],account:{accountId:'synthetic-account',organization:'synthetic-org',identityStatus:'verified'}}]};
    const run=m19_vi.fn(async()=>JSON.stringify(report)),slots=new Map();
    const reader=(agentId:string)=>{
      const api={agentId,channel:{usageAccountScope:()=>({origin,ownerId,generation:1,source:{connectionId:'fixture-source',epoch:1}})},execute:async(name:string,input:unknown)=>{
        calls.push({agent:agentId,name,input});return name==='publishAgentUsageAccount'?{ownerId,accountId:'1',revision:'b'.repeat(64)}:{id:'ok'};
      }} as unknown as m19_DaemonApiClient;
      return new m19_HarnessQuotaReader({agentId,slots,run,accountPublisher:m19_helperUsageBinding(api),post:usage=>api.execute('postAgentUsage',{agentId,usage}),
        now:()=>100_000,credentialPath:()=>'/synthetic/fixture/credentials',fingerprint:()=> 'fixture-only',launch:()=>({command:'synthetic-node',args:[]})});
    };
    const first=reader('agent-a'),second=reader('agent-b');
    await Promise.all([first.publish('claude',{}),second.publish('claude',{})]);
    m19_expect(run).toHaveBeenCalledTimes(1);
    m19_expect(calls.map(call=>call.name).sort()).toEqual(['attachAgentUsageAccount','publishAgentUsageAccount']);
    await first.publish('claude',{});await second.publish('claude',{});m19_expect(calls).toHaveLength(2);
    m19_expect(calls.find(call=>call.name==='publishAgentUsageAccount')?.input).toMatchObject({ownerId,revision:m19_expect.stringMatching(/^[a-f0-9]{64}$/)});
  });
  m19_it('preserves initial legacy mode and never downgrades a selected account publication after capability loss',async()=>{
    const scope={origin:`https://${m19_randomUUID()}.invalid`,ownerId:'owner',generation:1,source:{connectionId:'fixture-source',epoch:1}};let capable=false;
    const execute=m19_vi.fn(async()=>({ownerId:'owner',accountId:'1',revision:'c'.repeat(64)}));
    const api={agentId:'agent',channel:{usageAccountScope:()=>capable?scope:undefined},execute} as unknown as m19_DaemonApiClient;
    const binding=m19_helperUsageBinding(api),usage={updatedAt:100,windows:[],account:{provider:'claude',key:'id:'+'e'.repeat(32)}};
    m19_expect(await binding.deliver(usage)).toBe(false);m19_expect(execute).not.toHaveBeenCalled();
    capable=true;m19_expect(await binding.deliver(usage)).toBe(true);m19_expect(execute).toHaveBeenCalledTimes(1);
    capable=false;await m19_expect(binding.deliver(usage)).rejects.toThrow('unavailable');m19_expect(execute).toHaveBeenCalledTimes(1);
  });
  m19_it.each(['owner','connection'] as const)('never republishes a late provider read across a changed %s source',async changed=>{
    let ownerId='old-owner',generation=1,finish!:(report:string)=>void;
    const scope=()=>({origin:`https://late-owner.invalid`,ownerId,generation,source:{connectionId:'fixture-source-'+generation,epoch:generation}});
    const execute=m19_vi.fn(async()=>({ownerId,accountId:'1',revision:'d'.repeat(64)}));
    const api={agentId:'late-agent',channel:{usageAccountScope:scope},execute} as unknown as m19_DaemonApiClient;
    const run=m19_vi.fn(()=>new Promise<string>(resolve=>{finish=resolve;}));
    const reader=new m19_HarnessQuotaReader({agentId:'late-agent',slots:new Map(),run,accountPublisher:m19_helperUsageBinding(api),post:usage=>api.execute('postAgentUsage',{agentId:'late-agent',usage}),
      now:()=>100_000,credentialPath:()=>'/synthetic/owner-change/credentials',fingerprint:()=> 'fixture',launch:()=>({command:'synthetic',args:[]})});
    const reading=reader.publish('claude',{});if(changed==='owner')ownerId='new-owner';else generation++;finish(JSON.stringify(m19_QUOTA_AXI_CLAUDE_REPORT));
    m19_expect(await reading).toEqual({status:'failed',reason:'usage ownership changed during read'});m19_expect(execute).not.toHaveBeenCalled();
  });

  m19_it('resolves a completed cached provider revision once on a new authenticated actor, without another provider read',async()=>{
    let generation=1;
    const origin=`https://${m19_randomUUID()}.invalid`,ownerId='recovery-owner';
    const scope=()=>({origin,ownerId,generation,source:{connectionId:'source-'+generation,epoch:generation}});
    const execute=m19_vi.fn(async(name:string)=>{
      if(name==='publishAgentUsageAccount'&&generation<3)throw new Error('uncertain response');
      return {ownerId,accountId:'1',revision:'d'.repeat(64)};
    });
    const api={agentId:'recovery-agent',channel:{usageAccountScope:scope},execute} as unknown as m19_DaemonApiClient;
    const run=m19_vi.fn(async()=>JSON.stringify(m19_QUOTA_AXI_CLAUDE_REPORT));
    const reader=new m19_HarnessQuotaReader({agentId:api.agentId,slots:new Map(),run,accountPublisher:m19_helperUsageBinding(api),post:usage=>api.execute('postAgentUsage',{agentId:api.agentId,usage}),
      now:()=>100_000,credentialPath:()=>'/synthetic/recovery/credentials',fingerprint:()=> 'fixture',launch:()=>({command:'synthetic',args:[]})});
    const publish=()=>reader.publish('claude',{});
    m19_expect(await publish()).toMatchObject({status:'failed'});await publish();m19_expect(execute).toHaveBeenCalledTimes(1);
    generation=2;m19_expect(await publish()).toMatchObject({status:'failed'});await publish();m19_expect(execute).toHaveBeenCalledTimes(2);
    generation=3;await publish();await publish();m19_expect(execute).toHaveBeenCalledTimes(3);
    generation=4;await publish();await publish();
    m19_expect(execute.mock.calls.map(([name])=>name)).toEqual(['publishAgentUsageAccount','publishAgentUsageAccount','publishAgentUsageAccount','attachAgentUsageAccount']);
    m19_expect(run).toHaveBeenCalledTimes(1);
  });

});
});
