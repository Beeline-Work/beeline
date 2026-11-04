import {SCHEDULED_WORK_ROW_SOURCE_SCHEMA} from './scheduled-work-row-source.js';

/** Exact ScheduledWorkResult sources. Old/new stored relationships select DB
 * audiences, never client possession. The late trigger preserves existing
 * Workspace-before-Room lock order. No credential/provider body is captured. */
export const ROOM_SCHEDULES_CAPTURE_SCHEMA=`
${SCHEDULED_WORK_ROW_SOURCE_SCHEMA}
CREATE OR REPLACE FUNCTION beeline_room_schedules_capture() RETURNS trigger AS $$
DECLARE item jsonb; targets jsonb:='[]'::jsonb; target jsonb; relation record; person text; source_room text; locked_workspace text;
BEGIN
  IF TG_TABLE_NAME='identities' AND TG_OP='DELETE' AND TG_WHEN='AFTER' THEN RETURN OLD;END IF;
  IF TG_TABLE_NAME='identities' THEN
  IF TG_OP='DELETE' OR TG_OP='UPDATE'
    AND ROW(NEW.kind,NEW.hidden_from_roster) IS DISTINCT FROM ROW(OLD.kind,OLD.hidden_from_roster) THEN
    -- Capture before membership/message FK actions erase the old audience.
    -- Lock every legacy identity scope before any cascade takes Room locks.
    FOR locked_workspace IN SELECT scope FROM(
      SELECT workspace_id::text scope FROM memberships WHERE identity_id=OLD.id
      UNION SELECT room.workspace_id::text FROM messages message JOIN rooms room ON room.id=message.room_id WHERE message.author_id=OLD.id
    ) scopes ORDER BY scope LOOP
      PERFORM beeline_journal('workspace:'||locked_workspace,jsonb_build_object('sourceTable','identities','recordId',OLD.id,'operation',TG_OP));
      PERFORM beeline_notify_live_control(jsonb_build_object('table','router_source','operation',TG_OP,'roomId','',
        'journalStreams',jsonb_build_array('workspace:'||locked_workspace))::text);
    END LOOP;
  END IF;
  END IF;
  IF TG_OP='UPDATE' THEN
    CASE TG_TABLE_NAME
      WHEN 'provider_webhooks' THEN IF ROW(NEW.id,NEW.status) IS NOT DISTINCT FROM ROW(OLD.id,OLD.status) THEN RETURN NEW;END IF;
      WHEN 'subscription_webhook_calls' THEN IF ROW(NEW.id,NEW.subscription_id,NEW.called_at,NEW.outcome,NEW.reason,NEW.byte_size,NEW.run_id,NEW.wake_message_id,NEW.repeat_at)
        IS NOT DISTINCT FROM ROW(OLD.id,OLD.subscription_id,OLD.called_at,OLD.outcome,OLD.reason,OLD.byte_size,OLD.run_id,OLD.wake_message_id,OLD.repeat_at) THEN RETURN NEW;END IF;
      WHEN 'identities' THEN IF ROW(NEW.kind,NEW.name,NEW.hidden_from_roster) IS NOT DISTINCT FROM ROW(OLD.kind,OLD.name,OLD.hidden_from_roster) THEN RETURN NEW;END IF;
      WHEN 'rooms' THEN IF ROW(NEW.workspace_id,NEW.parent_id,NEW.archived_at,NEW.direct_participants,NEW.name,NEW.reviewer_agent_id)
        IS NOT DISTINCT FROM ROW(OLD.workspace_id,OLD.parent_id,OLD.archived_at,OLD.direct_participants,OLD.name,OLD.reviewer_agent_id) THEN RETURN NEW;END IF;
      WHEN 'memberships' THEN IF ROW(NEW.workspace_id,NEW.room_id,NEW.identity_id,NEW.role,NEW.removed_at,NEW.event_subscriptions,NEW.joined_at)
        IS NOT DISTINCT FROM ROW(OLD.workspace_id,OLD.room_id,OLD.identity_id,OLD.role,OLD.removed_at,OLD.event_subscriptions,OLD.joined_at) THEN RETURN NEW;END IF;
      WHEN 'corner_person_state' THEN IF ROW(NEW.corner_id,NEW.identity_id,NEW.event_subscriptions,NEW.created_at)
        IS NOT DISTINCT FROM ROW(OLD.corner_id,OLD.identity_id,OLD.event_subscriptions,OLD.created_at) THEN RETURN NEW;END IF;
      WHEN 'corner_facts' THEN IF ROW(NEW.corner_id,NEW.reviewer_agent_id) IS NOT DISTINCT FROM ROW(OLD.corner_id,OLD.reviewer_agent_id) THEN RETURN NEW;END IF;
      ELSE RETURN NEW;
    END CASE;
  END IF;
  FOR item IN SELECT DISTINCT value FROM jsonb_array_elements(jsonb_build_array(
    CASE WHEN TG_OP<>'DELETE' THEN to_jsonb(NEW) END,CASE WHEN TG_OP<>'INSERT' THEN to_jsonb(OLD) END))
    WHERE value IS NOT NULL AND value<>'null'::jsonb
  LOOP
    IF TG_TABLE_NAME='rooms' AND item->>'parent_id' IS NULL THEN
      targets:=targets||jsonb_build_array(jsonb_build_object('workspace',item->>'workspace_id','room',item->>'id','readers',item->'direct_participants'));
    END IF;
    IF TG_TABLE_NAME='identities' THEN
      person:=item->>'id';
      IF item->>'kind'='agent' AND(TG_OP<>'UPDATE' OR ROW(NEW.kind,NEW.name) IS DISTINCT FROM ROW(OLD.kind,OLD.name)) THEN
        targets:=targets||COALESCE((SELECT jsonb_agg(jsonb_build_object('workspace',parent.workspace_id,'room',parent.id,'readers',parent.direct_participants))
          FROM room_access member JOIN rooms surface ON surface.id=member.room_id JOIN rooms parent ON parent.id=COALESCE(surface.parent_id,surface.id)
          WHERE member.identity_id=person AND member.removed_at IS NULL),'[]'::jsonb);
      END IF;
      IF TG_OP<>'UPDATE' OR ROW(NEW.kind,NEW.hidden_from_roster) IS DISTINCT FROM ROW(OLD.kind,OLD.hidden_from_roster) THEN
        targets:=targets||COALESCE((SELECT jsonb_agg(jsonb_build_object('workspace',room.workspace_id,'room',room.id,'readers',jsonb_build_array(person)))
          FROM rooms room WHERE room.parent_id IS NULL AND(
            room.direct_participants IS NULL AND EXISTS(SELECT 1 FROM memberships manager WHERE manager.workspace_id=room.workspace_id
              AND manager.room_id IS NULL AND manager.identity_id=person )
            OR room.direct_participants ? person AND EXISTS(SELECT 1 FROM memberships member WHERE member.room_id=room.id AND member.identity_id=person))),'[]'::jsonb);
      END IF;
    ELSIF TG_TABLE_NAME='memberships' AND item->>'room_id' IS NULL THEN
        targets:=targets||COALESCE((SELECT jsonb_agg(jsonb_build_object('workspace',room.workspace_id,'room',room.id,'readers',jsonb_build_array(item->>'identity_id')))
          FROM rooms room WHERE room.workspace_id::text=item->>'workspace_id' AND room.parent_id IS NULL AND room.direct_participants IS NULL),'[]'::jsonb);
    ELSE
      source_room:=CASE WHEN TG_TABLE_NAME='rooms' THEN item->>'parent_id'
        WHEN TG_TABLE_NAME IN('corner_facts','corner_person_state') THEN item->>'corner_id' ELSE item->>'room_id' END;
      FOR relation IN
        SELECT parent.workspace_id,parent.id,parent.direct_participants FROM rooms surface JOIN rooms parent ON parent.id=COALESCE(surface.parent_id,surface.id)
          WHERE surface.id::text=source_room
        UNION SELECT parent.workspace_id,parent.id,parent.direct_participants FROM agent_subscriptions subscription
          JOIN rooms surface ON surface.id=subscription.room_id JOIN rooms parent ON parent.id=COALESCE(surface.parent_id,surface.id)
          WHERE (TG_TABLE_NAME='provider_webhooks' AND subscription.trigger_id=item->>'id')
            OR(TG_TABLE_NAME='subscription_webhook_calls' AND subscription.id::text=item->>'subscription_id')
      LOOP targets:=targets||jsonb_build_array(jsonb_build_object('workspace',relation.workspace_id,'room',relation.id,'readers',relation.direct_participants));END LOOP;
    END IF;
  END LOOP;
  FOR target IN SELECT value FROM(SELECT DISTINCT value FROM jsonb_array_elements(targets)) unique_targets
    ORDER BY value->>'workspace',value->>'room',value::text LOOP
    PERFORM beeline_journal('workspace:'||(target->>'workspace'),jsonb_build_object('sourceTable','scheduled-work-projection',
      'originTable',TG_TABLE_NAME,'operation',TG_OP,'sourceRoomId',target->>'room','scheduledWorkReaders',target->'readers'));
    PERFORM beeline_notify_live_control(jsonb_build_object('table','router_source','operation',TG_OP,'roomId','',
      'journalStreams',jsonb_build_array('workspace:'||(target->>'workspace')))::text);
  END LOOP;
  IF TG_OP='DELETE' THEN RETURN OLD;END IF;RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DO $$ DECLARE name text;BEGIN
  FOREACH name IN ARRAY ARRAY['agent_schedules','agent_subscriptions'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS beeline_room_schedules_capture ON %I',name);
    EXECUTE format('DROP TRIGGER IF EXISTS zz_beeline_scheduled_work_capture ON %I',name);
  END LOOP;
  FOREACH name IN ARRAY ARRAY['provider_webhooks','subscription_webhook_calls',
    'memberships','corner_person_state','corner_facts','rooms','identities'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS beeline_room_schedules_capture ON %I',name);
    EXECUTE format('DROP TRIGGER IF EXISTS zz_beeline_scheduled_work_capture ON %I',name);
    EXECUTE format('CREATE TRIGGER zz_beeline_scheduled_work_capture AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION beeline_room_schedules_capture()',name);
  END LOOP;
END $$;
DROP TRIGGER IF EXISTS zz_beeline_scheduled_work_identity_delete ON identities;
CREATE TRIGGER zz_beeline_scheduled_work_identity_delete BEFORE DELETE ON identities FOR EACH ROW EXECUTE FUNCTION beeline_room_schedules_capture();
`;
