import { describe,expect,it } from 'vitest';
import { helperActivationCodecs } from './helper-activation-codecs.js';
const input={agentId:'agent',roomId:'room',workspaceId:'workspace',commandId:'command',generationId:'generation',source:{connectionId:'source',epoch:1}};
describe('closed activation route codecs',()=>{
  it('accepts the owned input and refuses arbitrary top-level/source metadata or getters',()=>{
    expect(helperActivationCodecs.params.parse(input)).toEqual(input);
    expect(()=>helperActivationCodecs.params.parse({...input,arbitrary:true})).toThrow();
    expect(()=>helperActivationCodecs.params.parse({...input,source:{...input.source,cacheInventory:['forbidden']}})).toThrow();
    let invoked=false;const accessor={...input};Object.defineProperty(accessor,'source',{enumerable:true,get(){invoked=true;return input.source;}});
    expect(()=>helperActivationCodecs.params.parse(accessor)).toThrow();expect(invoked).toBe(false);
    expect(()=>helperActivationCodecs.result.parse({v:1,...input})).toThrow();
  });
});
