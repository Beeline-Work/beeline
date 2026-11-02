/** One early owner of schedule/subscription Workspace causes. Dependency-free
 * so both the legacy live installer and isolated source schemas can install it
 * before any Room journal lock, without a runtime/module cycle. */
export const SCHEDULED_WORK_ROW_SOURCE_SCHEMA=`
CREATE OR REPLACE FUNCTION beeline_scheduled_work_row_source() RETURNS trigger AS $$
DECLARE prior_item jsonb; next_item jsonb; item jsonb; source_room text; previous_room text; parent_room text;
  workspace text; workspace_target text; workspace_scopes text[]:=ARRAY[]::text[]; streams text[]:=ARRAY[]::text[];
  targets jsonb:='[]'::jsonb; selected_targets jsonb; metadata jsonb; relation record;
  display_changed boolean:=true; unavailable text;
BEGIN
  IF TG_TABLE_NAME NOT IN('agent_schedules','agent_subscriptions') THEN RAISE EXCEPTION 'invalid_scheduled_work_row_source';END IF;
  IF TG_OP<>'DELETE' THEN next_item:=to_jsonb(NEW);END IF;
  IF TG_OP<>'INSERT' THEN prior_item:=to_jsonb(OLD);END IF;
  IF TG_OP='UPDATE' THEN
    IF TG_TABLE_NAME='agent_schedules' THEN
      display_changed:=ROW(NEW.id,NEW.workspace_id,NEW.room_id,NEW.agent_id,NEW.creator_id,NEW.title,NEW.max_runs,NEW.cadence,NEW.message,NEW.next_run_at,NEW.created_at,NEW.workflow_slug,NEW.run_count,NEW.workflow_run)
        IS DISTINCT FROM ROW(OLD.id,OLD.workspace_id,OLD.room_id,OLD.agent_id,OLD.creator_id,OLD.title,OLD.max_runs,OLD.cadence,OLD.message,OLD.next_run_at,OLD.created_at,OLD.workflow_slug,OLD.run_count,OLD.workflow_run);
    ELSE
      display_changed:=(next_item-ARRAY['webhook_token','webhook_owner_id']) IS DISTINCT FROM (prior_item-ARRAY['webhook_token','webhook_owner_id']);
    END IF;
  END IF;
  source_room:=COALESCE(next_item->>'room_id',prior_item->>'room_id');previous_room:=prior_item->>'room_id';
  SELECT workspace_id::text,parent_id::text INTO workspace,parent_room FROM rooms WHERE id=source_room::uuid;
  workspace_scopes:=ARRAY[workspace,next_item->>'workspace_id',prior_item->>'workspace_id'];
  IF previous_room IS NOT NULL THEN
    workspace_scopes:=workspace_scopes||ARRAY(SELECT workspace_id::text FROM rooms WHERE id=previous_room::uuid);
  END IF;
  IF display_changed THEN
    FOR item IN SELECT DISTINCT value FROM jsonb_array_elements(jsonb_build_array(next_item,prior_item))
      WHERE value IS NOT NULL AND value<>'null'::jsonb LOOP
      SELECT parent.workspace_id::text workspace_id,parent.id::text room_id,parent.direct_participants INTO relation
        FROM rooms surface JOIN rooms parent ON parent.id=COALESCE(surface.parent_id,surface.id)
        WHERE surface.id::text=item->>'room_id';
      IF NOT FOUND THEN unavailable:='dependency';CONTINUE;END IF;
      workspace_scopes:=array_append(workspace_scopes,relation.workspace_id);
      IF relation.direct_participants IS NOT NULL THEN
        IF jsonb_typeof(relation.direct_participants)<>'array' THEN unavailable:='dependency';CONTINUE;END IF;
        IF jsonb_array_length(relation.direct_participants)>100 THEN
          unavailable:=COALESCE(unavailable,'budget');CONTINUE;
        END IF;
        IF EXISTS(SELECT 1 FROM jsonb_array_elements(relation.direct_participants) reader
          WHERE jsonb_typeof(reader)<>'string' OR length(reader#>>'{}')>256) THEN unavailable:='dependency';CONTINUE;END IF;
      END IF;
      targets:=targets||jsonb_build_array(jsonb_build_object('workspace',relation.workspace_id,'roomId',relation.room_id,'readers',relation.direct_participants));
    END LOOP;
  END IF;
  -- Lock every actual/stored OLD+NEW Workspace once, before the unchanged
  -- generic live trigger acquires Room/former Room/parent journal locks.
  FOR workspace_target IN SELECT DISTINCT value FROM unnest(workspace_scopes) value WHERE value IS NOT NULL ORDER BY value LOOP
    SELECT COALESCE(jsonb_agg(value-'workspace' ORDER BY value->>'roomId',value::text),'[]'::jsonb) INTO selected_targets
      FROM(SELECT DISTINCT value FROM jsonb_array_elements(targets) WHERE value->>'workspace'=workspace_target) selected;
    metadata:=CASE WHEN unavailable IS NOT NULL THEN jsonb_build_object('version',1,'classification','unavailable','reason',unavailable)
      ELSE jsonb_build_object('version',1,'classification','complete','targets',selected_targets) END;
    PERFORM beeline_journal('workspace:'||workspace_target,jsonb_build_object(
      'type','invalidate','roomId','','reason','workspace-replay','sourceRoomId',source_room,
      'sourceTable',TG_TABLE_NAME,'operation',TG_OP,'messageId',NULL,'identityId',NULL,
      'agentId',COALESCE(next_item->>'agent_id',prior_item->>'agent_id'),'parentRoomId',parent_room,
      'oldRoomId',previous_room,'newRoomId',source_room,'oldParentRoomId',NULL,'newParentRoomId',NULL,
      'sourceRemoved',false,'needsYouCandidate',NULL,'removed',NULL,'scheduledWorkSource',metadata));
    streams:=array_append(streams,'workspace:'||workspace_target);
  END LOOP;
  IF cardinality(streams)>0 THEN PERFORM pg_notify('beeline_live_v1',jsonb_build_object(
    'table','router_source','operation',TG_OP,'roomId','','journalStreams',streams)::text);END IF;
  IF TG_OP='DELETE' THEN RETURN OLD;END IF;RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DO $$ DECLARE name text;BEGIN
  FOREACH name IN ARRAY ARRAY['agent_schedules','agent_subscriptions'] LOOP
    IF to_regclass(name) IS NULL THEN CONTINUE;END IF;
    EXECUTE format('DROP TRIGGER IF EXISTS aa_beeline_scheduled_work_row_source ON %I',name);
    EXECUTE format('CREATE TRIGGER aa_beeline_scheduled_work_row_source AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION beeline_scheduled_work_row_source()',name);
  END LOOP;
END $$;
`;
