import { ROUTER_MAX_AUTHORITY_FENCE_BYTES, type RouterAuthorityFence } from '@beeline/api-contract/router-protocol';
import type { SqlDatabase } from './database.js';
import type { LiveHub } from './live.js';
import { authorizedMediaMetadata } from './phone-media.js';
import { PhoneOperationError } from './phone-operations.js';
import { ROUTER_AUTHORITY_LOCK } from './router-projection-schema.js';
import { routerAuthority, RouterProjectionUnavailable } from './router-projections.js';

/** Only principal-addressed, DB-authored causes enter this actor. No client
 * inventories, subscriptions or read lanes select its authority audience. */
export async function currentAuthorityFence(db:SqlDatabase,viewer:string,scope:string,domain:string):Promise<RouterAuthorityFence|undefined>{
  let allowed:boolean,mode:'deny'|'advance'='deny';
  const workspacePrefix=`reader:${viewer}:workspace:`;
  if(domain.startsWith(workspacePrefix)&&domain.endsWith(':visibility')){
    if(scope!==domain.slice(workspacePrefix.length,-':visibility'.length))return undefined;
    allowed=true;mode='advance';
  }else if(domain.startsWith(workspacePrefix)){
    const workspace=domain.slice(workspacePrefix.length);
    if(scope!==workspace)return undefined;
    allowed=Boolean((await db.query(`SELECT 1 FROM memberships WHERE workspace_id=$1 AND room_id IS NULL
      AND identity_id=$2 AND removed_at IS NULL`,[workspace,viewer])).rowCount);
  }else if(domain===`room:${scope}`){
    allowed=Boolean((await db.query(`SELECT 1 FROM rooms room JOIN memberships member
      ON member.room_id=COALESCE(room.parent_id,room.id) AND member.identity_id=$2 AND member.removed_at IS NULL
      JOIN memberships workspace ON workspace.workspace_id=room.workspace_id AND workspace.room_id IS NULL
      AND workspace.identity_id=$2 AND workspace.removed_at IS NULL WHERE room.id=$1`,[scope,viewer])).rowCount);
  }else if(domain===`object:${scope}`){
    try{await authorizedMediaMetadata(db,scope,viewer);allowed=true;}
    catch(error){if(!(error instanceof PhoneOperationError)||error.status!==404)throw error;allowed=false;}
    if(allowed)mode='advance';
  }else return undefined;
  if(allowed&&mode==='deny')return undefined;
  const row=(await db.query<{epoch:string}>(`SELECT epoch::text FROM router_authority WHERE scope=$1`,[domain])).rows[0];
  if(!row)throw new RouterProjectionUnavailable('authority');
  const frame:RouterAuthorityFence={kind:'authority-fence',scope,authorityScope:domain,mode,
    authority:routerAuthority([{authorityScope:domain,epoch:row.epoch}])};
  if(Buffer.byteLength(JSON.stringify(frame))>ROUTER_MAX_AUTHORITY_FENCE_BYTES)throw new RouterProjectionUnavailable('budget');
  return frame;
}

type Head={epoch:string;sequence:string};
export async function subscribeAuthorityFences(database:SqlDatabase,live:LiveHub,viewer:string,
  enqueue:(frame:RouterAuthorityFence)=>undefined,unavailable:(reason:string)=>void,ready:Promise<void>=Promise.resolve()):Promise<()=>void>{
  const stream=`authority:${viewer}`;
  let stopped=false,dirty=false,running=false,initialized=false,position:Head|undefined;
  const head=async(db:SqlDatabase)=>(await db.query<Head>(`SELECT epoch,sequence::text FROM live_streams WHERE id=$1`,[stream])).rows[0];
  const release=()=>{stopped=true;unlisten();unresync();unhealth();};
  const drain=async()=>{
    if(stopped||running||!initialized)return;running=true;
    try{
      while(dirty&&!stopped){
        dirty=false;
        await ready;
        if(stopped)break;
        const to=await database.transaction(async db=>{
          await db.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
          await db.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))',[ROUTER_AUTHORITY_LOCK]);
          const current=await head(db);if(!current)return undefined;
          if(position&&current.epoch!==position.epoch)throw new RouterProjectionUnavailable('retention');
          const from=Number(position?.sequence??0),through=Number(current.sequence);
          if(!Number.isSafeInteger(through)||through<from||through-from>1024)throw new RouterProjectionUnavailable('retention');
          if(through===from)return current;
          const rows=await db.query<{sequence:string;event:{kind?:string;scope?:string;authorityScope?:string}}>(
            `SELECT sequence::text,event FROM live_journal WHERE stream_id=$1 AND sequence>$2 AND sequence<=$3 ORDER BY live_journal.sequence`,[stream,from,through]);
          if(rows.rows.length!==through-from||rows.rows.some((row,index)=>Number(row.sequence)!==from+index+1))throw new RouterProjectionUnavailable('retention');
          const domains=new Map<string,string>();
          for(const {event}of rows.rows){
            if(event.kind!=='authority-change'||typeof event.scope!=='string'||typeof event.authorityScope!=='string')throw new RouterProjectionUnavailable('dependency');
            domains.set(event.authorityScope,event.scope);
          }
          if(domains.size>256)throw new RouterProjectionUnavailable('budget');
          for(const [domain,scope]of domains){
            const frame=await currentAuthorityFence(db,viewer,scope,domain);
            if(frame&&!stopped)enqueue(frame);
          }
          return current;
        });
        if(!stopped)position=to;
      }
    }catch(error){release();unavailable(error instanceof RouterProjectionUnavailable?error.reason:'projection');}
    finally{running=false;}
  };
  const unlisten=live.subscribeJournal(streams=>{if(streams.includes(stream)){dirty=true;void drain();}});
  const unresync=live.subscribeResync(()=>{dirty=true;void drain();});
  const unhealth=live.subscribeProjectionUnavailable(()=>{if(!stopped){release();unavailable('listener');}});
  try{position=await head(database);initialized=true;void drain();return release;}catch(error){release();throw error;}
}
