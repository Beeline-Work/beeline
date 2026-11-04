import type {RouterAuthorityCertificate,RouterAuthorityFence} from '@beeline/api-contract/router-protocol';
import type {SqlDatabase} from './database.js';
import {ROUTER_AUTHORITY_LOCK} from './router-authority-lock.js';
import {routerAuthority,RouterProjectionUnavailable} from './router-projections.js';

export const scheduledPrincipalDomain=(viewer:string)=>`scheduled-work-principal:${viewer}`;
export const scheduledManagerDomain=(viewer:string,workspace:string)=>`scheduled-work-manager:${viewer}:workspace:${workspace}`;
export const scheduledMemberDomain=(viewer:string,room:string)=>`scheduled-work-member:${viewer}:room:${room}`;
export const scheduledRoomDomain=(room:string)=>`scheduled-work-room:${room}`;
type AuthorityRow={id:string;present:string|null;workspace_id:string;parent_id:string|null;archived:boolean;direct:boolean;participant:boolean;
  human:boolean;manager:boolean;member:boolean;scopes:{authorityScope:string;epoch:string}[]};
export type ScheduledWorkAuthority={workspaceId:string;authority:RouterAuthorityCertificate;allowed:boolean;
  denied:{scope:string;authorityScope:string};complete:boolean};

/** Matches requireScheduledWorkManager exactly. Public Room managers need no
 * transcript membership; humans manage their own DMs without a fictitious
 * Workspace membership requirement. These domains confer no transcript access. */
export async function scheduledWorkAuthorities(db:SqlDatabase,rooms:readonly string[],viewer:string):Promise<{states:ReadonlyMap<string,ScheduledWorkAuthority>;principal?:RouterAuthorityCertificate}>{
  if(!rooms.length)return {states:new Map()};
  const rows=(await db.query<AuthorityRow>(`SELECT requested.id,room.id present,room.workspace_id,room.parent_id,room.archived_at IS NOT NULL archived,
    room.direct_participants IS NOT NULL direct,COALESCE(room.direct_participants ? $2,false) participant,
    EXISTS(SELECT 1 FROM identities person WHERE person.id=$2 AND person.kind='human' AND NOT person.hidden_from_roster) human,
    EXISTS(SELECT 1 FROM memberships manager WHERE manager.workspace_id=room.workspace_id AND manager.room_id IS NULL
      AND manager.identity_id=$2 AND manager.removed_at IS NULL AND manager.role IN('owner','admin')) manager,
    EXISTS(SELECT 1 FROM memberships member WHERE member.room_id=room.id AND member.identity_id=$2 AND member.removed_at IS NULL) member,
    COALESCE((SELECT jsonb_agg(jsonb_build_object('authorityScope',scope,'epoch',epoch::text)) FROM router_authority
      WHERE scope='scheduled-work-principal:'||$2 OR scope='scheduled-work-room:'||room.id OR scope=CASE
        WHEN room.direct_participants IS NULL THEN 'scheduled-work-manager:'||$2||':workspace:'||room.workspace_id
        ELSE 'scheduled-work-member:'||$2||':room:'||room.id END),'[]'::jsonb) scopes
    FROM unnest($1::uuid[]) requested(id) LEFT JOIN rooms room ON room.id=requested.id`,[rooms,viewer])).rows;
  const result=new Map<string,ScheduledWorkAuthority>();
  const principalScope=scheduledPrincipalDomain(viewer);
  const principalEpoch=rows[0]?.scopes.find(item=>item.authorityScope===principalScope);
  for(const row of rows){
    if(!row.present)continue;
    const principal=scheduledPrincipalDomain(viewer),policy=scheduledRoomDomain(row.id);
    const access=row.direct?scheduledMemberDomain(viewer,row.id):scheduledManagerDomain(viewer,row.workspace_id);
    if(!row.scopes.some(item=>item.authorityScope===principal)||!row.scopes.some(item=>item.authorityScope===policy))continue;
    const allowed=row.human&&!row.parent_id&&!row.archived&&(row.direct?row.participant&&row.member:row.manager);
    const target=!row.human?principal:row.parent_id||row.archived||row.direct&&!row.participant?policy:access;
    result.set(row.id,{workspaceId:row.workspace_id,
      authority:routerAuthority(row.scopes.map(item=>({authorityScope:item.authorityScope,epoch:item.epoch}))),
      allowed,complete:row.scopes.length===3,denied:{scope:target===principal?viewer:target===scheduledManagerDomain(viewer,row.workspace_id)?row.workspace_id:row.id,authorityScope:target}});
  }
  return {states:result,principal:principalEpoch?routerAuthority([principalEpoch]):undefined};
}
export async function scheduledWorkAuthority(db:SqlDatabase,room:string,viewer:string):Promise<ScheduledWorkAuthority>{
  const result=(await scheduledWorkAuthorities(db,[room],viewer)).states.get(room);
  if(!result)throw new RouterProjectionUnavailable('authority');return result;
}

