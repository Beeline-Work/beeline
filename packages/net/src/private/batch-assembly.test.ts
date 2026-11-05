
import { describe as move13_describe, expect as move13_expect, it as move13_it } from 'vitest';

import { Multipart as move13_Multipart, multipartRecords as move13_multipartRecords, RouterBatchAssembly as move13_RouterBatchAssembly, type RouterPart as move13_RouterPart } from "./batch-assembly.js";

import type { LaneBatch as move13_LaneBatch, LaneCut as move13_LaneCut, LaneFact as move13_LaneFact } from "./read-lanes.js";
import { describe as movedDescribe13 } from 'vitest';
movedDescribe13("multipart.test.ts", () => {


const cut=(through:number):move13_LaneCut=>({stream:'workspace:w',epoch:'e',through,protocol:1});

const header=(id:string,from=0)=>({batchId:id,from:cut(from),to:cut(from+1),partCount:1,contentDigest:'digest'});

const fact=(text:string):move13_LaneFact=>({atomicGroup:'room:a',authority:{digest:'certificate',scopes:[{authorityScope:'room:a',epoch:'1'}]},
  payload:{kind:'scope-replace',family:'room-head',scope:'a',value:{text}}});


move13_describe('shared physical multipart ownership',()=>{
  move13_it('owns retained data parts and cut references until commit without allowing caller mutation',()=>{
    const outputs:move13_LaneBatch[]=[],faults:string[]=[];
    const records=[fact('original')],part:move13_RouterPart={kind:'push-part',...header('data'),partIndex:0,facts:records};
    const assembly=new move13_RouterBatchAssembly(value=>{
      const first=value[0];return first&&'payload' in first&&first.payload.kind==='scope-replace'&&
        (first.payload.value as {text?:string}).text==='original'?'digest':'changed';
    },batch=>outputs.push(batch),stream=>faults.push(stream));
    assembly.accept(part);
    (records[0]!.payload as {value:{text:string}}).value.text='mutated';
    (part.to as {through:number}).through=100;
    assembly.accept({kind:'push-commit',...header('data')});
    move13_expect(outputs).toHaveLength(1);move13_expect(outputs[0]!.to.through).toBe(1);
    move13_expect(outputs[0]!.facts[0]!.payload).toMatchObject({value:{text:'original'}});move13_expect(faults).toEqual([]);
  });
  move13_it('requires commit and every index, counts duplicates once and rejects a changed retained part',()=>{
    const batches=new move13_Multipart<string,move13_LaneCut>(),common={...header('two'),partCount:2};
    const first=batches.accept(common,{index:1,values:['second']});move13_expect(typeof first).not.toBe('string');
    if(typeof first==='string')throw new Error(first);
    move13_expect(move13_multipartRecords(first)).toBeUndefined();const charged=first.bytes;
    batches.accept(common,{index:1,values:['second']});move13_expect(first.bytes).toBe(charged);
    move13_expect(batches.accept(common,{index:1,values:['changed']})).toBe('digest');
    batches.accept(common);move13_expect(move13_multipartRecords(first)).toBeUndefined();
    batches.accept(common,{index:0,values:['first']});move13_expect(move13_multipartRecords(first)).toEqual(['first','second']);
  });
  move13_it('retains complete data and authority parts regardless of byte count',()=>{
    const data=new move13_Multipart<string,move13_LaneCut>(),authority=new move13_Multipart<string,move13_LaneCut>(true);
    const later=header('later',10),earlier={...header('earlier'),partCount:5};
    for(const stage of[data,authority])move13_expect(typeof stage.accept(later,{index:0,values:['small']})).not.toBe('string');
    const values=['x'.repeat(60*1024)];
    for(let index=0;index<4;index++){
      move13_expect(typeof data.accept(earlier,{index,values})).not.toBe('string');
      move13_expect(typeof authority.accept(earlier,{index,values})).not.toBe('string');
    }
    move13_expect(typeof data.accept(earlier,{index:4,values})).not.toBe('string');
    move13_expect(typeof authority.accept(earlier,{index:4,values})).not.toBe('string');
  });
  move13_it('uses semantic position identity and rejects invalid indices/counts before retaining them',()=>{
    const stage=new move13_Multipart<string,move13_LaneCut>(),common=header('semantic');
    stage.accept(common,{index:0,values:[]});
    const reordered={...common,from:{protocol:1 as const,through:0,epoch:'e',stream:'workspace:w'}};
    move13_expect(typeof stage.accept(reordered)).not.toBe('string');
    move13_expect(stage.accept({...header('bad'),partCount:0})).toBe('protocol');
    move13_expect(stage.accept(header('bad'),{index:-1,values:[]})).toBe('protocol');move13_expect(stage.size).toBe(1);
  });
});
});
