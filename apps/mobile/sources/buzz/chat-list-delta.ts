import type { ChatListView } from '@beeline/buzz-client';

/** Stable filter identity for the existing desktop notification watch.
 * Room list observation and reduction live exclusively in the router.
 */
export function chatWatchFiltersKey(filters: ChatListView['watchFilters']): string {
  return JSON.stringify(
    filters
      .map((filter) =>
        JSON.stringify(
          Object.entries(filter)
            .map(([key, values]) => [key, [...(values as readonly (string | number)[])].sort()])
            .sort(([left], [right]) => String(left).localeCompare(String(right))),
        ),
      )
      .sort(),
  );
}
