import { describe, expect, it } from 'vitest';
import { Multipart, multipartRecords, RouterBatchAssembly, type RouterPart } from './private/batch-assembly.js';
import type { LaneBatch, LaneCut, LaneFact } from './private/read-lanes.js';

const cut=(through:number):LaneCut=>({stream:'workspace:w',epoch:'e',through,protocol:1});
const header=(id:string,from=0)=>({batchId:id,from:cut(from),to:cut(from+1),partCount:1,contentDigest:'digest'});
const fact=(text:string):LaneFact=>({atomicGroup:'room:a',authority:{digest:'certificate',scopes:[{authorityScope:'room:a',epoch:'1'}]},
  payload:{kind:'scope-replace',family:'room-head',scope:'a',value:{text}}});

describe('shared physical multipart ownership',()=>{
  it('owns retained data parts and cut references until commit without allowing caller mutation',()=>{
    const outputs:LaneBatch[]=[],faults:string[]=[];
    const records=[fact('original')],part:RouterPart={kind:'push-part',...header('data'),partIndex:0,facts:records};
    const assembly=new RouterBatchAssembly(value=>{
      const first=value[0];return first&&'payload' in first&&first.payload.kind==='scope-replace'&&
        (first.payload.value as {text?:string}).text==='original'?'digest':'changed';
    },batch=>outputs.push(batch),stream=>faults.push(stream));
    assembly.accept(part);
    (records[0]!.payload as {value:{text:string}}).value.text='mutated';
    (part.to as {through:number}).through=100;
    assembly.accept({kind:'push-commit',...header('data')});
    expect(outputs).toHaveLength(1);expect(outputs[0]!.to.through).toBe(1);
    expect(outputs[0]!.facts[0]!.payload).toMatchObject({value:{text:'original'}});expect(faults).toEqual([]);
  });
  it('requires commit and every index, counts duplicates once and rejects a changed retained part',()=>{
    const batches=new Multipart<string,LaneCut>(),common={...header('two'),partCount:2};
    const first=batches.accept(common,{index:1,values:['second']});expect(typeof first).not.toBe('string');
    if(typeof first==='string')throw new Error(first);
    expect(multipartRecords(first)).toBeUndefined();const charged=first.bytes;
    batches.accept(common,{index:1,values:['second']});expect(first.bytes).toBe(charged);
    expect(batches.accept(common,{index:1,values:['changed']})).toBe('digest');
    batches.accept(common);expect(multipartRecords(first)).toBeUndefined();
    batches.accept(common,{index:0,values:['first']});expect(multipartRecords(first)).toEqual(['first','second']);
  });
  it('retains complete data and authority parts regardless of byte count',()=>{
    const data=new Multipart<string,LaneCut>(),authority=new Multipart<string,LaneCut>(true);
    const later=header('later',10),earlier={...header('earlier'),partCount:5};
    for(const stage of[data,authority])expect(typeof stage.accept(later,{index:0,values:['small']})).not.toBe('string');
    const values=['x'.repeat(60*1024)];
    for(let index=0;index<4;index++){
      expect(typeof data.accept(earlier,{index,values})).not.toBe('string');
      expect(typeof authority.accept(earlier,{index,values})).not.toBe('string');
    }
    expect(typeof data.accept(earlier,{index:4,values})).not.toBe('string');
    expect(typeof authority.accept(earlier,{index:4,values})).not.toBe('string');
  });
  it('uses semantic position identity and rejects invalid indices/counts before retaining them',()=>{
    const stage=new Multipart<string,LaneCut>(),common=header('semantic');
    stage.accept(common,{index:0,values:[]});
    const reordered={...common,from:{protocol:1 as const,through:0,epoch:'e',stream:'workspace:w'}};
    expect(typeof stage.accept(reordered)).not.toBe('string');
    expect(stage.accept({...header('bad'),partCount:0})).toBe('protocol');
    expect(stage.accept(header('bad'),{index:-1,values:[]})).toBe('protocol');expect(stage.size).toBe(1);
  });
});
