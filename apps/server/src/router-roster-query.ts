import type {RouterSnapshotInput} from '@beeline/api-contract/router-protocol';
import {PhoneOperationError} from './phone-operations.js';

export function readRosterQuery(value:unknown):Extract<RouterSnapshotInput,{family:'workspace-roster'}>['query']{
  if(value===undefined)return undefined;
  const invalid=()=>{throw new PhoneOperationError(400,{error:'invalid_roster_query'});};
  if(!value||typeof value!=='object'||Array.isArray(value))return invalid();
  const query=value as Record<string,unknown>;
  if(Object.keys(query).some(key=>!['revision','q','kind','offset'].includes(key))||typeof query.revision!=='string'||
    !/^[1-9][0-9]{0,19}$/.test(query.revision)||query.q!==undefined&&(typeof query.q!=='string'||Buffer.byteLength(query.q)>128)||
    query.kind!==undefined&&query.kind!=='human'&&query.kind!=='agent'||query.offset!==undefined&&
    (!Number.isSafeInteger(query.offset)||Number(query.offset)<0))return invalid();
  return query as Extract<RouterSnapshotInput,{family:'workspace-roster'}>['query'];
}
