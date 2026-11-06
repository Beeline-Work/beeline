import type { SqlDatabase } from './database.js';

/** A revision read with the current card chooses one transition. The losing
 * writer performs no effects. The winner's next card and DB effects commit
 * together, so nobody can observe the consumed revision without its successor. */
export async function claimWorkflowTransition(
  database: SqlDatabase,
  head: { id: string; version: number; state: string },
): Promise<boolean> {
  return Boolean((await database.query(`UPDATE messages SET version=version+1
    WHERE id=$1 AND version=$2 AND card->>'toState'=$3 RETURNING id`,
  [head.id,head.version,head.state])).rowCount);
}
