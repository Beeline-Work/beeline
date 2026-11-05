import { describe,expect,it,vi } from 'vitest';
import type { CommandActivationInput,CommandActivationSnapshot } from '@beeline/api-contract/helper-activation';
import { CommandActivationContext,type ActivationTransport } from './helper-activation-context.js';
const input={agentId:'agent',workspaceId:'workspace',roomId:'room',commandId:'command',generationId:'generation'};
const snapshot=(identity:CommandActivationInput):CommandActivationSnapshot=>({...identity,v:1,capturedAt:100,authority:{generation:'a'.repeat(32),revision:1,commandRevision:'b'.repeat(64)},
  configuration:{fastMode:false,commands:[],yoloMode:false,isReviewer:false},roster:{members:[]},grants:{grants:[]},repository:{resolution:'none'}});
describe('command setup admission and reuse',()=>{
  it('joins repeated setup consumers and never writes or requests a second snapshot for the same command',async()=>{
    const scope={origin:'https://synthetic.invalid',generation:1,source:{connectionId:'source',epoch:1}};
    const read=vi.fn(async(value:CommandActivationInput)=>snapshot(value));
    const context=new CommandActivationContext({scope:()=>scope,selected:()=>true,read},()=>100);
    const values=await Promise.all(Array.from({length:20},()=>context.read(input)));
    expect(new Set(values).size).toBe(1);expect(read).toHaveBeenCalledTimes(1);
    await context.read({...input,commandId:'next-command'});expect(read).toHaveBeenCalledTimes(2);
  });
  it('parks failed captures until an actual different connection or command and never downgrades selected mode',async()=>{
    let generation=1,available=false;const read=vi.fn(async(value:CommandActivationInput)=>snapshot(value));
    read.mockRejectedValueOnce(new Error('capture unavailable'));
    const transport:ActivationTransport={scope:()=>available?{origin:'https://synthetic.invalid',generation,source:{connectionId:'source-'+generation,epoch:generation}}:undefined,selected:()=>false,read};
    const context=new CommandActivationContext(transport,()=>100);
    expect(await context.read(input)).toBeUndefined();expect(read).not.toHaveBeenCalled();
    available=true;await expect(context.read(input)).rejects.toThrow('capture unavailable');
    await expect(context.read(input)).rejects.toThrow('capture unavailable');expect(read).toHaveBeenCalledTimes(1);
    generation++;await context.read(input);expect(read).toHaveBeenCalledTimes(2);
    available=false;await expect(context.read(input)).rejects.toThrow('parked');expect(read).toHaveBeenCalledTimes(2);
  });
  it('refuses a late old-actor result and an expired held grant without refetching',async()=>{
    let generation=1,at=100,finish!:(snapshot:CommandActivationSnapshot)=>void;
    const read=vi.fn((value:CommandActivationInput)=>generation===1?new Promise<CommandActivationSnapshot>(resolve=>{finish=resolve;}):Promise.resolve({...snapshot(value),validUntil:101}));
    const context=new CommandActivationContext({scope:()=>({origin:'https://synthetic.invalid',generation,source:{connectionId:'source-'+generation,epoch:generation}}),selected:()=>true,read},()=>at);
    const pending=context.read(input);generation=2;finish(snapshot({...input,source:{connectionId:'source-1',epoch:1}}));
    await expect(pending).rejects.toThrow('ownership changed');await context.read(input);at=102;
    await expect(context.read(input)).rejects.toThrow('expired');expect(read).toHaveBeenCalledTimes(2);
  });
});