/** Domain-specific policy, so a Workspace role loss cannot deny own-DM or
 * transcript access and a later regrant only needs its actual changed epoch. */
export async function currentScheduledWorkFence(db:SqlDatabase,viewer:string,scope:string,domain:string):Promise<RouterAuthorityFence|undefined>{
  let allowed:boolean;
  if(domain===scheduledPrincipalDomain(viewer)&&scope===viewer){
    allowed=Boolean((await db.query(`SELECT 1 FROM identities WHERE id=$1 AND kind='human' AND NOT hidden_from_roster`,[viewer])).rowCount);
  }else if(domain===scheduledManagerDomain(viewer,scope)){
    allowed=Boolean((await db.query(`SELECT 1 FROM memberships WHERE workspace_id=$1 AND room_id IS NULL
      AND identity_id=$2 AND removed_at IS NULL AND role IN('owner','admin')`,[scope,viewer])).rowCount);
  }else if(domain===scheduledMemberDomain(viewer,scope)){
    allowed=Boolean((await db.query(`SELECT 1 FROM memberships WHERE room_id=$1 AND identity_id=$2 AND removed_at IS NULL`,[scope,viewer])).rowCount);
  }else if(domain===scheduledRoomDomain(scope)){
    allowed=Boolean((await db.query(`SELECT 1 FROM rooms WHERE id=$1 AND parent_id IS NULL AND archived_at IS NULL
      AND (direct_participants IS NULL OR direct_participants ? $2)`,[scope,viewer])).rowCount);
  }else return;
  const row=(await db.query<{epoch:string}>(`SELECT epoch::text FROM router_authority WHERE scope=$1`,[domain])).rows[0];
  if(!row)throw new RouterProjectionUnavailable('authority');
  return {kind:'authority-fence',scope,authorityScope:domain,mode:allowed?'advance':'deny',
    authority:routerAuthority([{authorityScope:domain,epoch:row.epoch}])};
}

/** Install after ROUTER_PROJECTION_SCHEMA. Each policy writer holds the same
 * exclusive lock as the independent final enqueue's shared fence. No provider
 * status, tokens or client possession enter these committed authority causes. */
