import type { SqlDatabase } from './database.js';

/** The server-owned entrypoint for the one corner state machine. Keeping the
 * pure transition in api-contract lets every server-side projection use the
 * exact same function without a package cycle. */
export {
  deriveCornerState,
  type CornerStateFacts,
  type DerivedCornerState,
} from '@beeline/api-contract/phone';

/** Existing grace period for commands a helper has not claimed. */
export const CORNER_CHECKS_BLOCKED_AFTER = '2 minutes';

/** An explicit worker report pauses automatic work until an answer is committed. */
export async function cornerReportWaiting(db: SqlDatabase, cornerId: string): Promise<boolean> {
  return Boolean((await db.query('SELECT 1 FROM corner_report_blockers WHERE corner_id=$1 LIMIT 1', [cornerId])).rowCount);
}

/** Automatic lifecycle wakes also stop after a rejected output episode. */
export async function cornerAutomaticWorkPaused(db: SqlDatabase, cornerId: string): Promise<boolean> {
  return Boolean((await db.query(`SELECT 1 FROM corner_report_blockers WHERE corner_id=$1
    UNION ALL SELECT 1 FROM corner_facts WHERE corner_id=$1
      AND output_authority_stalled_sequence IS NOT NULL LIMIT 1`, [cornerId])).rowCount);
}
