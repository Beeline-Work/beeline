import type { CornerListItem } from '@beeline/buzz-client';
import { compactRelativeTime } from '@/buzz/relative-time';
import { CHANGES_LABEL } from '@/buzz/vocabulary';

/**
 * The corners screen's archived footer.
 *
 * Closed work is not part of the Room's live read: the surface only carries
 * corners that are still open, so the footer is a door rather than a filter,
 * and the list behind it is fetched the first time someone taps. That fetch is
 * a real round trip, so the footer owns a loading state — the door has to say
 * it was heard, or a reader taps it twice and assumes it is broken.
 */
export type ArchivedCornersState =
  | { readonly status: 'idle' }
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly corners: readonly CornerListItem[] }
  | { readonly status: 'error'; readonly reason: string };

/**
 * Closure recency, newest first. The server already orders by `archived_at`,
 * and this keeps that order when the rows travel through a cache or a client
 * that answered in a different one. A corner whose closure time is unreadable
 * sorts last rather than to the top on a zero.
 */
export function archivedCornersByClosure(
  corners: readonly CornerListItem[],
): readonly CornerListItem[] {
  return [...corners].sort((a, b) => (b.closedAt ?? 0) - (a.closedAt ?? 0));
}

/**
 * The relative closure stamp on an archived row: `closed 3d ago`. Relative
 * rather than a date because the question a reader is asking of this list is
 * "how long ago did this finish", not "on which afternoon". Empty when the
 * closure time is unknown, so the row prints nothing rather than dating the
 * work from the epoch.
 */
export function cornerClosedStamp(closedAt: number | undefined, nowMs: number): string {
  const age = compactRelativeTime(closedAt, nowMs);
  if (!age) return '';
  return age === 'now' ? 'closed just now' : `closed ${age} ago`;
}

/** The footer's one line, in each of the four states it can be tapped in. */
export function archivedCornersLabel(state: ArchivedCornersState): string {
  switch (state.status) {
    case 'idle':
      return `Archived ${CHANGES_LABEL}`;
    case 'loading':
      return `Loading archived ${CHANGES_LABEL}…`;
    case 'ready':
      return state.corners.length
        ? `Archived ${CHANGES_LABEL} · ${state.corners.length}`
        : `No archived ${CHANGES_LABEL}`;
    case 'error':
      return `${state.reason}. Tap to retry`;
  }
}
