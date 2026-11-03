import { ROUTER_AUTHORITY_LOCK } from './router-projection-schema.js';
import { cornerOwnerSql } from './corner-worker.js';

export const profileDomain=(workspace:string,agent:string)=>`profile:${workspace}:${agent}`;
/** Profile permissions depend on the agent's current owner as well as
 * Workspace membership. This independent domain fences late private replies
 * without invalidating unrelated Room/Tray/roster certificates. */
export const ROUTER_PROFILE_SCHEMA=`
CREATE OR REPLACE FUNCTION beeline_profile_projection_source() RETURNS trigger AS $$
DECLARE item jsonb; previous jsonb; current jsonb; person text; agent text; workspace text; viewer text; domain text;
BEGIN
 IF TG_TABLE_NAME='agent_avatars' THEN
  previous:=CASE WHEN TG_OP<>'INSERT' THEN jsonb_build_object('agent_id',OLD.agent_id,'id',OLD.id) ELSE '{}'::jsonb END;
  current:=CASE WHEN TG_OP<>'DELETE' THEN jsonb_build_object('agent_id',NEW.agent_id,'id',NEW.id) ELSE '{}'::jsonb END;
 ELSIF TG_TABLE_NAME='agent_commands' THEN
  previous:=CASE WHEN TG_OP<>'INSERT' THEN jsonb_build_object('agent_id',OLD.agent_id,'state',OLD.state,'avatar_job',OLD.avatar_job,'reason',OLD.reason,'room_id',OLD.room_id) ELSE '{}'::jsonb END;
  current:=CASE WHEN TG_OP<>'DELETE' THEN jsonb_build_object('agent_id',NEW.agent_id,'state',NEW.state,'avatar_job',NEW.avatar_job,'reason',NEW.reason,'room_id',NEW.room_id) ELSE '{}'::jsonb END;
 ELSE
  previous:=CASE WHEN TG_OP<>'INSERT' THEN to_jsonb(OLD) ELSE '{}'::jsonb END;
  current:=CASE WHEN TG_OP<>'DELETE' THEN to_jsonb(NEW) ELSE '{}'::jsonb END;
 END IF;
 IF TG_OP='UPDATE' THEN
  IF previous IS NOT DISTINCT FROM current THEN RETURN NEW;END IF;
  IF TG_TABLE_NAME='agents' AND ROW(previous->'owner_id',previous->'access_policy',previous->'soul',previous->'harness',previous->'model_catalog',
    previous->'commands',previous->'selected_model',previous->'selected_effort',previous->'fast_mode',previous->'model_unavailable',
    previous->'yolo_mode',previous->'yolo_set_by',previous->'yolo_set_at') IS NOT DISTINCT FROM
   ROW(current->'owner_id',current->'access_policy',current->'soul',current->'harness',current->'model_catalog',
    current->'commands',current->'selected_model',current->'selected_effort',current->'fast_mode',current->'model_unavailable',
    current->'yolo_mode',current->'yolo_set_by',current->'yolo_set_at') THEN RETURN NEW;END IF;
  IF TG_TABLE_NAME='identities' AND
   ROW(current->'name',current->'handle',current->'avatar',current->'face_id',current->'hidden_from_roster')
   IS NOT DISTINCT FROM ROW(previous->'name',previous->'handle',previous->'avatar',previous->'face_id',previous->'hidden_from_roster') THEN RETURN NEW;END IF;
  IF TG_TABLE_NAME='memberships' AND
   ROW(current->'workspace_id',current->'room_id',current->'identity_id',current->'role',current->'removed_at')
   IS NOT DISTINCT FROM ROW(previous->'workspace_id',previous->'room_id',previous->'identity_id',previous->'role',previous->'removed_at') THEN RETURN NEW;END IF;
  IF TG_TABLE_NAME='rooms_mcp_members' AND
   ROW(current->'member_id',current->'client_id',current->'model_label',current->'callback_url',current->'callback_secret')
   IS NOT DISTINCT FROM ROW(previous->'member_id',previous->'client_id',previous->'model_label',previous->'callback_url',previous->'callback_secret') THEN RETURN NEW;END IF;
  IF TG_TABLE_NAME='rooms_mcp_clients' AND
   ROW(current->'name',current->'redirects',current->'callback_url')
   IS NOT DISTINCT FROM ROW(previous->'name',previous->'redirects',previous->'callback_url') THEN RETURN NEW;END IF;
 END IF;
 IF TG_TABLE_NAME='memberships' AND COALESCE(current->>'room_id',previous->>'room_id') IS NOT NULL THEN
  IF TG_OP='DELETE' THEN RETURN OLD;END IF;RETURN NEW;
 END IF;
 IF TG_TABLE_NAME='agent_commands' AND NOT(COALESCE((current->>'avatar_job')::boolean,false) OR COALESCE((previous->>'avatar_job')::boolean,false)
   OR TG_OP<>'UPDATE' AND COALESCE(current->>'reason',previous->>'reason') IN('corner_objective','human_tag')) THEN
  IF TG_OP='DELETE' THEN RETURN OLD;END IF;RETURN NEW;
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('${ROUTER_AUTHORITY_LOCK}',0));
 FOR agent IN SELECT DISTINCT candidate FROM (
   SELECT COALESCE(current->>'agent_id',previous->>'agent_id') candidate WHERE TG_TABLE_NAME<>'identities' AND TG_TABLE_NAME<>'memberships'
   UNION SELECT COALESCE(current->>'identity_id',previous->>'identity_id') WHERE TG_TABLE_NAME='memberships'
   UNION SELECT COALESCE(current->>'id',previous->>'id') WHERE TG_TABLE_NAME='identities' AND
     (current->>'kind'='agent' OR previous->>'kind'='agent')
   UNION SELECT named.agent_id FROM agents named WHERE TG_TABLE_NAME='identities' AND named.owner_id=COALESCE(current->>'id',previous->>'id')
   UNION SELECT grant_row.agent_id FROM agent_grants grant_row WHERE TG_TABLE_NAME='identities' AND
     COALESCE(current->>'id',previous->>'id') IN(grant_row.requested_by,grant_row.decided_by)
   UNION SELECT COALESCE(current->>'member_id',previous->>'member_id') WHERE TG_TABLE_NAME='rooms_mcp_members'
   UNION SELECT member.member_id FROM rooms_mcp_members member WHERE TG_TABLE_NAME='rooms_mcp_clients' AND
     member.client_id=COALESCE(current->>'id',previous->>'id')
   UNION SELECT ${cornerOwnerSql("NULLIF(COALESCE(current->>'corner_id',previous->>'corner_id'),'')::uuid")}
     WHERE TG_TABLE_NAME='corner_github_cache'
 ) candidates WHERE candidate IS NOT NULL ORDER BY candidate LOOP
  FOR workspace IN SELECT DISTINCT membership.workspace_id::text FROM memberships membership
    WHERE membership.identity_id=agent AND membership.room_id IS NULL
    UNION SELECT image->>'workspace_id' FROM jsonb_array_elements(jsonb_build_array(previous,current)) image
      WHERE TG_TABLE_NAME='memberships' AND image->>'room_id' IS NULL AND image->>'identity_id'=agent AND image->>'workspace_id' IS NOT NULL
    ORDER BY 1 LOOP
   domain:='profile:'||workspace||':'||agent;
   INSERT INTO router_authority(scope) VALUES(domain) ON CONFLICT(scope) DO UPDATE SET epoch=router_authority.epoch+1;
   PERFORM beeline_journal('workspace:'||workspace,jsonb_build_object('sourceTable','profile-projection','profileAgentId',agent));
   PERFORM beeline_notify_live_control(jsonb_build_object('table','router_source','operation',TG_OP,'roomId','',
     'journalStreams',jsonb_build_array('workspace:'||workspace))::text);
   FOR viewer IN SELECT identity_id FROM memberships WHERE workspace_id=workspace::uuid AND room_id IS NULL AND removed_at IS NULL LOOP
    PERFORM beeline_authority_hint(viewer,agent,domain);
   END LOOP;
  END LOOP;
 END LOOP;
 IF TG_OP='DELETE' THEN RETURN OLD;END IF;RETURN NEW;
END;$$ LANGUAGE plpgsql;
DO $$ DECLARE table_name text;BEGIN
 FOREACH table_name IN ARRAY ARRAY['agents','identities','memberships','agent_grants','agent_avatars','agent_commands','rooms_mcp_members','rooms_mcp_clients','corner_github_cache'] LOOP
  EXECUTE format('DROP TRIGGER IF EXISTS beeline_profile_projection_source ON %I',table_name);
  EXECUTE format('CREATE TRIGGER beeline_profile_projection_source BEFORE INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION beeline_profile_projection_source()',table_name);
 END LOOP;
END $$;
INSERT INTO router_authority(scope) SELECT DISTINCT 'profile:'||member.workspace_id||':'||member.identity_id
 FROM memberships member JOIN identities person ON person.id=member.identity_id AND person.kind='agent'
 WHERE member.room_id IS NULL ON CONFLICT DO NOTHING;
`;
