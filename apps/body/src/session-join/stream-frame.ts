import type { Mention, Wake } from './bridge.js';
export type MemberStreamFrame = {v:1;type:'delivery';deliveryId:string;mentions:Mention[];wakes:Wake[];mentionCursor:string} |
  {v:1;type:'checkpoint';cursor:{epoch:string;through:number};mentionCursor:string} |
  {v:1;type:'ended';reason:'expired'|'unavailable'};
const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
export function memberStreamFrame(value:unknown):MemberStreamFrame {
  if(!object(value)||value.v!==1)throw new Error('Invalid Beeline stream frame');
  if(value.type==='ended'&&(value.reason==='expired'||value.reason==='unavailable'))return value as MemberStreamFrame;
  if(typeof value.mentionCursor!=='string'||!/^\d{1,18}$/.test(value.mentionCursor))throw new Error('Invalid Beeline mention cursor');
  if(value.type==='checkpoint'&&object(value.cursor)&&typeof value.cursor.epoch==='string'&&/^[a-f0-9]{32}$/.test(value.cursor.epoch)&&
    Number.isSafeInteger(value.cursor.through)&&Number(value.cursor.through)>=0)return value as MemberStreamFrame;
  if(value.type!=='delivery'||typeof value.deliveryId!=='string'||!value.deliveryId||value.deliveryId.length>256||
    !Array.isArray(value.mentions)||!Array.isArray(value.wakes))throw new Error('Invalid Beeline delivery');
  for(const mention of value.mentions)if(!object(mention)||typeof mention.id!=='string'||typeof mention.room_id!=='string'||
    typeof mention.text!=='string')throw new Error('Invalid Beeline mention');
  for(const wake of value.wakes)if(!object(wake)||typeof wake.id!=='string'||typeof wake.address!=='string'||
    typeof wake.reason!=='string'||typeof wake.createdAt!=='string'||wake.text!==undefined&&typeof wake.text!=='string')throw new Error('Invalid Beeline wake');
  return value as MemberStreamFrame;
}
