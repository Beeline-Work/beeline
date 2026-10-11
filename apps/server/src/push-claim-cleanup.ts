/** Shared claim retention rule for migration cleanup and the live push loop. */
export const TERMINAL_PUSH_CLAIMS_SQL = `DELETE FROM push_delivery_claims claim
  WHERE (claim.message_id,claim.device_token) IN (
    SELECT old.message_id,old.device_token FROM push_delivery_claims old
    WHERE old.status IN ('delivered','suppressed','failed')
      AND old.completed_at<now()-interval '1 hour'
      AND NOT (old.status='delivered' AND old.read_cleared_at IS NULL
        AND old.completed_at>=now()-interval '7 days'
        AND EXISTS (SELECT 1 FROM push_devices device
          WHERE device.token=old.device_token AND device.platform IN ('ios','android')))
      AND NOT EXISTS (SELECT 1 FROM push_release_catchups catchup
        WHERE catchup.message_id=old.message_id AND catchup.device_token=old.device_token)
    ORDER BY old.completed_at LIMIT $1 FOR UPDATE SKIP LOCKED)`;
