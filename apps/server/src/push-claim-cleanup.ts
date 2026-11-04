/** Shared claim retention rule for migration cleanup and the live push loop. */
export const TERMINAL_PUSH_CLAIMS_SQL = `DELETE FROM push_delivery_claims claim
  WHERE (claim.message_id,claim.device_token) IN (
    SELECT old.message_id,old.device_token FROM push_delivery_claims old
    WHERE old.status IN ('delivered','suppressed','failed','uncertain')
      AND old.completed_at<now()-interval '1 hour'
      AND NOT (old.status='delivered' AND old.read_cleared_at IS NULL
        AND old.completed_at>=now()-interval '7 days'
        AND EXISTS (SELECT 1 FROM push_devices device
          WHERE device.token=old.device_token AND device.platform IN ('ios','android')))
    ORDER BY old.completed_at LIMIT $1 FOR UPDATE SKIP LOCKED)`;

/** Expired delivery window: a crash may have sent successfully. Never call it failed. */
export const EXPIRE_PUSH_CLAIMS_SQL = `UPDATE push_delivery_claims claim
  SET status=CASE WHEN claim.status='claimed' THEN 'uncertain' ELSE 'failed' END,
    completed_at=now(),next_retry_at=NULL,
    error=CASE WHEN claim.status='claimed' THEN 'delivery outcome unknown after claim expired'
      ELSE 'retry delivery window expired' END
  WHERE (claim.message_id,claim.device_token) IN (
    SELECT old.message_id,old.device_token FROM push_delivery_claims old
    WHERE old.status IN ('claimed','retryable')
      AND old.claimed_at<now()-interval '1 hour'
      AND NOT EXISTS (SELECT 1 FROM push_outbox queue
        WHERE queue.message_id=old.message_id AND queue.device_token=old.device_token
          AND queue.expires_at>now())
    ORDER BY old.claimed_at LIMIT $1 FOR UPDATE SKIP LOCKED)`;
