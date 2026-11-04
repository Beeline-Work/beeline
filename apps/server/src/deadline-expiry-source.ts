import { askingMessageSql, cardExpiresAtSql, EXPIRING_CARD_TYPES } from './needs-you.js';
import { committedCommandNotificationSchema } from './postgres-live.js';

/** Legacy display compatibility: only changed stored deadline inputs admit work. */
export const DISPLAY_DEADLINE_KEY = { principal: 'display', operation: 'expiry', commandId: 'stored' } as const;
export const DISPLAY_DEADLINE_SOURCE_SCHEMA = `
${committedCommandNotificationSchema()}
CREATE OR REPLACE FUNCTION beeline_display_deadline_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE previous_due boolean; current_due boolean;
BEGIN
 CASE TG_TABLE_NAME
 WHEN 'needs_you_marks' THEN
   IF TG_OP='UPDATE' AND ROW(NEW.first_seen_at,NEW.cleared_at)
     IS NOT DISTINCT FROM ROW(OLD.first_seen_at,OLD.cleared_at) THEN RETURN NULL;END IF;
 WHEN 'corner_owed' THEN
   IF COALESCE(NEW.expires_at,OLD.expires_at) IS NULL THEN RETURN NULL;END IF;
   IF TG_OP='UPDATE' AND NEW.expires_at IS NOT DISTINCT FROM OLD.expires_at THEN RETURN NULL;END IF;
 WHEN 'messages' THEN
   previous_due := (${askingMessageSql('OLD')}) OR
     (OLD.${EXPIRING_CARD_TYPES} AND OLD.deleted_at IS NULL AND ${cardExpiresAtSql('OLD.card')} IS NOT NULL);
   current_due := (${askingMessageSql('NEW')}) OR
     (NEW.${EXPIRING_CARD_TYPES} AND NEW.deleted_at IS NULL AND ${cardExpiresAtSql('NEW.card')} IS NOT NULL);
   IF NOT (COALESCE(previous_due,false) OR COALESCE(current_due,false)) THEN RETURN NULL;END IF;
   IF TG_OP='UPDATE' AND ROW((${askingMessageSql('OLD')}),OLD.created_at,
       CASE WHEN OLD.${EXPIRING_CARD_TYPES} AND OLD.deleted_at IS NULL THEN ${cardExpiresAtSql('OLD.card')} END)
     IS NOT DISTINCT FROM ROW((${askingMessageSql('NEW')}),NEW.created_at,
       CASE WHEN NEW.${EXPIRING_CARD_TYPES} AND NEW.deleted_at IS NULL THEN ${cardExpiresAtSql('NEW.card')} END) THEN RETURN NULL;END IF;
 END CASE;
 PERFORM beeline_notify_committed_command('${JSON.stringify(DISPLAY_DEADLINE_KEY)}');
 RETURN NULL;
END;
$$;
DO $$ DECLARE source text; BEGIN
 FOREACH source IN ARRAY ARRAY['needs_you_marks','corner_owed','messages'] LOOP
   EXECUTE format('DROP TRIGGER IF EXISTS beeline_display_deadline ON %I',source);
   EXECUTE format('CREATE TRIGGER beeline_display_deadline AFTER INSERT OR UPDATE OR DELETE ON %I
     FOR EACH ROW EXECUTE FUNCTION beeline_display_deadline_change()',source);
 END LOOP;
END $$;
`;
