import { randomUUID } from 'node:crypto';
import { parseSigninFunnelEvent, type SigninAttemptObservation } from '@beeline/api-contract/signin-funnel';
import type { SqlDatabase } from './database.js';
import { captureServerError } from './sentry.js';

// Never persist arbitrary provider text: it may contain account details or URLs.
const PROVIDER_ERRORS = new Set(['access_denied', 'temporarily_unavailable', 'server_error',
  'invalid_request', 'unauthorized_client', 'unsupported_response_type', 'invalid_scope',
  'interaction_required', 'login_required', 'account_selection_required', 'consent_required',
  'org_internal', 'redirect_uri_mismatch', 'application_suspended', 'bad_verification_code',
  'incorrect_client_credentials', 'provider_error', 'invalid_oidc_proof', 'invalid_github_proof',
  'missing_provider_code', 'github_installation_unavailable', 'github_installation_required']);

/** All writes happen after auth operations and outside their transactions. */
export async function recordSigninAttempt(database: SqlDatabase, input: SigninAttemptObservation): Promise<void> {
  try {
    await database.transaction(async tx => {
      if (input.stage === 'started') {
        const parsed = parseSigninFunnelEvent(input.context);
        const context = parsed?.event === 'provider_tapped' && parsed.provider === input.provider ? parsed : null;
        const id = randomUUID();
        const created = await tx.query(`INSERT INTO signin_attempt_correlations
          (attempt_id,flow_hash,recovery_hash,expires_at) VALUES($1,$2,$3,$4)
          ON CONFLICT(flow_hash) DO NOTHING RETURNING attempt_id`,
        [id, input.flowHash, input.recoveryHash ?? null, input.expiresAt]);
        if (!created.rows.length) return;
        await tx.query(`INSERT INTO signin_attempt_events
          (attempt_id,stage,install_id,funnel_attempt_id,provider,platform,version,internal,occurred_at)
          VALUES($1,'started',$2,$3,$4,$5,$6,$7 OR COALESCE(
            (SELECT internal FROM signin_funnel_installs WHERE install_id=$2),false),$8)`,
        [id, context?.installId ?? null, context?.attemptId ?? null, input.provider,
          context?.platform ?? null, context?.version ?? null, context ? context.environment !== 'production' : false, input.at]);
        return;
      }
      const correlation = (await tx.query<{ attempt_id: string }>(
        'flowHash' in input
          ? `SELECT attempt_id FROM signin_attempt_correlations WHERE flow_hash=$1 FOR UPDATE`
          : `SELECT attempt_id FROM signin_attempt_correlations WHERE ticket_hash=$1 OR recovery_hash=$1 FOR UPDATE`,
        ['flowHash' in input ? input.flowHash : input.ticketHash],
      )).rows[0];
      if (!correlation) return;
      const id = correlation.attempt_id;
      // A late app cancellation cannot relabel an already exchanged session.
      if ((await tx.query(`SELECT 1 FROM signin_attempt_events WHERE attempt_id=$1
        AND stage IN ('ticket_exchanged','cancelled','expired','failed')`, [id])).rows.length) return;
      if (input.stage === 'ticket_issued') await tx.query(`UPDATE signin_attempt_correlations
        SET ticket_hash=$2,expires_at=$3 WHERE attempt_id=$1`, [id, input.ticketHash, input.expiresAt]);
      const error = 'errorCode' in input && input.errorCode
        ? (PROVIDER_ERRORS.has(input.errorCode) ? input.errorCode : 'provider_error') : null;
      await tx.query(`INSERT INTO signin_attempt_events
        (attempt_id,stage,install_id,funnel_attempt_id,provider,platform,version,internal,error_code,occurred_at)
        SELECT attempt_id,$2,install_id,funnel_attempt_id,provider,platform,version,internal,$3,$4
        FROM signin_attempt_events WHERE attempt_id=$1 AND stage='started'
        ON CONFLICT(attempt_id,stage) DO NOTHING`, [id, input.stage, error, input.at]);
    });
  } catch {
    // Do not attach SQL errors or input: drivers can include parameter values.
    captureServerError(new Error('Sign-in attempt log write failed'), { operation: 'signin_attempt_log', stage: input.stage });
  }
}

/** Run with existing funnel maintenance; expiry is also inferred by the documented query. */
export async function compactSigninAttempts(database: SqlDatabase): Promise<void> {
  try {
    await database.transaction(async tx => {
      // Lock in the same order as route observations before appending expiry.
      await tx.query(`SELECT attempt_id FROM signin_attempt_correlations WHERE expires_at<now() FOR UPDATE`);
      await tx.query(`INSERT INTO signin_attempt_events
        (attempt_id,stage,install_id,funnel_attempt_id,provider,platform,version,internal,occurred_at)
        SELECT s.attempt_id,'expired',s.install_id,s.funnel_attempt_id,s.provider,s.platform,s.version,s.internal,c.expires_at
        FROM signin_attempt_correlations c JOIN signin_attempt_events s USING(attempt_id)
        WHERE c.expires_at<now() AND s.stage='started' AND NOT EXISTS(
          SELECT 1 FROM signin_attempt_events e WHERE e.attempt_id=c.attempt_id
          AND (e.stage IN ('ticket_exchanged','cancelled','failed') OR (e.stage='provider_returned' AND e.error_code IS NOT NULL)))
        ON CONFLICT(attempt_id,stage) DO NOTHING`);
      await tx.query(`DELETE FROM signin_attempt_correlations WHERE expires_at<now()`);
      await tx.query(`DELETE FROM signin_attempt_events WHERE attempt_id IN (
        SELECT attempt_id FROM signin_attempt_events WHERE stage='started' AND occurred_at<now()-interval '90 days')`);
    });
  } catch {
    captureServerError(new Error('Sign-in attempt log maintenance failed'), { operation: 'signin_attempt_log' });
  }
}
