import type { SavedRow, SavedRowPayload, SavedWindow } from '@beeline/api-contract/router-protocol';
import { assertJsonBudget } from '../wire-codec.js';
import { validateBookmarkRows } from './projection-codecs.js';

const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(value);
const cursor=(value:unknown):value is string=>typeof value==='string'&&value.length<=1024&&/^saved1\.[a-zA-Z0-9_-]+$/.test(value);
const record=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
const keys=(value:Record<string,unknown>,allowed:readonly string[])=>Object.keys(value).every(key=>allowed.includes(key));
const message=(value:unknown):value is string=>typeof value==='string'&&/^[a-zA-Z0-9_-]{1,128}$/.test(value);
function row(value:unknown,workspace:string):value is SavedRow{
  if(!record(value)||!keys(value,['bookmarkId','order','before','value'])||!uuid(value.bookmarkId)||!cursor(value.before)||
      typeof value.order!=='string'||!record(value.value)||value.value.workspaceId!==workspace||!message(value.value.messageId))return false;
  const pair=value.order.split(',');
  if(pair.length!==2||pair[1]!==value.value.messageId||!/^(-?[1-9][0-9]{0,18}|0)$/.test(pair[0]!)||
      BigInt(pair[0]!)< -9223372036854775808n||BigInt(pair[0]!)>9223372036854775807n)return false;
  return !(value.value.available===false&&(value.value.text!==undefined||value.value.author!==undefined));
}

/** Window membership and cursor metadata are server-authored query results.
 * This validator grants no authority and decodes no cursor into a query. */
export function validateSavedWindow(value:unknown,workspace:string):value is SavedWindow{
  try{
    assertJsonBudget(value,64*1024);
    if(typeof workspace!=='string'||!workspace||workspace.length>128||!record(value)||!keys(value,['windowId','before','rows','next'])||
        typeof value.windowId!=='string'||!/^saved1:[a-f0-9]{64}$/.test(value.windowId)||
        value.before!==undefined&&!cursor(value.before)||value.next!==undefined&&!cursor(value.next)||
        !Array.isArray(value.rows)||value.rows.length>30)return false;
    const seen=new Set<string>(),messages=new Set<string>();
    let previous:SavedRow|undefined;
    for(const entry of value.rows){
      if(!row(entry,workspace)||seen.has(entry.bookmarkId)||messages.has(entry.value.messageId))return false;
      if(previous){
        const a=BigInt(previous.order.split(',')[0]!),b=BigInt(entry.order.split(',')[0]!);
        if(a<b||a===b&&previous.value.messageId>=entry.value.messageId)return false;
      }
      seen.add(entry.bookmarkId);messages.add(entry.value.messageId);previous=entry;
    }
    return validateBookmarkRows(value.rows.map(entry=>entry.value));
  }catch{return false;}
}

/** Mechanical complete-row replacement only. No domain-field merge, sort,
 * hole fill, continuation change, read, timer or cache-inventory message.
 * The group owner must verify the complete batch's digest/current authority
 * and publish/persist all held windows plus count at one common cut. */
export function replaceSavedWindowRows(window:SavedWindow,workspace:string,facts:readonly SavedRowPayload[]):SavedWindow{
  assertJsonBudget(facts,1024*1024);
  if(facts.length>256||!validateSavedWindow(window,workspace))throw new Error('Invalid Saved window');
  let rows=window.rows;
  for(const fact of facts){
    if(!record(fact)||fact.scope!==workspace)throw new Error('Invalid Saved scope');
    if(fact.kind==='saved-row-remove'){
      if(!keys(fact,['kind','scope','bookmarkId','messageId'])||!uuid(fact.bookmarkId)||!message(fact.messageId))throw new Error('Invalid Saved removal');
      const held=rows.find(entry=>entry.bookmarkId===fact.bookmarkId);
      if(held&&held.value.messageId!==fact.messageId)throw new Error('Saved incarnation changed');
      if(held)rows=rows.filter(entry=>entry!==held);
    }else if(fact.kind==='saved-row-replace'){
      if(!keys(fact,['kind','scope','row'])||!row(fact.row,workspace)||
          !validateBookmarkRows([fact.row.value]))throw new Error('Invalid Saved replacement');
      const held=rows.find(entry=>entry.bookmarkId===fact.row.bookmarkId);
      if(!held)continue;
      if(held.order!==fact.row.order||held.before!==fact.row.before||held.value.messageId!==fact.row.value.messageId||
          held.value.roomId!==fact.row.value.roomId)
        throw new Error('Saved incarnation changed');
      // Copy wire-owned values across later publication/storage awaits.
      const replacement=JSON.parse(JSON.stringify(fact.row)) as SavedRow;
      rows=rows.map(entry=>entry===held?replacement:entry);
    }else throw new Error('Invalid Saved row fact');
  }
  const result=rows===window.rows?window:{...window,rows};
  if(!validateSavedWindow(result,workspace))throw new Error('Saved window capacity exceeded');
  return result;
}
