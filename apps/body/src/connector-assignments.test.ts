import {describe,expect,it,vi} from 'vitest';
import {ConnectorAssignmentLoop} from './connector-assignments.js';

describe('machine broker observations',()=>{
  it('defers an unavailable probe and sends its next successful observation without a broken verdict',async()=>{
    const execute=vi.fn(async(name:string)=>name==='getConnectorAssignments'?{assignments:[]}:{id:'report',createdAt:1});
    const log=vi.fn();
    const readVault=vi.fn().mockRejectedValueOnce(new Error('Squire MCP session closed')).mockResolvedValue([]);
    const loop=new ConnectorAssignmentLoop({agentId:'agent',api:{execute:execute as never},mcp:{call:async()=>({})},brokerInstalled:()=>true,readVault,log});
    await loop.runOnce();
    await vi.waitFor(()=>expect(log).toHaveBeenCalledWith('Squire vault observation unavailable: Squire MCP connection closed'));
    expect(execute.mock.calls.filter(([name])=>name==='postConnectorVault')).toHaveLength(0);
    await loop.runOnce();
    await vi.waitFor(()=>expect(execute).toHaveBeenCalledWith('postConnectorVault',{agentId:'agent',connections:[]}));
    loop.stop();
  });

  it('leaves a lost report for the next report boundary without posting a transport error as broker state',async()=>{
    const execute=vi.fn(async(name:string)=>{
      if(name==='getConnectorAssignments')return {assignments:[]};
      if(execute.mock.calls.filter(([operation])=>operation==='postConnectorVault').length===1)
        throw new Error('Machine operation outcome is UNKNOWN; no HTTP fallback');
      return {id:'report',createdAt:1};
    });
    const log=vi.fn();
    const loop=new ConnectorAssignmentLoop({agentId:'agent',api:{execute:execute as never},mcp:{call:async()=>({})},brokerInstalled:()=>true,readVault:async()=>[],log});
    await loop.runOnce();
    await vi.waitFor(()=>expect(log).toHaveBeenCalledOnce());
    await loop.runOnce();
    await vi.waitFor(()=>expect(execute.mock.calls.filter(([name])=>name==='postConnectorVault')).toHaveLength(2));
    expect(execute).toHaveBeenCalledWith('postConnectorVault',{agentId:'agent',connections:[]});
    expect(execute.mock.calls.some(([name])=>name==='postConnectorStatus')).toBe(false);
    loop.stop();
  });
});
