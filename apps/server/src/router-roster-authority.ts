import type {SqlDatabase} from './database.js';
import type {LiveHub} from './live.js';
import type {RouterAuthorityFence,RouterUnavailable} from '@beeline/api-contract/router-protocol';
import {ROUTER_AUTHORITY_LOCK} from './router-authority-lock.js';
import {routerAuthority,RouterProjectionUnavailable} from './router-projections.js';

/** A bounded Workspace control stream retires sealed roster windows without
 * enumerating phone keys or appending one durable hint per Workspace member. */
export function subscribeRosterAuthority(database:SqlDatabase,live:LiveHub,viewer:string,eligible:()=>ReadonlySet<string>,
  enqueue:(frame:RouterAuthorityFence)=>undefined,unavailable:(reason:RouterUnavailable['reason'])=>void,ready:Promise<void>):()=>void{
  const dirty=new Set<string>();let running=false,closed=false;
  const drain=async()=>{
    if(running||closed)return;running=true;
    try{
      await ready;
      while(dirty.size&&!closed){
        const scopes=[...dirty];dirty.clear();
        await database.transaction(async db=>{
          await db.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
          await db.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))',[ROUTER_AUTHORITY_LOCK]);
          const rows=await db.query<{workspace:string;epoch:string;allowed:boolean}>(`SELECT target.workspace,authority.epoch::text,
            EXISTS(SELECT 1 FROM memberships member WHERE member.workspace_id=target.workspace::uuid AND member.room_id IS NULL
              AND member.identity_id=$2 AND member.removed_at IS NULL) allowed
            FROM unnest($1::text[]) target(workspace) JOIN router_authority authority ON authority.scope='roster:'||target.workspace`,[scopes,viewer]);
          if(rows.rows.length!==scopes.length)throw new RouterProjectionUnavailable('dependency');
          for(const row of rows.rows)if(!closed)enqueue({kind:'authority-fence',scope:row.workspace,authorityScope:`roster:${row.workspace}`,
            mode:row.allowed?'advance':'deny',authority:routerAuthority([{authorityScope:`roster:${row.workspace}`,epoch:row.epoch}])});
        });
      }
    }catch(error){if(!closed){release();unavailable(error instanceof RouterProjectionUnavailable?error.reason:'projection');}}
    finally{running=false;}
  };
  const journal=live.subscribeJournal(streams=>{
    for(const stream of streams)if(stream.startsWith('roster-authority:')){
      const workspace=stream.slice('roster-authority:'.length);if(eligible().has(workspace))dirty.add(workspace);
    }
    if(dirty.size)void drain();
  });
  const resync=live.subscribeResync(()=>{for(const workspace of eligible())dirty.add(workspace);if(dirty.size)void drain();});
  const health=live.subscribeProjectionUnavailable(()=>{if(!closed){release();unavailable('listener');}});
  const release=()=>{closed=true;dirty.clear();journal();resync();health();};return release;
}
