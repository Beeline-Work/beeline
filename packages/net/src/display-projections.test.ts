import {describe,it,expect} from 'vitest';
import type {WorkflowRunSummaryView} from '@beeline/api-contract/phone';
import {displayShapes,displayResults} from './generated-display-shapes.js';
import {wireShapes,operationShapes} from './generated-wire-shapes.js';
import type {WireShape} from './wire-codec.js';
import {validateWorkflowProjection,validateScheduledWorkProjection} from './display-projections.js';

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
    expect(displayResults).toEqual({'phone.listRoomWorkflowRuns':project(operationShapes['phone.listRoomWorkflowRuns'].output),
      'phone.readScheduledWork':project(operationShapes['phone.readScheduledWork'].output)});
    expect(displayShapes).toEqual(expected);
  });
  it('retains exact schema without display byte or row limits',()=>{
    const row={runId:'run',workflowSlug:'review',description:'Review changes',roomId:'room',
      roomName:'Room',state:'review',status:'live',viewerHolds:false,startedAt:1,updatedAt:1} satisfies WorkflowRunSummaryView;
    expect(validateWorkflowProjection({workflows:[row]})).toBe(true);
    expect(validateWorkflowProjection({workflows:[{...row,status:'invented'}]})).toBe(false);
    expect(validateWorkflowProjection({workflows:Array(31).fill(row)})).toBe(true);
    expect(validateWorkflowProjection({workflows:[{...row,description:'x'.repeat(128*1024)}]})).toBe(true);
    expect(validateScheduledWorkProjection({schedules:[],subscriptions:[],roomName:'x'.repeat(128*1024),agentNames:[]})).toBe(true);
    expect(validateScheduledWorkProjection({schedules:[],subscriptions:[],roomName:42,agentNames:[]})).toBe(false);
  });
});
