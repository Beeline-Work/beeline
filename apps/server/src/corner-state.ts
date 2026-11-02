import { cornerWaitingReportSql } from './corner-waiting-report.js';
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
export async function cornerReportWaiting(db: SqlDatabase, cornerId: string, commandKind?: string): Promise<boolean> {
  // A worker's waiting state pauses automatic work, but must still let reports reach its commander.
  if (commandKind === 'report') return false;
  return Boolean((await db.query(`SELECT 1 FROM rooms waiting_corner CROSS JOIN LATERAL (${cornerWaitingReportSql('waiting_corner')}) waiting WHERE waiting_corner.id=$1 LIMIT 1`, [cornerId])).rowCount);
}
