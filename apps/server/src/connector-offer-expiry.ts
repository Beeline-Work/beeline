import type { SqlDatabase } from './database.js';
import { failConnectingOffers } from './connector-offer-completion.js';
import { committedCommandNotificationSchema } from './postgres-live-notifications.js';

export const CONNECTOR_OFFER_DUE_KEY = { principal: 'connector-offer', operation: 'expiry', commandId: 'pending' } as const;
export const CONNECTOR_OFFER_EXPIRY_SCHEMA = `
${committedCommandNotificationSchema()}
CREATE INDEX IF NOT EXISTS connector_offers_due_idx
 ON connector_offers((COALESCE(accepted_at,created_at)),id) WHERE status='connecting';
CREATE OR REPLACE FUNCTION beeline_connector_offer_due_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF COALESCE(NEW.status,'')<>'connecting' AND COALESCE(OLD.status,'')<>'connecting' THEN RETURN NULL;END IF;
 IF TG_OP='UPDATE' AND ROW(NEW.status,COALESCE(NEW.accepted_at,NEW.created_at))
   IS NOT DISTINCT FROM ROW(OLD.status,COALESCE(OLD.accepted_at,OLD.created_at)) THEN RETURN NULL;END IF;
 PERFORM beeline_notify_committed_command('${JSON.stringify(CONNECTOR_OFFER_DUE_KEY)}');
 RETURN NULL;
END;
$$;
DROP TRIGGER IF EXISTS beeline_connector_offer_due ON connector_offers;
CREATE TRIGGER beeline_connector_offer_due AFTER INSERT OR UPDATE OR DELETE ON connector_offers
 FOR EACH ROW EXECUTE FUNCTION beeline_connector_offer_due_change();
`;

export class ConnectorOfferExpiryLoop {
  constructor(private readonly database: SqlDatabase) {}
  async runOnce(): Promise<number | undefined> {
    await this.database.transaction(db => failConnectingOffers(db, { expired: true }));
    const next = (await this.database.query<{ delay_ms: number }>(
      `SELECT greatest(0,ceil(extract(epoch FROM (
         COALESCE(accepted_at,created_at)+interval '15 minutes'-clock_timestamp()
       ))*1000))::float8 delay_ms FROM connector_offers WHERE status='connecting'
       ORDER BY COALESCE(accepted_at,created_at),id LIMIT 1`,
    )).rows[0]?.delay_ms;
    return next;
  }
}
