import {ownerInputShapes,ownerResults} from './generated-owner-input-shapes.js';
import {jsonCodec} from '../wire-codec.js';

export function validateScheduledWorkProjection(value:unknown):boolean{
  try{jsonCodec(ownerInputShapes,ownerResults['phone.readScheduledWork'],64*1024).parse(value);return true;}catch{return false;}
}
export function validateWorkflowProjection(value:unknown):boolean{
  try{jsonCodec(ownerInputShapes,ownerResults['phone.listRoomWorkflowRuns'],64*1024).parse(value);
    return (value as {workflows:unknown[]}).workflows.length<=30;}catch{return false;}
}
export function validateWorkspaceProjection(value:unknown):boolean{
  try{jsonCodec(ownerInputShapes,ownerResults['phone.readWorkspace'],64*1024).parse(value);
    const roster=value as {members:unknown[];agents:unknown[]};return roster.members.length+roster.agents.length<=100;}catch{return false;}
}
/** Reuse the existing bounded DTO leaf schemas, independently of window
 * metadata. These functions grant neither route nor group coverage. */
export function validateBookmarkRows(bookmarks:unknown):boolean{
  if(!Array.isArray(bookmarks))return false;
  try{jsonCodec(ownerInputShapes,ownerResults['phone.readTray'],64*1024).parse({needs:{items:[]},saved:{bookmarks}});return true;}catch{return false;}
}
export function validateNeedsProjection(needs:unknown):boolean{
  if(!needs||typeof needs!=='object'||Array.isArray(needs)||Object.keys(needs).some(key=>key!=='items')||
    !Array.isArray((needs as {items?:unknown}).items)||(needs as {items:unknown[]}).items.length>30)return false;
  try{jsonCodec(ownerInputShapes,ownerResults['phone.readTray'],64*1024).parse({needs,saved:{bookmarks:[]}});return true;}catch{return false;}
}
