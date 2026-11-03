import {displayShapes,displayResults} from './generated-display-shapes.js';
import {jsonCodec} from './wire-codec.js';

/** Screen result validation has no route authority, transport or read pass. */
export function validateWorkflowProjection(value:unknown):boolean{
  try{jsonCodec(displayShapes,displayResults['phone.listRoomWorkflowRuns'],64*1024).parse(value);
    return (value as {workflows:unknown[]}).workflows.length<=30;}catch{return false;}
}
