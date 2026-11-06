
import {describe as move11_describe,expect as move11_expect,it as move11_it} from 'vitest';

import {canonical as move11_canonical} from "./canonical.js";

import {assertJsonBudget as move11_assertJsonBudget} from "../wire-codec.js";
import { describe as movedDescribe11 } from 'vitest';
movedDescribe11("canonical-json.test.ts", () => {


move11_describe('shared descriptor-only JSON traversal',()=>{
  move11_it('sorts local keys without changing wire byte validation or optional-field semantics',()=>{
    const value={z:[null,-0,true,'😀'],a:{z:undefined,b:2,a:1}};
    move11_expect(move11_canonical(value)).toBe('{"a":{"a":1,"b":2},"z":[null,0,true,"😀"]}');
    const bytes=new TextEncoder().encode(JSON.stringify(value)).length;
    move11_expect(()=>move11_assertJsonBudget(value,bytes)).not.toThrow();
    move11_expect(()=>move11_assertJsonBudget(value,bytes-1)).toThrow('byte limit');
  });
  move11_it('retains distinct local-key and wire complexity bounds',()=>{
    move11_expect(()=>move11_canonical(Array(4095).fill(0))).not.toThrow();
    move11_expect(()=>move11_canonical(Array(4096).fill(0))).toThrow('complexity');
    move11_expect(()=>move11_assertJsonBudget(Array(4096).fill(0),65536)).not.toThrow();
    let value:unknown=0;
    for(let n=0;n<32;n++)value=[value];
    move11_expect(()=>move11_canonical(value)).not.toThrow();
    value=[value];
    move11_expect(()=>move11_canonical(value)).toThrow('complexity');
    move11_expect(()=>move11_assertJsonBudget(value,65536)).not.toThrow();
  });
  move11_it('never invokes accessors or toJSON while rejecting non-JSON descriptors',()=>{
    let calls=0;
    for(const value of [Object.defineProperty({},'x',{enumerable:true,get(){calls++;return 1;}}),
      {toJSON(){calls++;return 1;}},Object.defineProperty({},'x',{value:1}),{[Symbol('x')]:1},Array(1)]){
      move11_expect(()=>move11_canonical(value)).toThrow();move11_expect(()=>move11_assertJsonBudget(value,65536)).toThrow();
    }
    move11_expect(calls).toBe(0);
  });
  move11_it('rejects cycles but permits repeated references and omits only object undefined fields',()=>{
    const child={a:1};move11_expect(move11_canonical({b:child,a:child})).toBe('{"a":{"a":1},"b":{"a":1}}');
    const cycle:unknown[]=[];cycle.push(cycle);
    move11_expect(()=>move11_canonical(cycle)).toThrow('cyclic');
    move11_expect(()=>move11_canonical(undefined)).toThrow();move11_expect(()=>move11_canonical([undefined])).toThrow();
    move11_expect(move11_canonical({a:undefined})).toBe('{}');
  });
});
});
