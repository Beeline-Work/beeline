import type {SqlDatabase} from './database.js';
/** Clock identity orders committed expiry hints. Item deadlines are checked
 * by each read; background owner health does not determine read authority. */
export async function readTrayClockBasis(db:SqlDatabase,workspaceId:string){
  const row=(await db.query<{generation:string;revision:string;ready:boolean}>(
    `SELECT clock.generation,clock.revision::text,true ready FROM tray_clock_state clock WHERE clock.workspace_id=$1`,[workspaceId])).rows[0];
  if(!row)return {generation:'0'.repeat(32),revision:'0',ready:true,clockVersion:`tray-clock-v1:${'0'.repeat(32)}:0`};
  return{...row,clockVersion:`tray-clock-v1:${row.generation}:${row.revision}`};
}
