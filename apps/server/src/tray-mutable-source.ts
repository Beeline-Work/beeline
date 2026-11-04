import {liveControlNotificationSchema} from './postgres-live.js';
import { grantDecidedBySql } from './needs-you.js';
import { ROUTER_AUTHORITY_LOCK } from './router-authority-lock.js';
import { CHOICE_CARD_TYPE } from '@beeline/api-contract/phone';

export const TRAY_MUTABLE_TABLES = ['agents', 'workspace_apps', 'agent_grants', 'permission_authority',
  'room_choices', 'connector_offers', 'messages', 'identities', 'message_bookmarks', 'needs_you_marks'] as const;
type TrayMutableTable = typeof TRAY_MUTABLE_TABLES[number];
export type TrayMutableCause = {
  readonly sourceTable: 'tray-projection'; readonly trayReaderId: string;
  readonly trayWorkspaceId: string; readonly table: TrayMutableTable;
  readonly operation: 'INSERT' | 'UPDATE' | 'DELETE';
  readonly oldSourceId?: string; readonly newSourceId?: string;
  readonly oldMessageId?: string; readonly newMessageId?: string;
  readonly oldRoomId?: string; readonly newRoomId?: string;
  readonly oldReaderId?: string; readonly newReaderId?: string;
};
const scalar = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 128;
const optionalKeys = ['oldSourceId', 'newSourceId', 'oldMessageId', 'newMessageId',
  'oldRoomId', 'newRoomId', 'oldReaderId', 'newReaderId'] as const;
/** Exact reader causes are DB-owned dependencies, never client inventories. */
export function readTrayMutableCause(value: Record<string, unknown>): TrayMutableCause | undefined {
  if (value.sourceTable !== 'tray-projection' || !scalar(value.trayReaderId) || !scalar(value.trayWorkspaceId) ||
    !(TRAY_MUTABLE_TABLES as readonly unknown[]).includes(value.table) ||
    !['INSERT', 'UPDATE', 'DELETE'].includes(String(value.operation)) ||
    optionalKeys.some(key => value[key] !== undefined && !scalar(value[key])) ||
    Object.keys(value).some(key => !['sourceTable', 'trayReaderId', 'trayWorkspaceId', 'table', 'operation', ...optionalKeys].includes(key))) return;
  return value as TrayMutableCause;
}

// Keep the canonical grant decider predicate. Overrides describe OLD/NEW owner
// images in a BEFORE trigger without temporarily mutating a resource row.
const grantDecider = grantDecidedBySql('grant_row', 'surface.reader_id')
  .replaceAll('a.owner_id=', 'COALESCE(override_agent_owner,a.owner_id)=')
  .replaceAll('grant_agent.owner_id=', 'COALESCE(override_agent_owner,grant_agent.owner_id)=')
  .replaceAll('app.owner_identity_id=', 'COALESCE(override_app_owner,app.owner_identity_id)=');

/** Release-installed schema alongside the closed source-plan adapter.
 * Time passage/deadline scheduling and activation are separate gates.
 * BEFORE capture keeps OLD audiences alive across FK cascades. Its journal and
 * epoch writes roll back with the source. No provider/network work runs here.
 */
