import { DaemonService } from './daemon-service.js';
import { LiveHub } from './live.js';
import { POSTGRES_LIVE_CHANNEL } from './postgres-live.js';
import { saveAgentUsage } from './agent-usage.js';
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AgentUsage } from '@beeline/api-contract/daemon';
import { canonicalUsageAccountSnapshot } from '@beeline/api-contract/helper-usage';
import { migratedDatabase, type PgliteDatabase } from "../../../tests/helpers/server.js";
import { COMMAND_COMPLETION_CHANNEL,notifyCommandCompletion } from './command-completion.js';
import { HELPER_USAGE_SCHEMA, attachUsageAccount, fenceAgentUsageCellEnqueue, publishUsageAccount, readAgentUsageCell, subscribeAgentUsageCells } from './helper-usage.js';
const owner='a'.repeat(64),other='b'.repeat(64),first='c'.repeat(64),second='d'.repeat(64),outsider='e'.repeat(64);
const report=(at:number):AgentUsage=>({updatedAt:at,windows:[{rateLimitType:'five_hour',status:'allowed',utilization:0.4,updatedAt:at}],
  account:{provider:'claude',key:'id:'+'f'.repeat(32)},read:{status:'fresh',at}});
const source={connectionId:'fixture-source',epoch:1};
const publication=(usage:AgentUsage,ownerId=owner)=>({ownerId,usage,source,revision:createHash('sha256').update(canonicalUsageAccountSnapshot(usage,ownerId)).digest('hex')});
describe('owner-bound usage account publication and canonical cells',()=>{
  let db:PgliteDatabase,at:number,releaseHints:()=>Promise<void>;
  beforeAll(async()=>{
    db=await migratedDatabase();await db.query(HELPER_USAGE_SCHEMA);
    releaseHints=await db.client.listen(COMMAND_COMPLETION_CHANNEL,notifyCommandCompletion);at=Date.now()/1000-100;
    await db.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Owner'),($2,'human','Other'),
      ($3,'agent','First'),($4,'agent','Second'),($5,'agent','Outsider')`,[owner,other,first,second,outsider]);
    await db.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$3),($2,$3),($4,$5)`,[first,second,owner,outsider,other]);
    await db.query(`INSERT INTO agent_connections(agent_id,epoch,connection_id,instance_id) VALUES($1,1,'fixture-source','fixture'),($2,1,'fixture-source','fixture'),($3,1,'fixture-source','fixture')`,[first,second,outsider]);
  },60000);
  afterAll(async()=>{vi.useRealTimers();await releaseHints();await db.close();});
  it('stores an immutable source revision once, self-attaches, and attaches a sibling without reposting quota',async()=>{
    const input=publication(report(at));const result=await publishUsageAccount(db,first,input);
    const before=(await db.query('SELECT usage,source_revision,revision,updated_at FROM usage_accounts')).rows;
    const cellBefore=await readAgentUsageCell(db,first,owner);
    expect(await publishUsageAccount(db,first,input)).toEqual(result);
    expect((await db.query('SELECT usage,source_revision,revision,updated_at FROM usage_accounts')).rows).toEqual(before);
    expect(await readAgentUsageCell(db,first,owner)).toEqual(cellBefore);
    await attachUsageAccount(db,second,{source,account:input.usage.account!,revision:result.revision});
    const sibling=await readAgentUsageCell(db,second,owner);expect(sibling.allowed).toBe(true);
    if(sibling.allowed)expect(sibling.usage?.windows[0]?.utilization).toBe(0.4);
    const attached=await readAgentUsageCell(db,second,owner);
    await attachUsageAccount(db,second,{source,account:input.usage.account!,revision:result.revision});
    expect(await readAgentUsageCell(db,second,owner)).toEqual(attached);
    const withSibling=await readAgentUsageCell(db,first,owner);
    expect(withSibling.revision).toBeGreaterThan(cellBefore.revision);
    if(withSibling.allowed)expect(withSibling.usage?.sharedWith).toEqual(['Second']);
    await db.query('UPDATE agents SET usage_account_id=NULL WHERE agent_id=$1',[second]);
    const detached=await readAgentUsageCell(db,first,owner);
    expect(detached.revision).toBeGreaterThan(withSibling.revision);
    if(detached.allowed)expect(detached.usage?.sharedWith).toBeUndefined();
    await attachUsageAccount(db,second,{source,account:input.usage.account!,revision:result.revision});
  });
  it('rejects digest conflict, cross-owner references, and stale owner snapshots before changing data',async()=>{
    const input=publication(report(at));const published=await publishUsageAccount(db,first,input);
    await expect(publishUsageAccount(db,first,{...input,usage:report(at+1)})).rejects.toThrow('revision conflict');
    await expect(attachUsageAccount(db,outsider,{source,account:input.usage.account!,revision:published.revision})).rejects.toThrow('authority');
    await expect(publishUsageAccount(db,outsider,input)).rejects.toThrow('owner changed');
    await expect(publishUsageAccount(db,outsider,{...input,ownerId:other})).rejects.toThrow('revision conflict');
    const own=await publishUsageAccount(db,outsider,publication(report(at),other));expect(own.revision).not.toBe(published.revision);
  });
  it('refuses a replaced connection source before publishing or attaching',async()=>{
    const published=await publishUsageAccount(db,first,publication(report(at)));
    const before=(await db.query('SELECT usage,source_revision,revision FROM usage_accounts ORDER BY id')).rows;
    await db.query(`UPDATE agent_connections SET epoch=2,connection_id='replacement-source' WHERE agent_id=$1`,[first]);
    await expect(publishUsageAccount(db,first,publication(report(at+5)))).rejects.toThrow('source ownership changed');
    await expect(attachUsageAccount(db,first,{source,account:report(at).account!,revision:published.revision})).rejects.toThrow('source ownership changed');
    expect((await db.query('SELECT usage,source_revision,revision FROM usage_accounts ORDER BY id')).rows).toEqual(before);
    await db.query(`UPDATE agent_connections SET epoch=1,connection_id='fixture-source' WHERE agent_id=$1`,[first]);
  });
  it('fences older source completion and sends only a content-free denial after owner reassignment',async()=>{
    const newest=await publishUsageAccount(db,first,publication(report(at+20)));
    const older=await publishUsageAccount(db,first,publication(report(at+10)));
    expect(older).toEqual({...newest,superseded:true});
    const prepared=await readAgentUsageCell(db,second,owner);expect(prepared.allowed).toBe(true);
    await db.query('UPDATE agents SET owner_id=$2 WHERE agent_id=$1',[second,other]);
    const delivered:unknown[]=[];await fenceAgentUsageCellEnqueue(db,owner,prepared,cell=>{delivered.push(cell);});
    expect(delivered).toEqual([expect.objectContaining({allowed:false,ownerId:owner,agentId:second})]);
    expect(delivered[0]).not.toHaveProperty('usage');
    const newOwner=await readAgentUsageCell(db,second,other);expect(newOwner).toMatchObject({allowed:true,usage:null});
    await expect(publishUsageAccount(db,second,publication(report(at+30)))).rejects.toThrow('owner changed');
  });
  it('has no idle observations and delivers one complete small cell from a real committed account source',async()=>{
    vi.useFakeTimers();
    const delivered=vi.fn(),unavailable=vi.fn();let ready!:()=>void,done!:()=>void;
    const started=new Promise<void>(resolve=>{ready=resolve;}),changed=new Promise<void>(resolve=>{done=resolve;});
    const stop=subscribeAgentUsageCells(db,owner,cell=>{delivered(cell);done();},unavailable,ready);
    try{
      await started;expect(delivered).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(86_400_000);expect(delivered).not.toHaveBeenCalled();vi.useRealTimers();
      await db.query('UPDATE agents SET updated_at=now() WHERE agent_id=$1',[first]);expect(delivered).not.toHaveBeenCalled();
      await publishUsageAccount(db,first,publication(report(at+40)));await changed;
      expect(delivered).toHaveBeenCalledOnce();expect(delivered.mock.calls[0]?.[0]).toMatchObject({v:1,ownerId:owner,agentId:first,allowed:true,usage:{windows:[{utilization:0.4}]}});
      expect(unavailable).not.toHaveBeenCalled();
    }finally{stop();vi.useRealTimers();await db.query('SELECT 1');}
  });

  it('rejects stale/duplicate source counters and digest reuse without announcing accepted freshness',async()=>{
    const usage={updatedAt:Date.now()/1000,windows:[],context:{used:100,size:1000}};
    const usageSource={v:1 as const,ownerId:owner,source,revision:1};
    expect(await saveAgentUsage(db,first,usage,usageSource)).toBe(true);
    const before=await readAgentUsageCell(db,first,owner);
    expect(await saveAgentUsage(db,first,usage,usageSource)).toBe(false);expect(await readAgentUsageCell(db,first,owner)).toEqual(before);
    await expect(saveAgentUsage(db,first,{...usage,context:{used:999,size:1000}},usageSource)).rejects.toThrow('revision conflict');
    expect(await saveAgentUsage(db,first,{...usage,context:{used:300,size:1000}},{...usageSource,revision:3})).toBe(true);
    expect(await saveAgentUsage(db,first,{...usage,context:{used:200,size:1000}},{...usageSource,revision:2})).toBe(false);
    const current=await readAgentUsageCell(db,first,owner);if(current.allowed)expect(current.usage?.context?.used).toBe(300);
  });

  it('does not announce a fresh completion for a stale or duplicate source through the actual daemon operation',async()=>{
    const daemon=new DaemonService(db,new LiveHub()),refreshes:unknown[]=[];
    const release=await db.client.listen(POSTGRES_LIVE_CHANNEL,payload=>{const value=JSON.parse(payload);if(value.table==='agent_usage_refresh_result')refreshes.push(value);});
    const usage={updatedAt:Date.now()/1000,windows:[],context:{used:400,size:1000},read:{status:'fresh' as const,at:Date.now()/1000}};
    const usageSource={v:1 as const,ownerId:owner,source,revision:4};
    try{
      await daemon.execute('postAgentUsage',{agentId:first,usage,usageSource},first);expect(refreshes).toHaveLength(1);
      await daemon.execute('postAgentUsage',{agentId:first,usage,usageSource},first);
      await daemon.execute('postAgentUsage',{agentId:first,usage,usageSource:{...usageSource,revision:3}},first);
      expect(refreshes).toHaveLength(1);
    }finally{await release();}
  });
  it('invalidates a bound revision when an old helper changes its body between publish and attach',async()=>{
    const input=publication(report(at+40)),published=await publishUsageAccount(db,first,input);
    await saveAgentUsage(db,first,{updatedAt:Date.now()/1000,windows:[{rateLimitType:'five_hour',status:'allowed',utilization:0.8,updatedAt:Date.now()/1000}]});
    const stored=(await db.query<{revision:string|null;source_revision:string|null}>(`SELECT revision,source_revision FROM usage_accounts WHERE owner_id=$1`,[owner])).rows[0]!;
    expect(stored).toEqual({revision:null,source_revision:null});
    await expect(attachUsageAccount(db,first,{source,account:input.usage.account!,revision:published.revision})).rejects.toThrow('authority');
    await expect(publishUsageAccount(db,first,input)).rejects.toThrow('superseded');
    const newer=await publishUsageAccount(db,first,publication(report(Date.now()/1000+100)));
    expect(newer.revision).toMatch(/^[a-f0-9]{64}$/);expect(newer.revision).not.toBe(published.revision);
    await expect(db.query(`UPDATE usage_accounts SET owner_id=$2 WHERE id=$1::bigint`,[newer.accountId,other])).rejects.toThrow('usage_account_identity_immutable');
  });

});
