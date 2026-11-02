import type { SqlDatabase } from './database.js';
import { askingMessageSql, cardExpiresAtSql, questionForSql } from './needs-you.js';
import { ROUTER_AUTHORITY_LOCK } from './router-projection-schema.js';
import { liveControlNotificationSchema } from './postgres-live-notifications.js';
import {TRAY_CLOCK_READINESS_SCHEMA} from './tray-clock-readiness.js';

import {TRAY_CLOCK_KINDS,type TrayClockClaim} from './tray-clock-protocol.js';
export * from './tray-clock-protocol.js';

/** Uninstalled lifecycle capture + transaction-only expiry primitives. There is
 * deliberately no runner, timer, readiness setter or background owner adapter.
 * Future tray.expire MUST enter the exact aggregate-owner fenced transaction;
 * these SQL tests alone cannot establish production job ownership. Choice due
 * records are exposed separately and cannot be consumed without its real domain
 * terminal handler. No phone read creates/repairs any of these rows. */
export const TRAY_CLOCK_SOURCE_SCHEMA = `
${liveControlNotificationSchema()}
CREATE TABLE IF NOT EXISTS tray_clock_sources (
 source_kind text NOT NULL CHECK(source_kind IN ('message','seen','choice')),
 source_id text NOT NULL CHECK(length(source_id) BETWEEN 1 AND 128),
 reader_id text NOT NULL DEFAULT '' CHECK(length(reader_id)<=128),
 incarnation text NOT NULL DEFAULT md5(random()::text||clock_timestamp()::text),
 revision bigint NOT NULL DEFAULT 1 CHECK(revision>0),
 desired jsonb NOT NULL, retired boolean NOT NULL DEFAULT false,
 PRIMARY KEY(source_kind,source_id,reader_id)
);
CREATE TABLE IF NOT EXISTS tray_clock_deadlines (
 id text PRIMARY KEY,
 source_kind text NOT NULL, source_id text NOT NULL, reader_id text NOT NULL,
 incarnation text NOT NULL, revision bigint NOT NULL CHECK(revision>0),
 kind text NOT NULL CHECK(kind IN ('question-age','question-seen','agent-sign-in','squire-approval','choice-close')),
 workspace_id uuid NOT NULL, room_id uuid NOT NULL, due_at timestamptz NOT NULL,
 state text NOT NULL CHECK(state IN ('pending','elapsed','cancelled')),
 FOREIGN KEY(source_kind,source_id,reader_id) REFERENCES tray_clock_sources(source_kind,source_id,reader_id),
 UNIQUE(source_kind,source_id,reader_id,kind)
);
CREATE INDEX IF NOT EXISTS tray_clock_pending_due_idx ON tray_clock_deadlines(due_at,id) WHERE state='pending' AND kind<>'choice-close';
CREATE INDEX IF NOT EXISTS tray_clock_choice_due_idx ON tray_clock_deadlines(due_at,id) WHERE state='pending' AND kind='choice-close';
CREATE TABLE IF NOT EXISTS tray_clock_state (
 workspace_id uuid PRIMARY KEY, generation text NOT NULL DEFAULT md5(random()::text||clock_timestamp()::text),
 revision bigint NOT NULL DEFAULT 0 CHECK(revision>=0), ready boolean NOT NULL DEFAULT false
);
${TRAY_CLOCK_READINESS_SCHEMA}

-- Read-side clock truth is committed state, never a fresh wall-clock filter.
-- Missing source evidence is an unavailable projection, not an invented empty
-- result. CASE guards in the reader invoke this only for qualifying sources.
CREATE OR REPLACE FUNCTION beeline_tray_clock_is_open(deadline_kind text,source_key text,reader_key text DEFAULT '')
RETURNS boolean LANGUAGE plpgsql STABLE AS $$
DECLARE current_state text;
BEGIN
 IF deadline_kind NOT IN ('question-age','question-seen','agent-sign-in','squire-approval')
   OR (deadline_kind='question-seen')<>(reader_key<>'') THEN RAISE EXCEPTION 'invalid Tray read clock'; END IF;
 SELECT state INTO current_state FROM tray_clock_deadlines
 WHERE source_kind=CASE WHEN deadline_kind='question-seen' THEN 'seen' ELSE 'message' END
   AND source_id=source_key AND reader_id=reader_key AND kind=deadline_kind;
 IF NOT FOUND THEN RAISE EXCEPTION 'Tray clock source incomplete' USING ERRCODE='23514'; END IF;
 RETURN current_state='pending';
END;
$$;

-- Source-derived only: callers cannot supply due times, audiences or callbacks.
CREATE OR REPLACE FUNCTION beeline_tray_clock_desired(source_name text,source_key text,reader_key text DEFAULT '')
RETURNS jsonb LANGUAGE plpgsql STABLE AS $$
DECLARE result jsonb;
BEGIN
 IF source_name='message' THEN
   SELECT COALESCE(jsonb_agg(jsonb_build_object('kind',entry.kind,'workspace',room.workspace_id,'room',m.room_id,
     'due',to_char(entry.due_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')) ORDER BY entry.kind),'[]'::jsonb)
   INTO result FROM messages m JOIN rooms room ON room.id=m.room_id
   CROSS JOIN LATERAL (
     SELECT 'question-age'::text kind,m.created_at+interval '7 days' due_at WHERE ${askingMessageSql('m')}
     UNION ALL SELECT 'agent-sign-in',to_timestamp(${cardExpiresAtSql('m.card')}/1000.0)
       WHERE m.deleted_at IS NULL AND m.card_type='agent-sign-in' AND m.card->>'status' IN ('starting','pending')
         AND m.card->>'ownerId' IS NOT NULL
         AND ${cardExpiresAtSql('m.card')} IS NOT NULL
     UNION ALL SELECT 'squire-approval',to_timestamp(${cardExpiresAtSql('m.card')}/1000.0)
       WHERE m.deleted_at IS NULL AND m.card_type='squire-approval' AND m.card->>'approvalId' IS NOT NULL
         AND m.card->>'sourceRoomId' ~ '^[0-9a-f-]{36}$'
         AND m.card->>'status' IS DISTINCT FROM 'expired' AND ${cardExpiresAtSql('m.card')} IS NOT NULL
   ) entry WHERE m.id=source_key AND room.workspace_id IS NOT NULL;
 ELSIF source_name='seen' THEN
   SELECT COALESCE(jsonb_agg(jsonb_build_object('kind','question-seen','workspace',room.workspace_id,'room',m.room_id,
     'due',to_char((mark.first_seen_at+interval '24 hours') AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))),'[]'::jsonb)
   INTO result FROM needs_you_marks mark JOIN messages m ON m.id=mark.message_id JOIN rooms room ON room.id=m.room_id
   WHERE mark.identity_id=reader_key AND mark.message_id=source_key AND mark.first_seen_at IS NOT NULL
     AND mark.cleared_at IS NULL AND room.workspace_id IS NOT NULL AND ${askingMessageSql('m')};
 ELSIF source_name='choice' THEN
   SELECT COALESCE(jsonb_agg(jsonb_build_object('kind','choice-close','workspace',room.workspace_id,'room',choice.room_id,
     'due',to_char(choice.closes_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))),'[]'::jsonb)
   INTO result FROM room_choices choice JOIN rooms room ON room.id=choice.room_id
   WHERE choice.id::text=source_key AND choice.status='open' AND choice.closes_at IS NOT NULL AND room.workspace_id IS NOT NULL;
 ELSE RAISE EXCEPTION 'unknown Tray clock source'; END IF;
 RETURN result;
END;
$$;

CREATE OR REPLACE FUNCTION beeline_tray_clock_reconcile(source_name text,source_key text,reader_key text DEFAULT '')
RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE wanted jsonb; prior tray_clock_sources%ROWTYPE; entry jsonb; current_incarnation text; current_revision bigint;
BEGIN
 IF source_name NOT IN ('message','seen','choice') OR (source_name='seen')<>(reader_key<>'') THEN RAISE EXCEPTION 'invalid Tray clock source'; END IF;
 -- Serializes concurrent first capture before a registry row exists. Not a
 -- global authority lock or provider lock; scope is this exact source key.
 PERFORM pg_advisory_xact_lock(hashtextextended('tray-clock:'||jsonb_build_array(source_name,source_key,reader_key)::text,0));
 wanted:=beeline_tray_clock_desired(source_name,source_key,reader_key);
 SELECT * INTO prior FROM tray_clock_sources WHERE source_kind=source_name AND source_id=source_key AND reader_id=reader_key FOR UPDATE;
 IF NOT FOUND AND wanted='[]'::jsonb THEN RETURN false; END IF;
 IF prior.retired AND wanted='[]'::jsonb THEN RETURN false; END IF;
 IF prior.source_id IS NOT NULL AND NOT prior.retired AND prior.desired=wanted THEN RETURN false; END IF;
 current_incarnation:=CASE WHEN prior.source_id IS NULL OR prior.retired THEN md5(random()::text||clock_timestamp()::text) ELSE prior.incarnation END;
 current_revision:=COALESCE(prior.revision,0)+1;
 INSERT INTO tray_clock_sources(source_kind,source_id,reader_id,incarnation,revision,desired)
 VALUES(source_name,source_key,reader_key,current_incarnation,current_revision,wanted)
 ON CONFLICT(source_kind,source_id,reader_id) DO UPDATE SET incarnation=EXCLUDED.incarnation,revision=EXCLUDED.revision,desired=EXCLUDED.desired,retired=false;
 UPDATE tray_clock_deadlines SET state='cancelled',incarnation=current_incarnation,revision=current_revision
 WHERE source_kind=source_name AND source_id=source_key AND reader_id=reader_key;
 FOR entry IN SELECT value FROM jsonb_array_elements(wanted) LOOP
   IF NOT EXISTS(SELECT 1 FROM tray_clock_state WHERE workspace_id=(entry->>'workspace')::uuid) THEN
     PERFORM beeline_tray_clock_lock_workspaces(ARRAY[(entry->>'workspace')::uuid]);
     INSERT INTO tray_clock_state(workspace_id) VALUES((entry->>'workspace')::uuid) ON CONFLICT DO NOTHING;
     IF FOUND THEN PERFORM beeline_tray_clock_publish_basis((entry->>'workspace')::uuid);END IF;
   END IF;
   INSERT INTO tray_clock_deadlines(id,source_kind,source_id,reader_id,incarnation,revision,kind,workspace_id,room_id,due_at,state)
   VALUES(md5(jsonb_build_array(source_name,source_key,reader_key,entry->>'kind')::text),source_name,source_key,reader_key,
     current_incarnation,current_revision,entry->>'kind',(entry->>'workspace')::uuid,(entry->>'room')::uuid,(entry->>'due')::timestamptz,
     CASE WHEN entry->>'kind'<>'choice-close' AND (entry->>'due')::timestamptz<=clock_timestamp() THEN 'elapsed' ELSE 'pending' END)
   ON CONFLICT(id) DO UPDATE SET incarnation=EXCLUDED.incarnation,revision=EXCLUDED.revision,workspace_id=EXCLUDED.workspace_id,
     room_id=EXCLUDED.room_id,due_at=EXCLUDED.due_at,state=EXCLUDED.state;
 END LOOP;
 PERFORM beeline_journal('jobs:tray-clock',jsonb_build_object('sourceTable','tray-clock-source','sourceKind',source_name,
   'sourceId',source_key,'readerId',reader_key,'incarnation',current_incarnation,'revision',current_revision::text));
 PERFORM beeline_notify_live_control(jsonb_build_object('table','tray_clock_source','operation','UPDATE','roomId','',
   'journalStreams',jsonb_build_array('jobs:tray-clock'))::text);
 -- Source mutations retain their ordinary journal capture. Already-past
 -- insert/backdate is classified inline, never painted until a later timer.
 RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION beeline_tray_clock_retire(source_name text,source_key text,reader_key text DEFAULT '')
RETURNS void LANGUAGE plpgsql AS $$
DECLARE retired_source tray_clock_sources%ROWTYPE;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('tray-clock:'||jsonb_build_array(source_name,source_key,reader_key)::text,0));
 UPDATE tray_clock_sources SET retired=true,revision=revision+1,desired='[]'::jsonb
   WHERE source_kind=source_name AND source_id=source_key AND reader_id=reader_key AND NOT retired RETURNING * INTO retired_source;
 IF NOT FOUND THEN RETURN; END IF;
 UPDATE tray_clock_deadlines SET state='cancelled' WHERE source_kind=source_name AND source_id=source_key AND reader_id=reader_key AND state<>'cancelled';
 PERFORM beeline_journal('jobs:tray-clock',jsonb_build_object('sourceTable','tray-clock-source','sourceKind',source_name,
   'sourceId',source_key,'readerId',reader_key,'incarnation',retired_source.incarnation,'revision',retired_source.revision::text));
 PERFORM beeline_notify_live_control(jsonb_build_object('table','tray_clock_source','operation','UPDATE','roomId','',
   'journalStreams',jsonb_build_array('jobs:tray-clock'))::text);
END;
$$;

CREATE OR REPLACE FUNCTION beeline_tray_clock_readers(deadline tray_clock_deadlines)
RETURNS TABLE(workspace_id uuid,reader_id text) LANGUAGE sql STABLE AS $$
 SELECT DISTINCT room.workspace_id,viewer.id FROM messages m JOIN rooms room ON room.id=m.room_id
 JOIN memberships member ON member.room_id=COALESCE(room.parent_id,room.id) AND member.removed_at IS NULL
 JOIN identities viewer ON viewer.id=member.identity_id
 JOIN memberships workspace ON workspace.workspace_id=room.workspace_id AND workspace.room_id IS NULL
   AND workspace.identity_id=viewer.id AND workspace.removed_at IS NULL
 LEFT JOIN needs_you_marks mark ON mark.message_id=m.id AND mark.identity_id=viewer.id
 WHERE m.id=deadline.source_id AND room.workspace_id=deadline.workspace_id AND room.archived_at IS NULL AND mark.cleared_at IS NULL
 AND CASE WHEN deadline.kind IN ('question-age','question-seen') THEN
   ${questionForSql('viewer.id')} AND (deadline.kind='question-age' OR viewer.id=deadline.reader_id)
   AND NOT EXISTS(SELECT 1 FROM tray_clock_deadlines earlier WHERE earlier.source_id=m.id
     AND earlier.id<>deadline.id AND earlier.state='elapsed'
     AND (earlier.kind='question-age' OR earlier.kind='question-seen' AND earlier.reader_id=viewer.id))
 WHEN deadline.kind='agent-sign-in' THEN m.deleted_at IS NULL AND m.card_type='agent-sign-in'
   AND m.card->>'ownerId'=viewer.id AND m.card->>'status' IN ('starting','pending')
 WHEN deadline.kind='squire-approval' THEN m.deleted_at IS NULL AND m.card_type='squire-approval'
   AND m.card->>'approvalId' IS NOT NULL AND m.card->>'status' IS DISTINCT FROM 'expired'
   AND m.card->>'sourceRoomId' ~ '^[0-9a-f-]{36}$'
   AND NOT EXISTS(SELECT 1 FROM messages decision
     WHERE decision.room_id=CASE WHEN m.card->>'sourceRoomId' ~ '^[0-9a-f-]{36}$' THEN (m.card->>'sourceRoomId')::uuid END
       AND decision.card_type='squire-approval-decision' AND decision.card->>'approvalId'=m.card->>'approvalId')
 ELSE false END
$$;

CREATE OR REPLACE FUNCTION beeline_tray_clock_consume(deadline_key text,expected_incarnation text,expected_revision bigint)
RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE candidate tray_clock_deadlines%ROWTYPE; audience record; emitted boolean:=false;
BEGIN
 SELECT * INTO candidate FROM tray_clock_deadlines WHERE id=deadline_key;
 IF NOT FOUND OR candidate.kind='choice-close' OR candidate.incarnation<>expected_incarnation OR candidate.revision<>expected_revision
   OR candidate.state<>'pending' THEN RETURN false; END IF;
 -- Caller must additionally hold the exact tray.expire aggregate-owner fence.
 -- Authority capture and final enqueue share this existing conservative lock.
 PERFORM pg_advisory_xact_lock_shared(hashtextextended('${ROUTER_AUTHORITY_LOCK}',0));
 PERFORM beeline_tray_clock_lock_workspaces(ARRAY[candidate.workspace_id]);
 -- Source row before registry/deadline: matches the lifecycle trigger order.
 IF candidate.source_kind='seen' THEN
   PERFORM 1 FROM needs_you_marks WHERE identity_id=candidate.reader_id AND message_id=candidate.source_id FOR SHARE NOWAIT;
 END IF;
 PERFORM 1 FROM messages WHERE id=candidate.source_id FOR SHARE NOWAIT;
 IF NOT pg_try_advisory_xact_lock(hashtextextended('tray-clock:'||jsonb_build_array(candidate.source_kind,candidate.source_id,candidate.reader_id)::text,0)) THEN
   RAISE EXCEPTION 'Tray clock source busy' USING ERRCODE='55P03';
 END IF;
 PERFORM beeline_tray_clock_reconcile(candidate.source_kind,candidate.source_id,candidate.reader_id);
 SELECT * INTO candidate FROM tray_clock_deadlines WHERE id=deadline_key FOR UPDATE;
 IF candidate.incarnation<>expected_incarnation OR candidate.revision<>expected_revision
   OR candidate.state<>'pending' OR candidate.due_at>clock_timestamp() THEN RETURN false; END IF;
 UPDATE tray_clock_deadlines SET state='elapsed' WHERE id=deadline_key;
 UPDATE tray_clock_state SET revision=revision+1 WHERE workspace_id=candidate.workspace_id;
 FOR audience IN SELECT * FROM beeline_tray_clock_readers(candidate) ORDER BY workspace_id,reader_id LOOP
   PERFORM beeline_journal('workspace:'||audience.workspace_id,jsonb_build_object('sourceTable','tray-clock',
     'trayReaderId',audience.reader_id,'trayWorkspaceId',audience.workspace_id,'kind',candidate.kind,
     'deadlineId',candidate.id,'incarnation',candidate.incarnation,'revision',candidate.revision::text));
   emitted:=true;
 END LOOP;
 IF emitted THEN
   PERFORM beeline_notify_live_control(jsonb_build_object('table','router_source','operation','UPDATE','roomId','',
     'journalStreams',jsonb_build_array('workspace:'||candidate.workspace_id))::text);
 END IF;
 IF NOT emitted THEN PERFORM beeline_tray_clock_publish_basis(candidate.workspace_id);END IF;
 RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION beeline_tray_clock_capture() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE person text;
BEGIN
 IF TG_WHEN='BEFORE' THEN
   IF TG_TABLE_NAME='messages' THEN
     IF TG_OP='DELETE' OR OLD.id IS DISTINCT FROM NEW.id THEN
       PERFORM beeline_tray_clock_retire('message',OLD.id);
       FOR person IN SELECT identity_id FROM needs_you_marks WHERE message_id=OLD.id LOOP
         PERFORM beeline_tray_clock_retire('seen',OLD.id,person);
       END LOOP;
     END IF;
   ELSIF TG_TABLE_NAME='needs_you_marks' THEN
     IF TG_OP='DELETE' OR ROW(OLD.identity_id,OLD.message_id) IS DISTINCT FROM ROW(NEW.identity_id,NEW.message_id) THEN
       PERFORM beeline_tray_clock_retire('seen',OLD.message_id,OLD.identity_id);
     END IF;
   ELSIF TG_TABLE_NAME='room_choices' THEN
     IF TG_OP='DELETE' OR OLD.id IS DISTINCT FROM NEW.id THEN
       PERFORM beeline_tray_clock_retire('choice',OLD.id::text);
     END IF;
   END IF;
   IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
 END IF;
 IF TG_TABLE_NAME='messages' THEN
     PERFORM beeline_tray_clock_reconcile('message',NEW.id);
     FOR person IN SELECT identity_id FROM needs_you_marks WHERE message_id=NEW.id AND first_seen_at IS NOT NULL LOOP
       PERFORM beeline_tray_clock_reconcile('seen',NEW.id,person);
     END LOOP;
 ELSIF TG_TABLE_NAME='needs_you_marks' THEN
   PERFORM beeline_tray_clock_reconcile('seen',NEW.message_id,NEW.identity_id);
 ELSIF TG_TABLE_NAME='room_choices' THEN
   PERFORM beeline_tray_clock_reconcile('choice',NEW.id::text);
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
END;
$$;

-- Separate BEFORE retirement and AFTER reconciliation preserve lifecycle ABA
-- across deletion/key moves. These declarations are exported, NOT installed.
DROP TRIGGER IF EXISTS beeline_tray_clock_message_retire ON messages;
CREATE TRIGGER beeline_tray_clock_message_retire BEFORE DELETE OR UPDATE OF id ON messages
 FOR EACH ROW WHEN (OLD.id IS NOT NULL) EXECUTE FUNCTION beeline_tray_clock_capture();
DROP TRIGGER IF EXISTS beeline_tray_clock_message_insert ON messages;
CREATE TRIGGER beeline_tray_clock_message_insert AFTER INSERT ON messages FOR EACH ROW EXECUTE FUNCTION beeline_tray_clock_capture();
DROP TRIGGER IF EXISTS beeline_tray_clock_message_change ON messages;
CREATE TRIGGER beeline_tray_clock_message_change AFTER UPDATE ON messages FOR EACH ROW
 WHEN (ROW(OLD.id,OLD.room_id,OLD.created_at,OLD.presentation,OLD.deleted_at,${askingMessageSql('OLD')},OLD.card_type,OLD.card->'expiresAt',OLD.card->'status',OLD.card->'approvalId',OLD.card->'ownerId',OLD.card->'sourceRoomId')
 IS DISTINCT FROM ROW(NEW.id,NEW.room_id,NEW.created_at,NEW.presentation,NEW.deleted_at,${askingMessageSql('NEW')},NEW.card_type,NEW.card->'expiresAt',NEW.card->'status',NEW.card->'approvalId',NEW.card->'ownerId',NEW.card->'sourceRoomId'))
 EXECUTE FUNCTION beeline_tray_clock_capture();
DROP TRIGGER IF EXISTS beeline_tray_clock_seen_retire ON needs_you_marks;
CREATE TRIGGER beeline_tray_clock_seen_retire BEFORE DELETE OR UPDATE OF identity_id,message_id ON needs_you_marks
 FOR EACH ROW EXECUTE FUNCTION beeline_tray_clock_capture();
DROP TRIGGER IF EXISTS beeline_tray_clock_seen_insert ON needs_you_marks;
CREATE TRIGGER beeline_tray_clock_seen_insert AFTER INSERT ON needs_you_marks FOR EACH ROW EXECUTE FUNCTION beeline_tray_clock_capture();
DROP TRIGGER IF EXISTS beeline_tray_clock_seen_change ON needs_you_marks;
CREATE TRIGGER beeline_tray_clock_seen_change AFTER UPDATE ON needs_you_marks FOR EACH ROW
 WHEN (ROW(OLD.identity_id,OLD.message_id,OLD.workspace_id,OLD.first_seen_at,OLD.cleared_at)
 IS DISTINCT FROM ROW(NEW.identity_id,NEW.message_id,NEW.workspace_id,NEW.first_seen_at,NEW.cleared_at))
 EXECUTE FUNCTION beeline_tray_clock_capture();
DROP TRIGGER IF EXISTS beeline_tray_clock_choice_retire ON room_choices;
CREATE TRIGGER beeline_tray_clock_choice_retire BEFORE DELETE OR UPDATE OF id ON room_choices FOR EACH ROW EXECUTE FUNCTION beeline_tray_clock_capture();
DROP TRIGGER IF EXISTS beeline_tray_clock_choice_insert ON room_choices;
CREATE TRIGGER beeline_tray_clock_choice_insert AFTER INSERT ON room_choices FOR EACH ROW EXECUTE FUNCTION beeline_tray_clock_capture();
DROP TRIGGER IF EXISTS beeline_tray_clock_choice_change ON room_choices;
CREATE TRIGGER beeline_tray_clock_choice_change AFTER UPDATE ON room_choices FOR EACH ROW
 WHEN (ROW(OLD.id,OLD.room_id,OLD.status,OLD.closes_at) IS DISTINCT FROM ROW(NEW.id,NEW.room_id,NEW.status,NEW.closes_at))
 EXECUTE FUNCTION beeline_tray_clock_capture();

-- Moving a Room may affect arbitrarily many old messages/marks/choices. The
-- foreground mutation invalidates only its two exact Workspace generations;
-- actual bounded lifecycle reconciliation owns completion and ready=true.
CREATE OR REPLACE FUNCTION beeline_tray_clock_room_move() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM beeline_tray_clock_require_readiness(ARRAY[OLD.workspace_id,NEW.workspace_id]);RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS beeline_tray_clock_room_move ON rooms;
CREATE TRIGGER beeline_tray_clock_room_move BEFORE UPDATE OF id,workspace_id ON rooms FOR EACH ROW
 WHEN(ROW(OLD.id,OLD.workspace_id) IS DISTINCT FROM ROW(NEW.id,NEW.workspace_id)) EXECUTE FUNCTION beeline_tray_clock_room_move();
`;

