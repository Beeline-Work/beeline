import {ROUTER_AUTHORITY_LOCK} from './router-authority-lock.js';

/** One Workspace roster version covers its public rows and manager header.
 * Search/page snapshots bind this version and never become live query owners. */
export const ROUTER_ROSTER_SCHEMA=`
CREATE OR REPLACE FUNCTION beeline_roster_projection_source() RETURNS trigger AS $$
DECLARE current jsonb;previous jsonb;workspace text;
BEGIN
 current:=CASE WHEN TG_OP<>'DELETE' THEN to_jsonb(NEW) ELSE '{}'::jsonb END;
 previous:=CASE WHEN TG_OP<>'INSERT' THEN to_jsonb(OLD) ELSE '{}'::jsonb END;
 IF TG_TABLE_NAME='memberships' AND (TG_OP='INSERT' AND current->>'room_id' IS NOT NULL OR
   TG_OP='DELETE' AND previous->>'room_id' IS NOT NULL OR TG_OP='UPDATE' AND current->>'room_id' IS NOT NULL AND previous->>'room_id' IS NOT NULL) THEN
  IF TG_OP='DELETE' THEN RETURN OLD;END IF;RETURN NEW;END IF;
 IF TG_OP='UPDATE' THEN
  IF TG_TABLE_NAME='memberships' AND ROW(current->'identity_id',current->'workspace_id',current->'room_id',current->'role',current->'removed_at')
   IS NOT DISTINCT FROM ROW(previous->'identity_id',previous->'workspace_id',previous->'room_id',previous->'role',previous->'removed_at') THEN RETURN NEW;END IF;
  IF TG_TABLE_NAME='identities' AND ROW(current->'name',current->'handle',current->'avatar',current->'face_id',current->'kind',current->'hidden_from_roster')
   IS NOT DISTINCT FROM ROW(previous->'name',previous->'handle',previous->'avatar',previous->'face_id',previous->'kind',previous->'hidden_from_roster') THEN RETURN NEW;END IF;
  IF TG_TABLE_NAME='agents' AND ROW(current->'owner_id',current->'selected_model',current->'model_catalog')
   IS NOT DISTINCT FROM ROW(previous->'owner_id',previous->'selected_model',previous->'model_catalog') THEN RETURN NEW;END IF;
  IF TG_TABLE_NAME='rooms' AND ROW(current->'workspace_id',current->'parent_id',current->'direct_participants',current->'archived_at',current->'name',current->'visibility')
   IS NOT DISTINCT FROM ROW(previous->'workspace_id',previous->'parent_id',previous->'direct_participants',previous->'archived_at',previous->'name',previous->'visibility') THEN RETURN NEW;END IF;
  IF TG_TABLE_NAME='rooms_mcp_members' AND ROW(current->'member_id',current->'client_id',current->'model_label')
   IS NOT DISTINCT FROM ROW(previous->'member_id',previous->'client_id',previous->'model_label') THEN RETURN NEW;END IF;
  IF TG_TABLE_NAME='rooms_mcp_clients' AND ROW(current->'name',current->'redirects')
   IS NOT DISTINCT FROM ROW(previous->'name',previous->'redirects') THEN RETURN NEW;END IF;
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('${ROUTER_AUTHORITY_LOCK}',0));
 FOR workspace IN SELECT DISTINCT value FROM (
  SELECT image->>'workspace_id' value FROM jsonb_array_elements(jsonb_build_array(previous,current)) image
    WHERE TG_TABLE_NAME IN('memberships','rooms')
  UNION SELECT COALESCE(current->>'id',previous->>'id') WHERE TG_TABLE_NAME='workspaces'
  UNION SELECT member.workspace_id::text FROM memberships member WHERE member.room_id IS NULL AND (
    TG_TABLE_NAME='agents' AND member.identity_id=COALESCE(current->>'agent_id',previous->>'agent_id') OR
    TG_TABLE_NAME='identities' AND (member.identity_id=COALESCE(current->>'id',previous->>'id') OR
      EXISTS(SELECT 1 FROM agents owned WHERE owned.agent_id=member.identity_id AND owned.owner_id=COALESCE(current->>'id',previous->>'id'))) OR
    TG_TABLE_NAME='rooms_mcp_members' AND member.identity_id=COALESCE(current->>'member_id',previous->>'member_id') OR
    TG_TABLE_NAME='rooms_mcp_clients' AND EXISTS(SELECT 1 FROM rooms_mcp_members remote WHERE remote.member_id=member.identity_id
      AND remote.client_id=COALESCE(current->>'id',previous->>'id')))
 ) candidates WHERE value IS NOT NULL ORDER BY value LOOP
  INSERT INTO router_authority(scope) VALUES('roster:'||workspace) ON CONFLICT(scope) DO UPDATE SET epoch=router_authority.epoch+1;
  PERFORM beeline_journal('workspace:'||workspace,jsonb_build_object('sourceTable','roster-projection'));
  PERFORM beeline_journal('roster-authority:'||workspace,jsonb_build_object('sourceTable','roster-authority'));
  PERFORM beeline_notify_live_control(jsonb_build_object('table','router_source','operation',TG_OP,'roomId','',
    'journalStreams',jsonb_build_array('workspace:'||workspace,'roster-authority:'||workspace))::text);
 END LOOP;
 IF TG_OP='DELETE' THEN RETURN OLD;END IF;RETURN NEW;
END;$$ LANGUAGE plpgsql;
DO $$ DECLARE table_name text;BEGIN
 FOREACH table_name IN ARRAY ARRAY['memberships','identities','agents','rooms','workspaces','rooms_mcp_members','rooms_mcp_clients'] LOOP
  EXECUTE format('DROP TRIGGER IF EXISTS beeline_roster_projection_source ON %I',table_name);
  EXECUTE format('CREATE TRIGGER beeline_roster_projection_source BEFORE INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION beeline_roster_projection_source()',table_name);
 END LOOP;
END $$;
INSERT INTO router_authority(scope) SELECT 'roster:'||id FROM workspaces ON CONFLICT DO NOTHING;
`;
