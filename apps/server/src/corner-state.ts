import { cornerWaitingReportSql } from './corner-waiting-report.js';
import type { SqlDatabase } from './database.js';

/** Compatibility entrypoint: every server projection uses the corner machine. */
export { deriveCornerState } from './corner-lifecycle.js';
export type { CornerStateFacts, DerivedCornerState } from '@beeline/api-contract/phone';

/** An explicit worker report pauses automatic work until an answer is committed. */
export async function cornerReportWaiting(db: SqlDatabase, cornerId: string, commandKind?: string): Promise<boolean> {
  // A worker's waiting state pauses automatic work, but must still let reports reach its commander.
  if (commandKind === 'report') return false;
  return Boolean((await db.query(`SELECT 1 FROM rooms waiting_corner CROSS JOIN LATERAL (${cornerWaitingReportSql('waiting_corner')}) waiting WHERE waiting_corner.id=$1 LIMIT 1`, [cornerId])).rowCount);
}
