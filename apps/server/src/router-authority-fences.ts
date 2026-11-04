import type { RouterAuthorityFence } from '@beeline/api-contract/router-protocol';
import type { SqlDatabase } from './database.js';
import type { LiveHub } from './live.js';
import { authorizedMediaMetadata } from './phone-media.js';
import { PhoneOperationError } from './phone-operations.js';
import { ROUTER_AUTHORITY_LOCK } from './router-authority-lock.js';
import { routerAuthority, RouterProjectionUnavailable } from './router-projections.js';
import {currentScheduledWorkFence} from './scheduled-work-authority.js';

/** Only principal-addressed, DB-authored causes enter this actor. No client
 * inventories, subscriptions or read lanes select its authority audience. */
export async function currentAuthorityFence(db:SqlDatabase,viewer:string,scope:string,domain:string):Promise<RouterAuthorityFence|undefined>{
  if(domain.startsWith('scheduled-work-'))return currentScheduledWorkFence(db,viewer,scope,domain);
  let allowed:boolean,mode:'deny'|'advance'='deny';
  const workspacePrefix=`reader:${viewer}:workspace:`;
  if(scope===viewer&&(domain===`owner:${viewer}:owner-workbench`||domain===`owner:${viewer}:owner-wallet`)){
    allowed=Boolean((await db.query(`SELECT 1 FROM identities WHERE id=$1 AND kind='human' AND NOT hidden_from_roster`,[viewer])).rowCount);
    mode=allowed?'advance':'deny';
  }else if(domain.startsWith('profile:')){
    const match=/^profile:([0-9a-f-]{36}):(.+)$/.exec(domain);
    if(!match||match[2]!==scope)return undefined;
    allowed=Boolean((await db.query(`SELECT 1 FROM memberships reader
      JOIN memberships agent ON agent.workspace_id=reader.workspace_id AND agent.room_id IS NULL
        AND agent.identity_id=$3 AND agent.removed_at IS NULL
      JOIN identities person ON person.id=agent.identity_id AND person.kind='agent' AND NOT person.hidden_from_roster
      WHERE reader.workspace_id=$1 AND reader.room_id IS NULL AND reader.identity_id=$2 AND reader.removed_at IS NULL`,
      [match[1],viewer,scope])).rowCount);
    mode=allowed?'advance':'deny';
  }else if(domain.startsWith(workspacePrefix)&&domain.endsWith(':visibility')){
    if(scope!==domain.slice(workspacePrefix.length,-':visibility'.length))return undefined;
    allowed=true;mode='advance';
  }else if(domain.startsWith(workspacePrefix)){
    const workspace=domain.slice(workspacePrefix.length);
    if(scope!==workspace)return undefined;
    allowed=Boolean((await db.query(`SELECT 1 FROM memberships WHERE workspace_id=$1 AND room_id IS NULL
      AND identity_id=$2 AND removed_at IS NULL`,[workspace,viewer])).rowCount);
  }else if(domain===`room:${scope}`){
    const room=(await db.query<{parent_id:string|null;workspace_allowed:boolean;member_allowed:boolean}>(
      `SELECT room.parent_id,EXISTS(SELECT 1 FROM memberships workspace WHERE workspace.workspace_id=room.workspace_id
        AND workspace.room_id IS NULL AND workspace.identity_id=$2 AND workspace.removed_at IS NULL) workspace_allowed,
       EXISTS(SELECT 1 FROM memberships member WHERE member.room_id=COALESCE(room.parent_id,room.id)
        AND member.identity_id=$2 AND member.removed_at IS NULL) member_allowed
       FROM rooms room WHERE room.id=$1`,[scope,viewer])).rows[0];
    allowed=Boolean(room?.workspace_allowed&&room.member_allowed);
    // The effective parent/Workspace domain owns an inherited denial. Only
    // retire this Room's older chain, or a later parent regrant would remain
    // blocked forever at an unchanged child epoch.
    if(room&&(room.parent_id!==null||!room.workspace_allowed))mode='advance';
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
  return frame;
}

/** Prefer the ordered journal; a retained coalesced index covers large bursts
 * without retaining unbounded event history or trusting client inventories. */
export async function readAuthorityChanges(db:SqlDatabase,viewer:string,epoch:string,from:number,through:number){
  const rows=(await db.query<{sequence:string;event:{kind?:string;scope?:string;authorityScope?:string}}>(
    `SELECT sequence::text,event FROM live_journal WHERE stream_id=$1 AND sequence>$2 AND sequence<=$3 ORDER BY sequence`,
    [`authority:${viewer}`,from,through])).rows;
  if(rows.length===through-from&&rows.every((row,index)=>Number(row.sequence)===from+index+1))return rows;
  const covered=(await db.query(`SELECT 1 FROM router_authority_reader_coverage WHERE reader=$1 AND epoch=$2 AND after_sequence<=$3`,
    [viewer,epoch,from])).rowCount;
  if(!covered)throw new RouterProjectionUnavailable('retention');
  return (await db.query<{sequence:string;event:{kind?:string;scope?:string;authorityScope?:string}}>(
    `SELECT sequence::text,jsonb_build_object('kind','authority-change','scope',scope,'authorityScope',domain) event
     FROM router_authority_reader_changes WHERE reader=$1 AND epoch=$2 AND sequence>$3 AND sequence<=$4 ORDER BY sequence`,
    [viewer,epoch,from,through])).rows;
}

type Head={epoch:string;sequence:string};
export async function subscribeAuthorityFences(database:SqlDatabase,live:LiveHub,viewer:string,
  enqueue:(frame:RouterAuthorityFence)=>undefined,unavailable:(reason:string)=>void,ready:Promise<void>=Promise.resolve(),
  acceptDomain:(domain:string)=>boolean=domain=>!domain.startsWith('scheduled-work-')):Promise<()=>void>{
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
          if(!Number.isSafeInteger(through)||through<from)throw new RouterProjectionUnavailable('retention');
          if(through===from)return current;
          const rows=await readAuthorityChanges(db,viewer,current.epoch,from,through);
          const domains=new Map<string,string>();
          for(const {event}of rows){
            if(event.kind!=='authority-change'||typeof event.scope!=='string'||typeof event.authorityScope!=='string')throw new RouterProjectionUnavailable('dependency');
            domains.set(event.authorityScope,event.scope);
          }
          for(const [domain,scope]of domains){
            if(!acceptDomain(domain))continue;
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
