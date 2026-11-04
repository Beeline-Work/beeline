/** Only compact authority counters are persisted. No setup DTO, script,
 * credential or grant material is written to a journal by this source. */
export const HELPER_ACTIVATION_SCHEMA=`
CREATE TABLE IF NOT EXISTS helper_activation_authority(
 workspace_id uuid PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
 generation text NOT NULL DEFAULT md5(random()::text || clock_timestamp()::text),
 revision bigint NOT NULL DEFAULT 1
);
INSERT INTO helper_activation_authority(workspace_id) SELECT id FROM workspaces ON CONFLICT DO NOTHING;
CREATE OR REPLACE FUNCTION beeline_activation_touch(scope uuid) RETURNS void AS $$
BEGIN
 IF scope IS NULL OR NOT EXISTS(SELECT 1 FROM workspaces WHERE id=scope) THEN RETURN;END IF;
 INSERT INTO helper_activation_authority(workspace_id) VALUES(scope)
 ON CONFLICT(workspace_id) DO UPDATE SET revision=helper_activation_authority.revision+1;
END; $$ LANGUAGE plpgsql;
CREATE OR REPLACE FUNCTION beeline_activation_source() RETURNS trigger AS $$
DECLARE prior jsonb; item jsonb; scope uuid; subject text; room uuid; fields text[];
BEGIN
 prior:=CASE WHEN TG_OP='INSERT' THEN NULL ELSE to_jsonb(OLD) END;
 item:=CASE WHEN TG_OP='DELETE' THEN NULL ELSE to_jsonb(NEW) END;
 IF prior IS NOT DISTINCT FROM item THEN RETURN NULL;END IF;
 -- Usage, lease, progress and metadata timestamp writes do not change setup.
 IF TG_TABLE_NAME='agents' THEN
   fields:=ARRAY['owner_id','machine_id','machine_name','soul','selected_model','selected_effort','fast_mode','commands','yolo_mode'];
 ELSIF TG_TABLE_NAME='identities' THEN
   fields:=ARRAY['id','kind','name','handle','hidden_from_roster'];
 ELSIF TG_TABLE_NAME='memberships' THEN
   fields:=ARRAY['workspace_id','room_id','identity_id','role','removed_at'];
 ELSIF TG_TABLE_NAME='workspaces' THEN
   fields:=ARRAY['id','visibility'];
 ELSIF TG_TABLE_NAME='rooms' THEN
   fields:=ARRAY['workspace_id','parent_id','archived_at','name','repository_key','repository_remote','repository_target_branch','repository_resolution','direct_participants','created_by'];
 ELSIF TG_TABLE_NAME='workspace_connectors' THEN
   fields:=ARRAY['owner_identity_id','machine_id','helper_agent_id','connector_type','status','registry_server_name','display_name'];
 END IF;
 IF TG_OP='UPDATE' AND fields IS NOT NULL AND NOT EXISTS(
   SELECT 1 FROM unnest(fields) field WHERE prior->field IS DISTINCT FROM item->field
 ) THEN RETURN NULL;END IF;
 -- OLD and NEW audiences both matter for moves, revoke and owner changes.
 FOR subject IN SELECT DISTINCT value FROM unnest(ARRAY[
   prior->>'identity_id',item->>'identity_id',prior->>'agent_id',item->>'agent_id',
   CASE WHEN TG_TABLE_NAME='identities' THEN prior->>'id' END,
   CASE WHEN TG_TABLE_NAME='identities' THEN item->>'id' END]) value WHERE value IS NOT NULL
 LOOP
   FOR scope IN SELECT DISTINCT workspace_id FROM memberships WHERE identity_id=subject ORDER BY workspace_id
   LOOP PERFORM beeline_activation_touch(scope);END LOOP;
   IF TG_TABLE_NAME='identities' THEN
     FOR scope IN SELECT DISTINCT member.workspace_id FROM memberships member JOIN agents actor ON actor.agent_id=member.identity_id
       WHERE actor.owner_id=subject ORDER BY member.workspace_id
     LOOP PERFORM beeline_activation_touch(scope);END LOOP;
   END IF;
 END LOOP;
 FOR scope IN SELECT DISTINCT value::uuid FROM unnest(ARRAY[prior->>'workspace_id',item->>'workspace_id',
   CASE WHEN TG_TABLE_NAME='workspaces' THEN prior->>'id' END,
   CASE WHEN TG_TABLE_NAME='workspaces' THEN item->>'id' END]) value WHERE value IS NOT NULL ORDER BY value::uuid
 LOOP PERFORM beeline_activation_touch(scope);END LOOP;
 FOR room IN SELECT DISTINCT value::uuid FROM unnest(ARRAY[prior->>'corner_id',item->>'corner_id',prior->>'room_id',item->>'room_id']) value
   WHERE value IS NOT NULL ORDER BY value::uuid
 LOOP SELECT workspace_id INTO scope FROM rooms WHERE id=room;PERFORM beeline_activation_touch(scope);END LOOP;
 IF TG_TABLE_NAME='workspace_connectors' THEN
   FOR scope IN SELECT DISTINCT member.workspace_id FROM memberships member JOIN agents actor ON actor.agent_id=member.identity_id
     WHERE actor.owner_id=ANY(ARRAY[prior->>'owner_identity_id',item->>'owner_identity_id']) ORDER BY member.workspace_id
   LOOP PERFORM beeline_activation_touch(scope);END LOOP;
 END IF;
 IF TG_TABLE_NAME='workspace_apps' THEN
   FOR scope IN SELECT DISTINCT workspace_id FROM agent_grants
     WHERE app_id=ANY(ARRAY[(prior->>'id')::uuid,(item->>'id')::uuid]) ORDER BY workspace_id
   LOOP PERFORM beeline_activation_touch(scope);END LOOP;
 END IF;
 RETURN NULL;
END; $$ LANGUAGE plpgsql;
DO $$ DECLARE source text; BEGIN
 FOREACH source IN ARRAY ARRAY['workspaces','agents','identities','memberships','rooms','agent_grants','workspace_apps',
   'workspace_connectors','corner_facts','corner_brief_revisions','corner_merge_holds','corner_merge_approvals','free_agents'] LOOP
   EXECUTE format('DROP TRIGGER IF EXISTS beeline_activation_source ON %I',source);
   EXECUTE format('CREATE TRIGGER beeline_activation_source AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION beeline_activation_source()',source);
 END LOOP;
END $$;
`;
