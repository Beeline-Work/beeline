import { deriveCornerState } from './corner-state.js';
import type { CornerLifecycleView } from '@beeline/api-contract/phone';

/** Same state derivation as the Corners page, batched for a Workspace deck. */
export function chatCornerCounts(
  rows: readonly {
    parent_id: string;
    archived_at: Date | null;
    lifecycle: CornerLifecycleView | null;
    latest_turn_status: string | null;
  }[],
): Map<string, { cornerCount: number; waitingCornerCount: number }> {
  const counts = new Map<string, { cornerCount: number; waitingCornerCount: number }>();
  for (const row of rows) {
    const { state } = deriveCornerState({
      archived: Boolean(row.archived_at),
      turnRunning: row.latest_turn_status === 'working',
      lifecycle: row.lifecycle ?? undefined,
    });
    if (state === 'archived') continue;
    const count = counts.get(row.parent_id) ?? { cornerCount: 0, waitingCornerCount: 0 };
    count.cornerCount += 1;
    if (state === 'waiting') count.waitingCornerCount += 1;
    counts.set(row.parent_id, count);
  }
  return counts;
}
