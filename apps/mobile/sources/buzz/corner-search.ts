import type { CornerListItem } from '@beeline/buzz-client';

/**
 * The Corners page search: a corner matches on its name, the person who
 * opened it, or its agent. A blank search matches every corner.
 */
export function cornerMatchesSearch(
  item: Pick<CornerListItem, 'corner' | 'initiator' | 'agent'>,
  query: string,
): boolean {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return true;
  return [item.corner.name, item.initiator?.name, item.agent?.name].some((value) =>
    value?.toLocaleLowerCase().includes(needle),
  );
}
