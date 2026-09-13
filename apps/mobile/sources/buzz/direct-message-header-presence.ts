import type { ChatListItem } from '@beeline/buzz-client';

import { directMessagePresence } from '@/buzz/room-list-row';

/** Quiet DM-header copy, with all wording delegated to the shared presence grammar. */
export function directMessageHeaderPresence(
  item: Pick<ChatListItem, 'directMessage' | 'agentState'> | null,
  nowMs: number,
): string {
  return item ? (directMessagePresence(item, nowMs)?.label ?? '') : '';
}
