import { describe, expect, it } from 'vitest';
import { readAgentUsage, type AgentUsage } from './agent-usage.js';
import { canonicalUsageAccountSnapshot } from './helper-usage.js';

describe('canonical account snapshot identity',()=>{
  it('hashes the same normalized provider text on both sides of the wire',()=>{
    const usage:AgentUsage={updatedAt:100,account:{provider:'claude',key:'id:'+'a'.repeat(32)},
      plan:'  Synthetic\n plan  ',windows:[{rateLimitType:'five_hour',status:'allowed',utilization:0.5,updatedAt:100,label:'  Provider\t window '}],
      read:{status:'failed',at:100,reason:'  provider\n'+ 'long reason '.repeat(20)}};
    const normalized=readAgentUsage(usage)!;
    expect(normalized.plan).toBe('Synthetic plan');
    expect(normalized.read?.reason?.length).toBe(60);
    expect(canonicalUsageAccountSnapshot(usage,'owner')).toBe(canonicalUsageAccountSnapshot(normalized,'owner'));
    const longNames={...usage,plan:'x'.repeat(41),windows:[{...usage.windows[0]!,label:'y'.repeat(41)}]};
    expect(canonicalUsageAccountSnapshot(longNames,'owner')).toBe(canonicalUsageAccountSnapshot(readAgentUsage(longNames)!,'owner'));
    expect(canonicalUsageAccountSnapshot(usage,'other')).not.toBe(canonicalUsageAccountSnapshot(usage,'owner'));
  });
  it('refuses invalid accounts and per-agent spend or free allowance before normalization',()=>{
    const usage:AgentUsage={updatedAt:100,windows:[],account:{provider:'claude',key:'id:'+'a'.repeat(32)}};
    expect(()=>canonicalUsageAccountSnapshot({...usage,account:{provider:'claude',key:'invalid'}})).toThrow('snapshot required');
    expect(()=>canonicalUsageAccountSnapshot({...usage,spend:{today:1}})).toThrow('snapshot required');
    expect(()=>canonicalUsageAccountSnapshot({...usage,free:{used:1,limit:2,resetsAt:100}})).toThrow('snapshot required');
  });
});
