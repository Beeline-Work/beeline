import { committedCommandNotificationSchema } from './postgres-live-notifications.js';

/** Each key owns one business family, not the former catch-all repair tick. */
export const backgroundDueKey = (family: string) => ({ principal: 'background', operation: 'source', commandId: family });
export const BACKGROUND_SOURCES = [
  ['next-day-checkin', 'next_day_checkin_candidates', 'due_at,processed'],
  ['next-day-checkin', 'next_day_checkins', 'sent_at,message_id,skip_reason'],
  ['next-day-checkin', 'agent_commands', 'state'],
  ['next-day-checkin', 'push_delivery_claims', 'status'],
  ['next-day-checkin', 'push_outbox_retirements', 'reason'],
  ['push', 'push_outbox', 'not_before'],
  ['push', 'push_devices', 'token,identity_id,platform'],
  ['push', 'room_read_marks', 'message_id'],
  ['free-agents', 'free_agents', 'state,fly_machine_id,last_activity_at,wake_requested_at,removed_at'],
  ['free-agents', 'agent_commands', 'state,claimed_at,completed_at,wake_after,startup_wake_after'],
  ['free-agents', 'agent_turns', 'status,started_at'],
  ['free-agents', 'agent_connections', 'connection_id,released_at'],
  ['free-agents', 'agents', 'squire_work'],
  ['free-agents', 'workspace_connectors', 'helper_agent_id,status'],
  ['voice-call-recovery', 'voice_calls', 'ended_at,runtime_owner,runtime_until'],
  ['corner-reviewers', 'corner_github_cache', 'lifecycle'],
  ['corner-reviewers', 'memberships', 'removed_at,role'],
  ['corner-reviewers', 'corner_facts', ''],
  ['corner-reviewers', 'agent_commands', 'state'],
  ['corner-checks-blocked', 'corner_github_cache', 'lifecycle'],
  ['corner-checks-blocked', 'agent_commands', 'state,created_at,claimed_at'],
  ['expired-command-leases', 'agent_commands', 'state,lease_expires_at,turn_owner_connection_id'],
  ['mention-notices', 'pending_mention_notices', 'due_at,notified_at'],
  ['institutional-curator', 'institutional_memory_items', 'updated_at,last_used_at,state,deleted_at'],
  ['institutional-curator', 'workspace_skills', 'updated_at'],
  ['unfinished-app-sign-ins', 'workspace_apps', 'authorised_at,composio_link_expires_at,sign_in_error,composio_account_id'],
  ['owed-mentions', 'rooms_mcp_mentions', 'created_at,cleared_at,rewakes'],
  ['owed-mentions', 'agent_commands', 'state'],
  ['mcp-member-routes', 'rooms_mcp_pending_routes', 'message_id'],
  ['media-expiry', 'objects', 'expires_at,state'],
  ['media-expiry', 'corner_brief_revisions', 'attachments'],
  ['media-expiry', 'rooms', 'archived_at'],
  ['retention:rooms_mcp_clients', 'rooms_mcp_connections', 'client_id'],
  ['retention:rooms_mcp_clients', 'rooms_mcp_tokens', 'client_id'],
  ['retention:rooms_mcp_clients', 'rooms_mcp_flows', 'client_id'],
  ['retention:rooms_mcp_clients', 'rooms_mcp_codes', 'client_id'],
] as const;

export const RETENTION_RULES = [
  ['agent_turn_traces', "created_at+interval '30 days'", 'true', 'created_at'],
  ['room_push_views', 'expires_at', 'expires_at IS NOT NULL', 'expires_at'],
  ['agent_commands', "completed_at+interval '30 days'", "state IN ('complete','cancelled') AND NOT (reason IN ('corner_objective','human_tag') AND room_id IN (SELECT id FROM rooms WHERE parent_id IS NOT NULL))", 'completed_at,state'],
  ['phone_access_tokens', 'expires_at', 'true', 'expires_at'],
  ['rooms_mcp_event_deliveries', "delivered_at+interval '7 days'", 'delivered_at IS NOT NULL', 'delivered_at'],
  ['rooms_mcp_event_subscriptions', "expires_at+interval '7 days'", 'true', 'expires_at'],
  ['rooms_mcp_flows', 'expires_at', 'true', 'expires_at'],
  ['rooms_mcp_codes', 'expires_at', 'true', 'expires_at'],
  ['rooms_mcp_handoffs', 'expires_at', 'true', 'expires_at'],
  ['rooms_mcp_tokens', 'expires_at', 'true', 'expires_at'],
  ['rooms_mcp_families', "revoked_at+interval '30 days'", 'revoked_at IS NOT NULL', 'revoked_at'],
  ['rooms_mcp_connections', "revoked_at+interval '30 days'", 'revoked_at IS NOT NULL', 'revoked_at'],
  ['rooms_mcp_audit', "created_at+interval '30 days'", 'true', 'created_at'],
  ['rooms_mcp_pending_routes', "created_at+interval '7 days'", 'true', 'created_at'],
  ['rooms_mcp_admission', "window_at+interval '1 day'", 'true', 'window_at'],
  ['rooms_mcp_clients', "created_at+interval '30 days'", "NOT preregistered AND NOT EXISTS(SELECT 1 FROM rooms_mcp_connections WHERE client_id=rooms_mcp_clients.id) AND NOT EXISTS(SELECT 1 FROM rooms_mcp_tokens WHERE client_id=rooms_mcp_clients.id) AND NOT EXISTS(SELECT 1 FROM rooms_mcp_flows WHERE client_id=rooms_mcp_clients.id) AND NOT EXISTS(SELECT 1 FROM rooms_mcp_codes WHERE client_id=rooms_mcp_clients.id)", 'created_at,preregistered'],
  ['live_outputs', "updated_at+interval '2 hours'", "kind<>'presence'", 'updated_at,kind'],
  ['github_auth_flows', "expires_at+interval '1 day'", 'true', 'expires_at'],
  ['daemon_token_exchanges', "expires_at+interval '1 day'", 'true', 'expires_at'],
  ['pending_mention_notices', "due_at+interval '30 days'", 'true', 'due_at'],
] as const;

