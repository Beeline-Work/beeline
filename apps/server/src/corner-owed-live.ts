/** Owed facts have no write of their own. Notify their open corner dependencies
 * from the source transaction, including reports answered in another Room. */
export const CORNER_OWED_LIVE_SCHEMA = `
CREATE OR REPLACE FUNCTION corner_owed_source_corners(p_room uuid, include_children boolean) RETURNS SETOF uuid
LANGUAGE sql STABLE AS $sources$
  SELECT id FROM rooms WHERE id=p_room AND parent_id IS NOT NULL AND archived_at IS NULL
  UNION
  SELECT id FROM rooms WHERE include_children AND parent_id=p_room AND archived_at IS NULL
  UNION
  SELECT corner.id FROM (
    SELECT p_room id UNION ALL SELECT id FROM rooms WHERE include_children AND parent_id=p_room
  ) source JOIN messages item ON item.room_id=source.id
  LEFT JOIN agent_commands report ON report.id=item.request_id AND report.agent_id=item.author_id
  JOIN rooms corner ON corner.id=CASE
    WHEN item.card->>'sourceRoomId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      THEN (item.card->>'sourceRoomId')::uuid
    WHEN item.presentation='message' AND item.text ~ '^(blocked|needs-decision|failed):[[:space:]]*[^[:space:]]'
      THEN CASE WHEN report.private_payload->>'originCornerId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        THEN (report.private_payload->>'originCornerId')::uuid ELSE report.room_id END END
    AND corner.parent_id IS NOT NULL AND corner.archived_at IS NULL
  WHERE item.deleted_at IS NULL
    AND (item.card->>'sourceRoomId' IS NOT NULL OR
      (item.presentation='message' AND item.text ~ '^(blocked|needs-decision|failed):[[:space:]]*[^[:space:]]'))
$sources$;

CREATE OR REPLACE FUNCTION corner_owed_notify(p_corner uuid) RETURNS void
LANGUAGE plpgsql AS $notify$
DECLARE parent uuid; workspace uuid;
BEGIN
  SELECT parent_id,workspace_id INTO parent,workspace FROM rooms
    WHERE id=p_corner AND parent_id IS NOT NULL AND archived_at IS NULL;
  IF parent IS NULL THEN RETURN; END IF;
  -- Journal in the same workspace / corner / parent lock order as ordinary live writes.
  PERFORM beeline_journal('workspace:' || workspace,jsonb_build_object(
    'type','invalidate','roomId','','reason','workspace-replay','sourceRoomId',p_corner));
  PERFORM beeline_journal('room:' || p_corner,jsonb_build_object(
    'type','invalidate','roomId',p_corner,'reason','postgres:corner_state'));
  PERFORM beeline_journal('room:' || parent,jsonb_build_object(
    'type','invalidate','roomId',parent,'reason','corner-status'));
  PERFORM pg_notify('beeline_live_v1',jsonb_build_object(
    'table','corner_state','operation','UPDATE','roomId',p_corner,'cornerParentId',parent,
    'owedChanged',true,'journalStreams',ARRAY['workspace:' || workspace,'room:' || p_corner,'room:' || parent])::text);
END $notify$;

CREATE OR REPLACE FUNCTION corner_owed_input_changed() RETURNS trigger
LANGUAGE plpgsql AS $input$
DECLARE source uuid; item jsonb; scopes uuid[] := ARRAY[]::uuid[];
BEGIN
  IF TG_TABLE_NAME='messages' THEN
    IF COALESCE(NEW.presentation,'activity') NOT IN ('message','card','system')
      AND COALESCE(OLD.presentation,'activity') NOT IN ('message','card','system') THEN RETURN NULL; END IF;
  END IF;
  IF TG_TABLE_NAME='identities' THEN
    SELECT array_agg(room_id) INTO scopes FROM memberships
      WHERE identity_id=NEW.id AND removed_at IS NULL AND room_id IS NOT NULL;
  ELSIF TG_TABLE_NAME IN ('agent_grants','permission_authority') THEN
    -- Grant cards can be forwarded to a private Room. Probe the partial
    -- grant-card GIN index, rather than assuming the card lives in the grant Room.
    IF TG_TABLE_NAME='agent_grants' THEN
      SELECT array_agg(DISTINCT room_id) INTO scopes FROM messages
        WHERE card_type='grant-request' AND card->'grants' @> jsonb_build_array(jsonb_build_object('grantId',NEW.id::text));
    ELSE
      SELECT array_agg(DISTINCT room_id) INTO scopes FROM messages
        WHERE card_type='permission' AND card->>'permissionId'=NEW.permission_id;
    END IF;
  ELSIF TG_TABLE_NAME='corner_facts' THEN
    scopes := ARRAY[NEW.corner_id];
  ELSE
    IF TG_OP<>'INSERT' THEN scopes := array_append(scopes,OLD.room_id); END IF;
    IF TG_OP<>'DELETE' THEN scopes := array_append(scopes,NEW.room_id); END IF;
    IF TG_TABLE_NAME='memberships' THEN
      -- Legacy corner memberships do not change inherited access.
      SELECT array_agg(id) INTO scopes FROM rooms WHERE id=ANY(scopes) AND parent_id IS NULL;
    ELSIF TG_TABLE_NAME='messages' THEN
      -- The old report/card can have been moved, deleted or retargeted.
      -- Include its origin even when it is no longer discoverable in history.
      FOR item IN SELECT value FROM jsonb_array_elements(jsonb_build_array(to_jsonb(OLD),to_jsonb(NEW))) value LOOP
        IF item->'card'->>'sourceRoomId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
          scopes := array_append(scopes,(item->'card'->>'sourceRoomId')::uuid);
        END IF;
        SELECT CASE WHEN report.private_payload->>'originCornerId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          THEN (report.private_payload->>'originCornerId')::uuid ELSE report.room_id END INTO source
          FROM agent_commands report WHERE report.id=item->>'request_id' AND report.agent_id=item->>'author_id';
        IF source IS NOT NULL THEN scopes := array_append(scopes,source); END IF;
      END LOOP;
    END IF;
  END IF;
  FOR source IN SELECT DISTINCT corner FROM unnest(scopes) scope
    CROSS JOIN LATERAL corner_owed_source_corners(scope,TG_TABLE_NAME IN ('memberships','identities')) corner ORDER BY corner LOOP
    PERFORM corner_owed_notify(source);
  END LOOP;
  RETURN NULL;
END $input$;
DROP TRIGGER IF EXISTS corner_owed_input_message ON messages;
CREATE TRIGGER corner_owed_input_message AFTER INSERT OR DELETE OR UPDATE OF
  room_id,request_id,text,card,card_type,presentation,reply_to_message_id,attachments,author_id,created_at,deleted_at ON messages
  FOR EACH ROW EXECUTE FUNCTION corner_owed_input_changed();
DROP TRIGGER IF EXISTS corner_owed_input_member ON memberships;
CREATE TRIGGER corner_owed_input_member AFTER INSERT OR DELETE OR UPDATE OF room_id,identity_id,removed_at ON memberships
  FOR EACH ROW EXECUTE FUNCTION corner_owed_input_changed();
DROP TRIGGER IF EXISTS corner_owed_input_identity ON identities;
CREATE TRIGGER corner_owed_input_identity AFTER UPDATE OF handle,kind ON identities
  FOR EACH ROW WHEN ((OLD.handle,OLD.kind) IS DISTINCT FROM (NEW.handle,NEW.kind))
  EXECUTE FUNCTION corner_owed_input_changed();
DROP TRIGGER IF EXISTS corner_owed_input_grant ON agent_grants;
CREATE TRIGGER corner_owed_input_grant AFTER UPDATE OF status,superseded_at ON agent_grants
  FOR EACH ROW WHEN ((OLD.status,OLD.superseded_at) IS DISTINCT FROM (NEW.status,NEW.superseded_at))
  EXECUTE FUNCTION corner_owed_input_changed();
DROP TRIGGER IF EXISTS corner_owed_input_permission ON permission_authority;
CREATE TRIGGER corner_owed_input_permission AFTER UPDATE OF status ON permission_authority
  FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status) EXECUTE FUNCTION corner_owed_input_changed();
DROP TRIGGER IF EXISTS corner_owed_input_facts ON corner_facts;
CREATE TRIGGER corner_owed_input_facts AFTER INSERT OR UPDATE OF commissioned_by,owner_agent_id ON corner_facts
  FOR EACH ROW EXECUTE FUNCTION corner_owed_input_changed();
`;