/** SQL primitives for a future private adapter, never a production scheduler.
 * The caller's transaction must own source/aggregate authority. No callback,
 * caller-supplied due time, custom audience, or arbitrary job ID is accepted. */
export async function readTrayClockDue(db: SqlDatabase, choices = false): Promise<readonly TrayClockClaim[]> {
  return (await db.query<TrayClockClaim>(`SELECT id,incarnation,revision::text,kind,
    to_char(due_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "dueAt"
    FROM tray_clock_deadlines WHERE state='pending' AND ${choices ? "kind='choice-close'" : "kind<>'choice-close'"}
      AND due_at<=clock_timestamp() ORDER BY due_at,id LIMIT 100`)).rows;
}
/** One indexed minimum; the future owner arms this exact record/version only. */
export async function readTrayClockNext(db: SqlDatabase) {
  return (await db.query<TrayClockClaim & { remainingMs: number }>(`SELECT id,incarnation,revision::text,kind,
    to_char(due_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "dueAt",
    EXTRACT(epoch FROM (due_at-clock_timestamp()))::double precision*1000 AS "remainingMs"
    FROM tray_clock_deadlines WHERE state='pending' AND kind<>'choice-close' ORDER BY due_at,id LIMIT 1`)).rows[0];
}
export async function consumeTrayClockInTransaction(db: SqlDatabase, claim: TrayClockClaim): Promise<boolean> {
  if (!claim || !/^[a-f0-9]{32}$/.test(claim.id) || !/^[a-f0-9]{32}$/.test(claim.incarnation) || !(typeof claim.revision==='string'&&/^[1-9][0-9]{0,19}$/.test(claim.revision)) ||
    !(TRAY_CLOCK_KINDS as readonly unknown[]).includes(claim.kind)) throw new Error('Invalid Tray clock claim');
  return (await db.query<{ consumed: boolean }>('SELECT beeline_tray_clock_consume($1,$2,$3::bigint) consumed',
    [claim.id,claim.incarnation,claim.revision])).rows[0]!.consumed;
}
export {readTrayClockBasis} from './tray-clock-basis.js';
