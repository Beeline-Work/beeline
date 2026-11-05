import {TRAY_CLOCK_READ_PREDICATE_SQL} from './tray-clock-readiness.js';
import type {SqlDatabase} from './database.js';
/** Pure committed clock identity. Missing/unready evidence never authorizes a
 * read-side repair or wall-clock substitution. */
export async function readTrayClockBasis(db:SqlDatabase,workspaceId:string){
  const row=(await db.query<{generation:string;revision:string;ready:boolean}>(
    `SELECT clock.generation,clock.revision::text,${TRAY_CLOCK_READ_PREDICATE_SQL} ready FROM tray_clock_state clock WHERE clock.workspace_id=$1`,[workspaceId])).rows[0];
  if(!row||!/^[a-f0-9]{32}$/.test(row.generation)||!/^(0|[1-9][0-9]*)$/.test(row.revision))return;
  return{...row,clockVersion:`tray-clock-v1:${row.generation}:${row.revision}`};
}