const sources = [...BACKGROUND_SOURCES, ...RETENTION_RULES.map(([table, , , columns]) => [`retention:${table}`, table, columns] as const)];
export const BACKGROUND_DUE_SOURCE_SCHEMA = `
${committedCommandNotificationSchema()}
CREATE OR REPLACE FUNCTION beeline_background_source() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE item jsonb; prior jsonb; current_value jsonb; previous_value jsonb; family text:=TG_ARGV[0];
BEGIN
 item:=CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
 IF TG_OP='UPDATE' THEN
   IF TG_ARGV[1]='' THEN
     IF to_jsonb(NEW) IS NOT DISTINCT FROM to_jsonb(OLD) THEN RETURN NULL;END IF;
   ELSE
     SELECT jsonb_object_agg(key,value) INTO current_value FROM jsonb_each(to_jsonb(NEW)) WHERE key=ANY(string_to_array(TG_ARGV[1],','));
     SELECT jsonb_object_agg(key,value) INTO previous_value FROM jsonb_each(to_jsonb(OLD)) WHERE key=ANY(string_to_array(TG_ARGV[1],','));
     IF current_value IS NOT DISTINCT FROM previous_value THEN RETURN NULL;END IF;
   END IF;
 END IF;
 IF family='free-agents' AND TG_TABLE_NAME<>'free_agents' AND NOT EXISTS(SELECT 1 FROM free_agents WHERE agent_id=COALESCE(item->>'agent_id',item->>'helper_agent_id')) THEN RETURN NULL;END IF;
 IF family='next-day-checkin' AND TG_TABLE_NAME='agent_commands' AND NOT EXISTS(SELECT 1 FROM next_day_checkins WHERE command_id=item->>'id' AND measured_at IS NULL) THEN RETURN NULL;END IF;
 IF family='next-day-checkin' AND TG_TABLE_NAME IN ('push_delivery_claims','push_outbox_retirements') AND NOT EXISTS(SELECT 1 FROM next_day_checkins WHERE message_id=item->>'message_id' AND measured_at IS NULL) THEN RETURN NULL;END IF;
 IF family='owed-mentions' AND TG_TABLE_NAME='agent_commands' AND NOT EXISTS(SELECT 1 FROM rooms_mcp_mentions WHERE member_id=item->>'agent_id' AND message_id=item->>'source_message_id' AND cleared_at IS NULL) THEN RETURN NULL;END IF;
 IF family IN ('corner-reviewers','corner-checks-blocked') AND TG_TABLE_NAME='agent_commands' AND NOT EXISTS(SELECT 1 FROM rooms WHERE id=(item->>'room_id')::uuid AND parent_id IS NOT NULL) THEN RETURN NULL;END IF;
 IF family='expired-command-leases' AND (item->>'turn_owner_connection_id' IS NOT NULL OR item->>'action' NOT IN ('input','resume')) THEN RETURN NULL;END IF;
 IF family='retention:live_outputs' AND item->>'kind'='presence' THEN RETURN NULL;END IF;
 IF TG_OP='UPDATE' AND family='retention:live_outputs' AND (item->>'updated_at')::timestamptz>=(to_jsonb(OLD)->>'updated_at')::timestamptz THEN RETURN NULL;END IF;
 IF family='voice-call-recovery' THEN
   PERFORM beeline_notify_committed_command(json_build_object('principal','background-record','operation',family,
     'commandId',json_build_array(item->>'id',floor(extract(epoch FROM (item->>'runtime_until')::timestamptz)*1000),
       TG_OP='DELETE' OR item->>'ended_at' IS NOT NULL)::text)::text);
   RETURN NULL;
 END IF;
 PERFORM beeline_notify_committed_command(json_build_object('principal','background','operation','source','commandId',family)::text);
 RETURN NULL;
END $$;
${sources.map(([family, table, columns], index) => `
DROP TRIGGER IF EXISTS beeline_background_source_${index} ON ${table};
CREATE TRIGGER beeline_background_source_${index} AFTER INSERT OR UPDATE OR DELETE ON ${table}
 FOR EACH ROW EXECUTE FUNCTION beeline_background_source('${family}','${columns}');`).join('\n')}
`;
