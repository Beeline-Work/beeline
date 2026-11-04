import type { NeedsYouRoomsPayload } from '@beeline/api-contract/router-protocol';
import type { NeedsYouItemView } from '@beeline/api-contract/phone';
import { validateNeedsProjection } from './projection-codecs.js';

const record=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
export function validateNeedsRoomsPayload(value:unknown):value is NeedsYouRoomsPayload{
  if(!record(value)||value.kind!=='needs-you-rooms-replace'||typeof value.scope!=='string'||
    Object.keys(value).some(key=>!['kind','scope','rooms','order','count'].includes(key))||
    !Array.isArray(value.rooms)||!Array.isArray(value.order)||
    value.count!==value.order.length||
    !value.order.every(id=>typeof id==='string'&&id.length>0&&id.length<=128)||new Set(value.order).size!==value.order.length)return false;
  const rooms=new Set<string>();
  for(const room of value.rooms){
    if(!record(room)||Object.keys(room).some(key=>!['roomId','items'].includes(key))||
      typeof room.roomId!=='string'||rooms.has(room.roomId)||!Array.isArray(room.items)||
      !validateNeedsProjection({items:room.items})||
      !room.items.every(item=>record(item)&&item.roomId===room.roomId&&item.workspaceId===value.scope))return false;
    rooms.add(room.roomId);
  }
  return true;
}

/** Apply only the server's exact replacements and final order. A missing row
 * proves incomplete coverage and parks; it never guesses membership or reads. */
export function foldNeedsYouRooms(base:unknown,payload:NeedsYouRoomsPayload):{count:number;items:NeedsYouItemView[]}{
  if(!validateNeedsRoomsPayload(payload)||!record(base)||!Array.isArray(base.items))throw new Error('Invalid projection; Retry.');
  const replaced=new Set(payload.rooms.map(room=>room.roomId));
  const rows=new Map<string,NeedsYouItemView>();
  for(const item of base.items){
    if(!record(item)||typeof item.messageId!=='string'||rows.has(item.messageId))throw new Error('Invalid projection; Retry.');
    if(!replaced.has(item.roomId as string))rows.set(item.messageId,item as NeedsYouItemView);
  }
  for(const room of payload.rooms)for(const item of room.items){
    if(rows.has(item.messageId))throw new Error('Invalid projection; Retry.');rows.set(item.messageId,item);
  }
  return {count:payload.count,items:payload.order.map(id=>{
    const row=rows.get(id);if(!row)throw new Error('Incomplete projection coverage');return row;
  })};
}
