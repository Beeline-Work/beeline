import {describe,it,expect} from 'vitest';
import {displayShapes,displayResults} from './generated-display-shapes.js';
import {wireShapes,operationShapes} from './generated-wire-shapes.js';
import type {WireShape} from './wire-codec.js';
import {validateWorkflowProjection} from './display-projections.js';

describe('screen result codec projection',()=>{
  it('preserves the complete authoritative result graph outside the owner entry',()=>{
    const expected:WireShape[]=[],ids=new Map<number,number>();
    const project=(id:number):number=>{
      const held=ids.get(id);if(held!==undefined)return held;
      const next=expected.length;ids.set(id,next);expected.push({kind:'never'});
      const source=wireShapes[id]!;let node:WireShape=source;
      switch(source.kind){
        case 'array':node={...source,item:project(source.item)};break;
        case 'union':case 'intersection':node={...source,choices:source.choices.map(project)};break;
        case 'tuple':node={...source,items:source.items.map(project)};break;
        case 'object':node={...source,properties:Object.fromEntries(Object.entries(source.properties).map(([key,field])=>
          [key,{...field,node:project(field.node)}])),...(source.index===undefined?{}:{index:project(source.index)})};break;
      }
      expected[next]=node;return next;
    };
    expect(displayResults).toEqual({'phone.listRoomWorkflowRuns':project(operationShapes['phone.listRoomWorkflowRuns'].output)});
    expect(displayShapes).toEqual(expected);
  });
  it('retains exact schema and row limits',()=>{
    const row={runId:'run',roomId:'room',status:'live',updatedAt:1};
    expect(validateWorkflowProjection({workflows:[row]})).toBe(true);
    expect(validateWorkflowProjection({workflows:[{...row,status:'invented'}]})).toBe(false);
    expect(validateWorkflowProjection({workflows:Array(31).fill(row)})).toBe(false);
  });
});
