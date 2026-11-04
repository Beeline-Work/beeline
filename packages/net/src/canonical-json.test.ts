import {describe,expect,it} from 'vitest';
import {canonical} from './private/canonical.js';
import {assertJsonBudget} from './wire-codec.js';

describe('shared descriptor-only JSON traversal',()=>{
  it('sorts local keys without changing wire byte validation or optional-field semantics',()=>{
    const value={z:[null,-0,true,'😀'],a:{z:undefined,b:2,a:1}};
    expect(canonical(value)).toBe('{"a":{"a":1,"b":2},"z":[null,0,true,"😀"]}');
    const bytes=new TextEncoder().encode(JSON.stringify(value)).length;
    expect(()=>assertJsonBudget(value,bytes)).not.toThrow();
    expect(()=>assertJsonBudget(value,bytes-1)).toThrow('byte limit');
  });
  it('retains distinct local-key and wire complexity bounds',()=>{
    expect(()=>canonical(Array(4095).fill(0))).not.toThrow();
    expect(()=>canonical(Array(4096).fill(0))).toThrow('complexity');
    expect(()=>assertJsonBudget(Array(4096).fill(0),65536)).not.toThrow();
    let value:unknown=0;
    for(let n=0;n<32;n++)value=[value];
    expect(()=>canonical(value)).not.toThrow();
    value=[value];
    expect(()=>canonical(value)).toThrow('complexity');
    expect(()=>assertJsonBudget(value,65536)).not.toThrow();
  });
  it('never invokes accessors or toJSON while rejecting non-JSON descriptors',()=>{
    let calls=0;
    for(const value of [Object.defineProperty({},'x',{enumerable:true,get(){calls++;return 1;}}),
      {toJSON(){calls++;return 1;}},Object.defineProperty({},'x',{value:1}),{[Symbol('x')]:1},Array(1)]){
      expect(()=>canonical(value)).toThrow();expect(()=>assertJsonBudget(value,65536)).toThrow();
    }
    expect(calls).toBe(0);
  });
  it('rejects cycles but permits repeated references and omits only object undefined fields',()=>{
    const child={a:1};expect(canonical({b:child,a:child})).toBe('{"a":{"a":1},"b":{"a":1}}');
    const cycle:unknown[]=[];cycle.push(cycle);
    expect(()=>canonical(cycle)).toThrow('cyclic');
    expect(()=>canonical(undefined)).toThrow();expect(()=>canonical([undefined])).toThrow();
    expect(canonical({a:undefined})).toBe('{}');
  });
});