export const SCHEDULED_WORK_AUTHORITY_SCHEMA=`
CREATE OR REPLACE FUNCTION beeline_scheduled_work_authority() RETURNS trigger AS $$
DECLARE item jsonb; next_item jsonb; prior_item jsonb; person text; workspace text; room text; domain text;
BEGIN
  IF TG_OP='UPDATE' THEN
    IF TG_TABLE_NAME='identities' THEN
      IF ROW(NEW.kind,NEW.hidden_from_roster) IS NOT DISTINCT FROM ROW(OLD.kind,OLD.hidden_from_roster) THEN RETURN NEW;END IF;
    ELSIF TG_TABLE_NAME='memberships' THEN
      IF ROW(NEW.workspace_id,NEW.room_id,NEW.identity_id,NEW.role,NEW.removed_at)
        IS NOT DISTINCT FROM ROW(OLD.workspace_id,OLD.room_id,OLD.identity_id,OLD.role,OLD.removed_at) THEN RETURN NEW;END IF;
    ELSIF TG_TABLE_NAME='rooms' THEN
      IF ROW(NEW.workspace_id,NEW.parent_id,NEW.archived_at,NEW.direct_participants)
        IS NOT DISTINCT FROM ROW(OLD.workspace_id,OLD.parent_id,OLD.archived_at,OLD.direct_participants) THEN RETURN NEW;END IF;
    END IF;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('${ROUTER_AUTHORITY_LOCK}',0));
  IF TG_OP<>'DELETE' THEN
    next_item:=to_jsonb(NEW);
    IF TG_TABLE_NAME='rooms' THEN next_item:=next_item||jsonb_build_object('_scheduled_public',NEW.direct_participants IS NULL);END IF;
  END IF;
  IF TG_OP<>'INSERT' THEN
    prior_item:=to_jsonb(OLD);
    IF TG_TABLE_NAME='rooms' THEN prior_item:=prior_item||jsonb_build_object('_scheduled_public',OLD.direct_participants IS NULL);END IF;
  END IF;
  FOR item IN SELECT DISTINCT value FROM jsonb_array_elements(jsonb_build_array(
    next_item,prior_item))
    WHERE value IS NOT NULL AND value<>'null'::jsonb
  LOOP
    IF TG_TABLE_NAME='identities' THEN
      person:=item->>'id';domain:='scheduled-work-principal:'||person;
      INSERT INTO router_authority(scope) VALUES(domain) ON CONFLICT(scope) DO UPDATE SET epoch=router_authority.epoch+1;
      PERFORM beeline_authority_hint(person,person,domain);
    ELSIF TG_TABLE_NAME='memberships' THEN
      person:=item->>'identity_id';workspace:=item->>'workspace_id';room:=item->>'room_id';
      -- Domain existence is not Workspace membership. Own-DM readers may
      -- receive content-free first-family denials without granting access.
      INSERT INTO router_authority(scope) VALUES('reader:'||person||':workspace:'||workspace) ON CONFLICT DO NOTHING;
      domain:=CASE WHEN room IS NULL THEN 'scheduled-work-manager:'||person||':workspace:'||workspace
        ELSE 'scheduled-work-member:'||person||':room:'||room END;
      INSERT INTO router_authority(scope) VALUES(domain) ON CONFLICT(scope) DO UPDATE SET epoch=router_authority.epoch+1;
      PERFORM beeline_authority_hint(person,COALESCE(room,workspace),domain);
    ELSE
      room:=item->>'id';workspace:=item->>'workspace_id';domain:='scheduled-work-room:'||room;
      INSERT INTO router_authority(scope) VALUES(domain) ON CONFLICT(scope) DO UPDATE SET epoch=router_authority.epoch+1;
      -- Evaluate each stored OLD/NEW Room policy against its actual active
      -- human manager audience. Workspace admins do not manage somebody else's
      -- DM; a participant name alone does not confer DM membership. OLD policy
      -- still selects real former recipients on moves/revokes. Earlier same-TX
      -- principal/membership removals already carry their own exact fences.
      FOR person IN SELECT DISTINCT member.identity_id FROM memberships member
        JOIN identities identity ON identity.id=member.identity_id AND identity.kind='human' AND NOT identity.hidden_from_roster
        WHERE member.removed_at IS NULL AND item->>'parent_id' IS NULL AND item->>'archived_at' IS NULL AND(
          (item->>'_scheduled_public')::boolean AND member.workspace_id::text=workspace
            AND member.room_id IS NULL AND member.role IN('owner','admin')
          OR NOT (item->>'_scheduled_public')::boolean AND member.room_id::text=room
            AND item->'direct_participants' ? member.identity_id
        ) LOOP
        PERFORM beeline_authority_hint(person,room,domain);
      END LOOP;
    END IF;
  END LOOP;
  IF TG_OP='DELETE' THEN RETURN OLD;END IF;RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS beeline_scheduled_work_authority ON identities;
CREATE TRIGGER beeline_scheduled_work_authority BEFORE INSERT OR UPDATE OR DELETE ON identities FOR EACH ROW EXECUTE FUNCTION beeline_scheduled_work_authority();
DROP TRIGGER IF EXISTS beeline_scheduled_work_authority ON memberships;
CREATE TRIGGER beeline_scheduled_work_authority BEFORE INSERT OR UPDATE OR DELETE ON memberships FOR EACH ROW EXECUTE FUNCTION beeline_scheduled_work_authority();
DROP TRIGGER IF EXISTS beeline_scheduled_work_authority ON rooms;
CREATE TRIGGER beeline_scheduled_work_authority BEFORE INSERT OR UPDATE OR DELETE ON rooms FOR EACH ROW EXECUTE FUNCTION beeline_scheduled_work_authority();
INSERT INTO router_authority(scope) SELECT 'scheduled-work-principal:'||id FROM identities ON CONFLICT DO NOTHING;
INSERT INTO router_authority(scope) SELECT 'scheduled-work-room:'||id FROM rooms ON CONFLICT DO NOTHING;
INSERT INTO router_authority(scope) SELECT DISTINCT CASE WHEN room_id IS NULL
  THEN 'scheduled-work-manager:'||identity_id||':workspace:'||workspace_id
  ELSE 'scheduled-work-member:'||identity_id||':room:'||room_id END FROM memberships ON CONFLICT DO NOTHING;
-- Existing human readers predate the identity trigger. An empty stream owns a
-- real initial position without inventing a source cause or advancing history.
INSERT INTO live_streams(id) SELECT 'authority:'||id FROM identities WHERE kind='human' ON CONFLICT DO NOTHING;
`;