export const TRAY_MUTABLE_SOURCE_SCHEMA = `
${liveControlNotificationSchema()}
CREATE OR REPLACE FUNCTION beeline_tray_room_readers(room_key uuid)
RETURNS TABLE(workspace_id uuid,reader_id text) LANGUAGE sql STABLE AS $$
 SELECT DISTINCT room.workspace_id,member.identity_id FROM rooms room
 JOIN memberships member ON member.room_id=COALESCE(room.parent_id,room.id) AND member.removed_at IS NULL
 JOIN memberships workspace ON workspace.workspace_id=room.workspace_id AND workspace.room_id IS NULL
   AND workspace.identity_id=member.identity_id AND workspace.removed_at IS NULL
 WHERE room.id=room_key AND room.archived_at IS NULL
$$;

CREATE OR REPLACE FUNCTION beeline_tray_grant_readers(grant_data jsonb,
 override_agent_owner text DEFAULT NULL,override_app_owner text DEFAULT NULL)
RETURNS TABLE(workspace_id uuid,reader_id text) LANGUAGE sql STABLE AS $$
 WITH grant_row AS (SELECT * FROM jsonb_populate_record(NULL::agent_grants,grant_data))
 SELECT DISTINCT surface.workspace_id,surface.reader_id FROM grant_row
 JOIN messages message ON message.card_type='grant-request' AND message.deleted_at IS NULL
   AND EXISTS(SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(message.card->'grants')='array' THEN message.card->'grants' ELSE '[]'::jsonb END) entry
     WHERE entry->>'grantId'=grant_row.id::text)
 CROSS JOIN LATERAL beeline_tray_room_readers(message.room_id) surface
 WHERE surface.workspace_id=grant_row.workspace_id AND grant_row.status='pending'
   AND grant_row.superseded_at IS NULL AND ${grantDecider}
$$;

CREATE OR REPLACE FUNCTION beeline_tray_permission_readers(permission_data jsonb,override_owner text DEFAULT NULL,override_agent text DEFAULT NULL)
RETURNS TABLE(workspace_id uuid,reader_id text) LANGUAGE sql STABLE AS $$
 WITH permission AS (SELECT * FROM jsonb_populate_record(NULL::permission_authority,permission_data))
 SELECT DISTINCT surface.workspace_id,surface.reader_id FROM permission
 JOIN messages message ON message.room_id=permission.room_id AND message.card_type='permission'
   AND message.card->>'permissionId'=permission.permission_id AND message.card->>'status'='pending'
 CROSS JOIN LATERAL beeline_tray_room_readers(message.room_id) surface
 WHERE permission.status='pending' AND message.deleted_at IS NULL AND
 CASE WHEN message.card->>'purpose'='squire-spending' THEN EXISTS(SELECT 1 FROM agents spender
   WHERE spender.agent_id=message.card->'agent'->>'pubkey'
     AND CASE WHEN spender.agent_id=override_agent THEN override_owner ELSE spender.owner_id END=surface.reader_id)
 ELSE permission.principal_id=surface.reader_id OR EXISTS(SELECT 1 FROM memberships manager
   WHERE manager.workspace_id=surface.workspace_id AND manager.room_id IS NULL AND manager.identity_id=surface.reader_id
     AND manager.removed_at IS NULL AND manager.role IN ('owner','admin')) END
$$;

CREATE OR REPLACE FUNCTION beeline_tray_choice_readers(choice_data jsonb)
RETURNS TABLE(workspace_id uuid,reader_id text) LANGUAGE sql STABLE AS $$
 WITH choice AS (SELECT * FROM jsonb_populate_record(NULL::room_choices,choice_data))
 SELECT DISTINCT surface.workspace_id,surface.reader_id FROM choice
 JOIN messages message ON message.id=choice.message_id AND message.card_type='${CHOICE_CARD_TYPE}'
 CROSS JOIN LATERAL beeline_tray_room_readers(choice.room_id) surface
 WHERE choice.status='open' AND choice.mode='question' AND message.deleted_at IS NULL AND
 CASE jsonb_array_length(CASE WHEN jsonb_typeof(message.card->'mentionIds')='array' THEN message.card->'mentionIds' ELSE '[]'::jsonb END) WHEN 0
   THEN message.card->'requester'->>'pubkey'=surface.reader_id
   ELSE COALESCE(message.card->'mentionIds','[]'::jsonb) ? surface.reader_id END
$$;

CREATE OR REPLACE FUNCTION beeline_tray_card_readers(message_data jsonb)
RETURNS TABLE(workspace_id uuid,reader_id text) LANGUAGE sql STABLE AS $$
 WITH message AS (SELECT * FROM jsonb_populate_record(NULL::messages,message_data))
 SELECT DISTINCT surface.workspace_id,surface.reader_id FROM message
 CROSS JOIN LATERAL beeline_tray_room_readers(message.room_id) surface
 WHERE message.deleted_at IS NULL AND CASE message.card_type
 WHEN 'grant-request' THEN EXISTS(SELECT 1 FROM agent_grants grant_row
   WHERE grant_row.workspace_id=surface.workspace_id AND grant_row.status='pending' AND grant_row.superseded_at IS NULL
     AND EXISTS(SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(message.card->'grants')='array' THEN message.card->'grants' ELSE '[]'::jsonb END) entry
       WHERE entry->>'grantId'=grant_row.id::text)
     AND ${grantDecidedBySql('grant_row', 'surface.reader_id')})
 WHEN 'permission' THEN message.card->>'status'='pending' AND EXISTS(SELECT 1 FROM permission_authority permission
   WHERE permission.room_id=message.room_id AND permission.permission_id=message.card->>'permissionId' AND permission.status='pending'
     AND CASE WHEN message.card->>'purpose'='squire-spending' THEN EXISTS(SELECT 1 FROM agents spender
       WHERE spender.agent_id=message.card->'agent'->>'pubkey' AND spender.owner_id=surface.reader_id)
     ELSE permission.principal_id=surface.reader_id OR EXISTS(SELECT 1 FROM memberships manager
       WHERE manager.workspace_id=surface.workspace_id AND manager.room_id IS NULL AND manager.identity_id=surface.reader_id
         AND manager.removed_at IS NULL AND manager.role IN ('owner','admin')) END)
 WHEN '${CHOICE_CARD_TYPE}' THEN EXISTS(SELECT 1 FROM room_choices choice WHERE choice.message_id=message.id
   AND choice.room_id=message.room_id AND choice.status='open' AND choice.mode='question') AND
   CASE jsonb_array_length(CASE WHEN jsonb_typeof(message.card->'mentionIds')='array' THEN message.card->'mentionIds' ELSE '[]'::jsonb END) WHEN 0
     THEN message.card->'requester'->>'pubkey'=surface.reader_id ELSE COALESCE(message.card->'mentionIds','[]'::jsonb) ? surface.reader_id END
 WHEN 'connector-offer' THEN EXISTS(SELECT 1 FROM connector_offers offer
   WHERE offer.message_id=message.id AND offer.room_id=message.room_id AND offer.status='pending'
     AND (offer.addressee_id=surface.reader_id OR offer.connector_type<>'wallet' AND EXISTS(SELECT 1 FROM memberships manager
       WHERE manager.workspace_id=surface.workspace_id AND manager.room_id IS NULL AND manager.identity_id=surface.reader_id
         AND manager.removed_at IS NULL AND manager.role IN ('owner','admin'))))
 WHEN 'agent-sign-in' THEN message.card->>'ownerId'=surface.reader_id AND message.card->>'status' IN ('starting','pending')
 WHEN 'app-sign-in' THEN message.card->>'ownerId'=surface.reader_id AND message.card->>'status'='pending'
 WHEN 'squire-approval' THEN message.card->>'approvalId' IS NOT NULL AND message.card->>'status' IS DISTINCT FROM 'expired'
 ELSE false END
$$;

CREATE OR REPLACE FUNCTION beeline_tray_offer_readers(offer_data jsonb)
RETURNS TABLE(workspace_id uuid,reader_id text) LANGUAGE sql STABLE AS $$
 WITH offer AS (SELECT * FROM jsonb_populate_record(NULL::connector_offers,offer_data))
 SELECT DISTINCT surface.workspace_id,surface.reader_id FROM offer
 JOIN messages message ON message.id=offer.message_id
 CROSS JOIN LATERAL beeline_tray_room_readers(offer.room_id) surface
 WHERE offer.status='pending' AND message.deleted_at IS NULL AND (offer.addressee_id=surface.reader_id OR
   offer.connector_type<>'wallet' AND EXISTS(SELECT 1 FROM memberships manager
     WHERE manager.workspace_id=surface.workspace_id AND manager.room_id IS NULL AND manager.identity_id=surface.reader_id
       AND manager.removed_at IS NULL AND manager.role IN ('owner','admin')))
$$;

CREATE OR REPLACE FUNCTION beeline_tray_bookmark_source_readers(message_key text)
RETURNS TABLE(workspace_id uuid,reader_id text) LANGUAGE sql STABLE AS $$
 SELECT DISTINCT bookmark.workspace_id,bookmark.identity_id FROM message_bookmarks bookmark
 WHERE bookmark.message_id=message_key
$$;

/** Missing source dependencies only. Ordinary message/content/seen changes
 * retain their existing capture; these functions do not turn epochs into DTO
 * invalidation counters. JSON names embedded in a card remain card snapshots. */
CREATE OR REPLACE FUNCTION beeline_tray_mutable_readers(source_name text,item jsonb)
RETURNS TABLE(workspace_id uuid,reader_id text) LANGUAGE plpgsql STABLE AS $$
BEGIN
 IF item IS NULL OR item='null'::jsonb THEN RETURN; END IF;
 IF source_name='agents' THEN
   RETURN QUERY SELECT DISTINCT audience.workspace_id,audience.reader_id FROM agent_grants grant_row
     CROSS JOIN LATERAL beeline_tray_grant_readers(to_jsonb(grant_row),item->>'owner_id',NULL) audience
     WHERE grant_row.agent_id=item->>'agent_id';
   RETURN QUERY SELECT DISTINCT audience.workspace_id,audience.reader_id FROM permission_authority permission
     JOIN messages message ON message.room_id=permission.room_id AND message.card_type='permission'
       AND message.card->>'permissionId'=permission.permission_id
       AND message.card->>'purpose'='squire-spending' AND message.card->'agent'->>'pubkey'=item->>'agent_id'
     CROSS JOIN LATERAL beeline_tray_permission_readers(to_jsonb(permission),item->>'owner_id',item->>'agent_id') audience;
 ELSIF source_name='workspace_apps' THEN
   RETURN QUERY SELECT DISTINCT audience.workspace_id,audience.reader_id FROM agent_grants grant_row
     CROSS JOIN LATERAL beeline_tray_grant_readers(to_jsonb(grant_row),NULL,item->>'owner_identity_id') audience
     WHERE grant_row.app_id::text=item->>'id' AND grant_row.kind='mcp'
       AND grant_row.target LIKE 'connection-install:%';
 ELSIF source_name='agent_grants' THEN
   RETURN QUERY SELECT * FROM beeline_tray_grant_readers(item);
 ELSIF source_name='permission_authority' THEN
   RETURN QUERY SELECT * FROM beeline_tray_permission_readers(item);
 ELSIF source_name='room_choices' THEN
   RETURN QUERY SELECT * FROM beeline_tray_choice_readers(item);
 ELSIF source_name='connector_offers' THEN
   RETURN QUERY SELECT * FROM beeline_tray_offer_readers(item);
 ELSIF source_name='messages' THEN
   RETURN QUERY SELECT * FROM beeline_tray_card_readers(item);
   -- A decision in another Workspace removes an approval in the System DM.
   IF item->>'card_type'='squire-approval-decision' THEN
     RETURN QUERY SELECT DISTINCT audience.workspace_id,audience.reader_id FROM messages approval
       CROSS JOIN LATERAL beeline_tray_room_readers(approval.room_id) audience
       WHERE approval.card_type='squire-approval' AND approval.deleted_at IS NULL
         AND approval.card->>'sourceRoomId'=item->>'room_id'
         AND approval.card->>'approvalId'=item->'card'->>'approvalId';
   END IF;
 ELSIF source_name='identities' THEN
   -- Current direct-peer / mention ambiguity audiences survive identity DELETE.
   -- Do not inspect hidden_from_roster: neither canonical Tray predicate uses it.
   RETURN QUERY SELECT DISTINCT audience.workspace_id,audience.reader_id FROM memberships subject
     JOIN rooms room ON room.id=subject.room_id
     CROSS JOIN LATERAL beeline_tray_room_readers(room.id) audience
     WHERE subject.identity_id=item->>'id' AND subject.removed_at IS NULL;
   RETURN QUERY SELECT DISTINCT audience.workspace_id,audience.reader_id FROM messages message
     CROSS JOIN LATERAL beeline_tray_room_readers(message.room_id) audience
     WHERE message.author_id=item->>'id';
   RETURN QUERY SELECT DISTINCT audience.workspace_id,audience.reader_id FROM messages message
     CROSS JOIN LATERAL beeline_tray_room_readers(message.room_id) audience
     WHERE message.card_type IN ('agent-sign-in','app-sign-in') AND message.deleted_at IS NULL
       AND message.card->>'agentId'=item->>'id' AND audience.reader_id=message.card->>'ownerId';
   RETURN QUERY SELECT DISTINCT bookmark.workspace_id,bookmark.identity_id FROM message_bookmarks bookmark
     JOIN messages message ON message.id=bookmark.message_id WHERE message.author_id=item->>'id';
 ELSIF source_name IN ('message_bookmarks','needs_you_marks') THEN
   RETURN QUERY SELECT (item->>'workspace_id')::uuid,item->>'identity_id'
     WHERE item->>'workspace_id' IS NOT NULL AND item->>'identity_id' IS NOT NULL;
 END IF;
END;
$$;

CREATE OR REPLACE FUNCTION beeline_tray_mutable_capture() RETURNS trigger AS $$
DECLARE prior jsonb; item jsonb; fields text[]; authority_changed boolean:=false;
  workspace_target uuid; reader_target text; cause jsonb; notified_workspace uuid;
  previous_rights jsonb; current_rights jsonb; message_key_move boolean:=false;
BEGIN
 prior:=CASE WHEN TG_OP='INSERT' THEN NULL ELSE to_jsonb(OLD) END;
 item:=CASE WHEN TG_OP='DELETE' THEN NULL ELSE to_jsonb(NEW) END;
 IF prior IS NOT DISTINCT FROM item THEN IF TG_OP='DELETE' THEN RETURN OLD;END IF;RETURN NEW;END IF;
 CASE TG_TABLE_NAME
 WHEN 'agents' THEN fields:=ARRAY['agent_id','owner_id'];authority_changed:=true;
 WHEN 'workspace_apps' THEN fields:=ARRAY['id','owner_identity_id'];authority_changed:=true;
 WHEN 'agent_grants' THEN fields:=ARRAY['id','workspace_id','agent_id','kind','target','app_id','status','superseded_at'];authority_changed:=true;
 WHEN 'permission_authority' THEN fields:=ARRAY['room_id','permission_id','principal_id','status'];authority_changed:=true;
 WHEN 'room_choices' THEN fields:=ARRAY['id','workspace_id','room_id','message_id','mode','status','closes_at'];
   authority_changed:=TG_OP<>'UPDATE' OR EXISTS(SELECT 1 FROM unnest(ARRAY['room_id','message_id','mode','status']) field WHERE prior->field IS DISTINCT FROM item->field);
 WHEN 'connector_offers' THEN fields:=ARRAY['id','room_id','message_id','status','addressee_id','connector_type'];authority_changed:=true;
 WHEN 'messages' THEN
   message_key_move:=TG_OP='UPDATE' AND prior->>'id' IS DISTINCT FROM item->>'id';
   -- Existing message capture handles ordinary display/content changes.
   -- Only changing an approval's decider keys needs an authority fence here.
   IF TG_OP='UPDATE' AND (prior->>'card_type'=ANY(ARRAY['grant-request','permission','${CHOICE_CARD_TYPE}','connector-offer','agent-sign-in','app-sign-in','squire-approval'])
     OR item->>'card_type'=ANY(ARRAY['grant-request','permission','${CHOICE_CARD_TYPE}','connector-offer','agent-sign-in','app-sign-in','squire-approval'])) THEN
     SELECT jsonb_build_object('type',prior->>'card_type','room',prior->>'room_id',
       'agent',prior->'card'->'agent'->>'pubkey','requester',prior->'card'->'requester'->>'pubkey',
       'card',(SELECT jsonb_object_agg(key,value) FROM jsonb_each(CASE WHEN jsonb_typeof(prior->'card')='object' THEN prior->'card' ELSE '{}'::jsonb END)
         WHERE key=ANY(ARRAY['ownerId','mentionIds','purpose','permissionId','status','approvalId','sourceRoomId'])),
       'grants',(SELECT jsonb_agg(entry->'grantId') FROM jsonb_array_elements(CASE WHEN jsonb_typeof(prior->'card'->'grants')='array' THEN prior->'card'->'grants' ELSE '[]'::jsonb END) entry)) INTO previous_rights;
     SELECT jsonb_build_object('type',item->>'card_type','room',item->>'room_id',
       'agent',item->'card'->'agent'->>'pubkey','requester',item->'card'->'requester'->>'pubkey',
       'card',(SELECT jsonb_object_agg(key,value) FROM jsonb_each(CASE WHEN jsonb_typeof(item->'card')='object' THEN item->'card' ELSE '{}'::jsonb END)
         WHERE key=ANY(ARRAY['ownerId','mentionIds','purpose','permissionId','status','approvalId','sourceRoomId'])),
       'grants',(SELECT jsonb_agg(entry->'grantId') FROM jsonb_array_elements(CASE WHEN jsonb_typeof(item->'card'->'grants')='array' THEN item->'card'->'grants' ELSE '[]'::jsonb END) entry)) INTO current_rights;
     authority_changed:=previous_rights IS DISTINCT FROM current_rights;
   END IF;
   IF NOT authority_changed AND NOT message_key_move AND COALESCE(prior->>'card_type','')<>'squire-approval-decision'
     AND COALESCE(item->>'card_type','')<>'squire-approval-decision' THEN
     IF TG_OP='DELETE' THEN RETURN OLD;END IF;RETURN NEW;
   END IF;
   IF NOT authority_changed AND TG_OP='UPDATE' AND prior->>'id' IS NOT DISTINCT FROM item->>'id'
     AND prior->>'room_id' IS NOT DISTINCT FROM item->>'room_id' AND prior->>'card_type' IS NOT DISTINCT FROM item->>'card_type'
     AND prior->'card'->>'approvalId' IS NOT DISTINCT FROM item->'card'->>'approvalId' THEN RETURN NEW;END IF;
 WHEN 'identities' THEN fields:=ARRAY['id','kind','name','handle','avatar','face_id'];
 WHEN 'message_bookmarks','needs_you_marks' THEN
   -- Existing immutable-key mutations already have ordinary capture. Retain
   -- BOTH reader/message keys only when an UPDATE moves that private row.
   IF TG_OP<>'UPDATE' THEN IF TG_OP='DELETE' THEN RETURN OLD;END IF;RETURN NEW;END IF;
   fields:=ARRAY['identity_id','workspace_id','message_id','room_id'];
 ELSE RAISE EXCEPTION 'unknown tray mutable source';
 END CASE;
 IF TG_OP='UPDATE' AND TG_TABLE_NAME<>'messages' AND NOT EXISTS(
   SELECT 1 FROM unnest(fields) field WHERE prior->field IS DISTINCT FROM item->field) THEN RETURN NEW;END IF;
 -- Match final enqueue's lock; do not acquire a provider or Room-row lock.
 -- Existing source row locks may precede this trigger. This is conservative
 -- serialization, not a claim of global deadlock freedom across all writers.
 IF authority_changed THEN PERFORM pg_advisory_xact_lock(hashtextextended('${ROUTER_AUTHORITY_LOCK}',0));END IF;
 FOR workspace_target,reader_target IN SELECT audience.workspace_id,audience.reader_id FROM (
   SELECT * FROM beeline_tray_mutable_readers(TG_TABLE_NAME,prior)
   UNION SELECT * FROM beeline_tray_mutable_readers(TG_TABLE_NAME,item)
   -- Bookmarks intentionally retain a pointer after its message key moves.
   -- Capture both that unavailable OLD row and any formerly unavailable NEW
   -- pointer. A content key move is not a grant/revoke or a new read pass.
   UNION SELECT * FROM beeline_tray_bookmark_source_readers(prior->>'id') WHERE message_key_move
   UNION SELECT * FROM beeline_tray_bookmark_source_readers(item->>'id') WHERE message_key_move
 ) audience WHERE audience.workspace_id IS NOT NULL AND audience.reader_id IS NOT NULL
   ORDER BY audience.workspace_id,audience.reader_id
 LOOP
   IF authority_changed THEN
     INSERT INTO router_authority(scope) VALUES('reader:'||reader_target||':workspace:'||workspace_target||':visibility')
       ON CONFLICT(scope) DO UPDATE SET epoch=router_authority.epoch+1;
     PERFORM beeline_authority_hint(reader_target,workspace_target::text,
       'reader:'||reader_target||':workspace:'||workspace_target||':visibility');
   END IF;
   cause:=jsonb_strip_nulls(jsonb_build_object('sourceTable','tray-projection','trayReaderId',reader_target,
     'trayWorkspaceId',workspace_target,'table',TG_TABLE_NAME,'operation',TG_OP,
     'oldSourceId',COALESCE(prior->>'id',prior->>'agent_id',prior->>'permission_id'),
     'newSourceId',COALESCE(item->>'id',item->>'agent_id',item->>'permission_id'),
     'oldMessageId',CASE WHEN TG_TABLE_NAME='messages' THEN prior->>'id' ELSE prior->>'message_id' END,
     'newMessageId',CASE WHEN TG_TABLE_NAME='messages' THEN item->>'id' ELSE item->>'message_id' END,
     'oldRoomId',prior->>'room_id','newRoomId',item->>'room_id',
     'oldReaderId',prior->>'identity_id','newReaderId',item->>'identity_id'));
   PERFORM beeline_journal('workspace:'||workspace_target,cause);
   -- One bounded notification per Workspace; no unbounded reader/stream list.
   IF workspace_target IS DISTINCT FROM notified_workspace THEN
     PERFORM beeline_notify_live_control(jsonb_build_object('table','router_source','operation',TG_OP,
       'roomId','','journalStreams',jsonb_build_array('workspace:'||workspace_target))::text);
     notified_workspace:=workspace_target;
   END IF;
 END LOOP;
 IF TG_OP='DELETE' THEN RETURN OLD;END IF;RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DO $$ DECLARE source text; BEGIN
 FOREACH source IN ARRAY ARRAY[${TRAY_MUTABLE_TABLES.map(table => `'${table}'`).join(',')}] LOOP
   EXECUTE format('DROP TRIGGER IF EXISTS beeline_tray_mutable_capture ON %I',source);
   EXECUTE format('CREATE TRIGGER beeline_tray_mutable_capture BEFORE INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION beeline_tray_mutable_capture()',source);
 END LOOP;
END $$;
`;
