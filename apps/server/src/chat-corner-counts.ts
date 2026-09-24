import { deriveCornerState } from './corner-state.js';
import type { ChatListCorner, CornerLifecycleView } from '@beeline/api-contract/phone';

/** Same state derivation as the Corners page, batched for a Workspace deck. */
export function chatCornerCounts(
  rows: readonly {
    id: string;
    name: string;
    parent_id: string;
    archived_at: Date | null;
    lifecycle: CornerLifecycleView | null;
    latest_turn_status: string | null;
    initiator_id?: string | null;
    latest_tags_viewer?: boolean | null;
  }[],
): Map<string, { cornerCount: number; waitingCornerCount: number; openCorners: ChatListCorner[] }> {
  const counts = new Map<
    string,
    { cornerCount: number; waitingCornerCount: number; openCorners: ChatListCorner[] }
  >();
  for (const row of rows) {
    const { state } = deriveCornerState({
      archived: Boolean(row.archived_at),
      turnRunning: row.latest_turn_status === 'working',
      lifecycle: row.lifecycle ?? undefined,
    });
    if (state === 'archived') continue;
    const count = counts.get(row.parent_id) ?? {
      cornerCount: 0,
      waitingCornerCount: 0,
      openCorners: [],
    };
    count.cornerCount += 1;
    if (state === 'waiting') count.waitingCornerCount += 1;
    count.openCorners.push({
      id: row.id,
      name: row.name,
      state,
      ...(row.initiator_id ? { initiator: { pubkey: row.initiator_id } } : {}),
      // Same rule as the Corners page: parked on a person and tagging the viewer.
      ...(row.latest_tags_viewer && (state === 'waiting' || state === 'review')
        ? { awaitsViewer: true as const }
        : {}),
    });
    counts.set(row.parent_id, count);
  }
  return counts;
}
