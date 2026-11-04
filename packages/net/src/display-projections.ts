import {displayShapes,displayResults} from './generated-display-shapes.js';
import {jsonCodec} from './wire-codec.js';

/** Screen result validation has no route authority, transport or read pass. */
export function validateWorkflowProjection(value:unknown):boolean{
  try{jsonCodec(displayShapes,displayResults['phone.listRoomWorkflowRuns']).parse(value);
    return true;}catch{return false;}
}

export function validateScheduledWorkProjection(value:unknown):boolean{
  try{jsonCodec(displayShapes,displayResults['phone.readScheduledWork']).parse(value);return true;}catch{return false;}
}
