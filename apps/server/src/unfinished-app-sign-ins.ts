import type { SqlDatabase } from './database.js';

/** Only abandoned managed sign-ins; successful routes and vault keys are untouched. */
const UNFINISHED_APP_SIGN_IN = `a.transport='composio' AND a.authorised_at IS NULL
  AND (a.composio_link_expires_at<=now() OR a.sign_in_error IS NOT NULL
    OR (a.composio_account_id IS NULL AND a.created_at<now()-interval '10 minutes'))
  AND NOT EXISTS(SELECT 1 FROM workspace_app_usage u WHERE u.app_id=a.id)
  AND NOT EXISTS(SELECT 1 FROM messages m WHERE m.card_type='app-sign-in'
    AND m.card->>'appId'=a.id::text AND m.card->>'status'='connected')`;

export async function cleanupUnfinishedAppSignIns(database: SqlDatabase, apply = false): Promise<number> {
  if (!apply) return Number((await database.query<{ count: string }>(
    `SELECT count(*) FROM workspace_apps a WHERE ${UNFINISHED_APP_SIGN_IN}`,
  )).rows[0]!.count);
  return database.transaction(async db => {
    const rows = (await db.query<{ id: string; sign_in_error: string | null }>(
      `SELECT a.id,a.sign_in_error FROM workspace_apps a WHERE ${UNFINISHED_APP_SIGN_IN}
       ORDER BY a.created_at LIMIT 1000 FOR UPDATE OF a SKIP LOCKED`,
    )).rows;
    for (const row of rows) {
      await db.query(`UPDATE messages SET card=jsonb_set(jsonb_set(card,'{status}','"failed"'::jsonb),
        '{errorMessage}',to_jsonb($2::text)) WHERE card_type='app-sign-in'
        AND card->>'appId'=$1 AND card->>'status'='pending'`,
      [row.id, row.sign_in_error ?? 'App sign-in timed out. Ask to sign in again.']);
      await db.query(`DELETE FROM workspace_apps WHERE id=$1 AND authorised_at IS NULL`, [row.id]);
    }
    return rows.length;
  });
}
