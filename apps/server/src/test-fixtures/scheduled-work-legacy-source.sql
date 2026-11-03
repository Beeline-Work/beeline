-- Frozen pre-fold schedule/subscription branches from beeline_notify_live and
-- beeline_room_schedules_capture. Other table cases are intentionally omitted;
-- this fixture mutates only these two tables. Preserve the original bodies,
-- payload fields and journal lock order when testing mixed/older migration.
-- Source: apps/server/src/postgres-live.ts at f43bd3f86. The source Room
-- body has no operation field; workspace and previous-Room bodies do.
CREATE OR REPLACE FUNCTION beeline_notify_live() RETURNS trigger AS $$
DECLARE payload jsonb;workspace text;workspace_target text;workspace_scopes text[];
  previous_room text;source_room text;parent_room text;body jsonb;streams text[]:=ARRAY[]::text[];
BEGIN
  IF TG_TABLE_NAME NOT IN('agent_schedules','agent_subscriptions') THEN RAISE EXCEPTION 'legacy_fixture_wrong_table';END IF;
  payload=jsonb_build_object('table',TG_TABLE_NAME,'operation',TG_OP,
    'roomId',COALESCE(NEW.room_id,OLD.room_id),'agentId',COALESCE(NEW.agent_id,OLD.agent_id),
    'scheduleId',COALESCE(NEW.id,OLD.id),'cornerParentId',(SELECT parent_id FROM rooms WHERE id=COALESCE(NEW.room_id,OLD.room_id)));
  payload=payload||jsonb_build_object('traceId',md5(random()::text||clock_timestamp()::text||txid_current()::text),
    'databaseAt',floor(extract(epoch FROM clock_timestamp())*1000)::bigint);
  IF payload->>'roomId' IS NOT NULL THEN
    source_room:=NULLIF(payload->>'roomId','');parent_room:=NULLIF(payload->>'cornerParentId','');
    workspace:=COALESCE(payload->>'workspaceId',(SELECT workspace_id::text FROM rooms WHERE id=source_room::uuid));
    IF source_room IS NOT NULL OR workspace IS NOT NULL THEN
      previous_room:=COALESCE(to_jsonb(OLD)->>'room_id',to_jsonb(OLD)->>'corner_id');
      workspace_scopes:=ARRAY[workspace,to_jsonb(NEW)->>'workspace_id',to_jsonb(OLD)->>'workspace_id'];
      IF previous_room IS NOT NULL THEN workspace_scopes:=workspace_scopes||ARRAY(SELECT workspace_id::text FROM rooms WHERE id=previous_room::uuid);END IF;
      FOR workspace_target IN SELECT DISTINCT value FROM unnest(workspace_scopes) value WHERE value IS NOT NULL ORDER BY value LOOP
        PERFORM beeline_journal('workspace:'||workspace_target,jsonb_build_object(
          'type','invalidate','roomId','','reason','workspace-replay','sourceRoomId',source_room,'sourceTable',TG_TABLE_NAME,'operation',TG_OP,
          'messageId',payload->>'messageId','identityId',payload->>'identityId','agentId',payload->>'agentId','parentRoomId',parent_room,
          'oldRoomId',previous_room,'newRoomId',source_room,'oldParentRoomId',NULL,'newParentRoomId',NULL,
          'sourceRemoved',false,'needsYouCandidate',payload->'needsYouCandidate','removed',payload->'removed'));
        streams:=array_append(streams,'workspace:'||workspace_target);
      END LOOP;
      IF source_room IS NOT NULL THEN
        body:=jsonb_strip_nulls(jsonb_build_object('type','invalidate','roomId',source_room,'reason','postgres:'||TG_TABLE_NAME,
          'messageId',payload->>'messageId','agentId',payload->>'agentId','requestId',payload->>'requestId',
          'trace',jsonb_build_object('id',payload->>'traceId','databaseAt',payload->'databaseAt','emittedAt',payload->'databaseAt'),'readerId',NULL));
        PERFORM beeline_journal('room:'||source_room,body);streams:=array_append(streams,'room:'||source_room);
      END IF;
      IF previous_room IS NOT NULL AND previous_room IS DISTINCT FROM source_room THEN
        PERFORM beeline_journal('room:'||previous_room,jsonb_build_object('type','invalidate','roomId',previous_room,'reason','postgres:'||TG_TABLE_NAME,
          'messageId',payload->>'messageId','operation',TG_OP));streams:=array_append(streams,'room:'||previous_room);
      END IF;
      IF parent_room IS NOT NULL AND parent_room IS DISTINCT FROM source_room THEN
        PERFORM beeline_journal('room:'||parent_room,jsonb_build_object('type','invalidate','roomId',parent_room,'reason','corner-status'));
        streams:=array_append(streams,'room:'||parent_room);
      END IF;
    END IF;
    payload:=payload||jsonb_build_object('journalStreams',streams);PERFORM pg_notify('beeline_live_v1',payload::text);
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD;END IF;RETURN NEW;
END;
$$ LANGUAGE plpgsql;
-- The earlier Scheduled Work installer could also restore its late standalone
-- source after the canonical early owner was installed. It must only duplicate.
CREATE OR REPLACE FUNCTION beeline_room_schedules_capture() RETURNS trigger AS $$
DECLARE item jsonb;targets jsonb:='[]'::jsonb;target jsonb;relation record;
BEGIN
  IF TG_OP='UPDATE' THEN
    IF TG_TABLE_NAME='agent_schedules' THEN
      IF ROW(NEW.id,NEW.workspace_id,NEW.room_id,NEW.agent_id,NEW.creator_id,NEW.title,NEW.max_runs,NEW.cadence,NEW.message,NEW.next_run_at,NEW.created_at,NEW.workflow_slug,NEW.run_count,NEW.workflow_run)
        IS NOT DISTINCT FROM ROW(OLD.id,OLD.workspace_id,OLD.room_id,OLD.agent_id,OLD.creator_id,OLD.title,OLD.max_runs,OLD.cadence,OLD.message,OLD.next_run_at,OLD.created_at,OLD.workflow_slug,OLD.run_count,OLD.workflow_run) THEN RETURN NEW;END IF;
    ELSE IF (to_jsonb(NEW)-ARRAY['webhook_token','webhook_owner_id']) IS NOT DISTINCT FROM (to_jsonb(OLD)-ARRAY['webhook_token','webhook_owner_id']) THEN RETURN NEW;END IF;END IF;
  END IF;
  FOR item IN SELECT DISTINCT value FROM jsonb_array_elements(jsonb_build_array(
    CASE WHEN TG_OP<>'DELETE' THEN to_jsonb(NEW) END,CASE WHEN TG_OP<>'INSERT' THEN to_jsonb(OLD) END))
    WHERE value IS NOT NULL AND value<>'null'::jsonb LOOP
    FOR relation IN SELECT parent.workspace_id,parent.id,parent.direct_participants FROM rooms surface
      JOIN rooms parent ON parent.id=COALESCE(surface.parent_id,surface.id) WHERE surface.id::text=item->>'room_id' LOOP
      targets:=targets||jsonb_build_array(jsonb_build_object('workspace',relation.workspace_id,'room',relation.id,'readers',relation.direct_participants));
    END LOOP;
  END LOOP;
  FOR target IN SELECT value FROM(SELECT DISTINCT value FROM jsonb_array_elements(targets)) unique_targets
    ORDER BY value->>'workspace',value->>'room',value::text LOOP
    PERFORM beeline_journal('workspace:'||(target->>'workspace'),jsonb_build_object('sourceTable','scheduled-work-projection',
      'originTable',TG_TABLE_NAME,'operation',TG_OP,'sourceRoomId',target->>'room','scheduledWorkReaders',target->'readers'));
    PERFORM pg_notify('beeline_live_v1',jsonb_build_object('table','router_source','operation',TG_OP,'roomId','',
      'journalStreams',jsonb_build_array('workspace:'||(target->>'workspace')))::text);
  END LOOP;
  IF TG_OP='DELETE' THEN RETURN OLD;END IF;RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DO $$ DECLARE name text;BEGIN
  FOREACH name IN ARRAY ARRAY['agent_schedules','agent_subscriptions'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS zz_beeline_scheduled_work_capture ON %I',name);
    EXECUTE format('CREATE TRIGGER zz_beeline_scheduled_work_capture AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION beeline_room_schedules_capture()',name);
  END LOOP;
END $$;
