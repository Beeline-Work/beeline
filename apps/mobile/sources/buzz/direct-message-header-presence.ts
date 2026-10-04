import type { ChatListItem } from '@beeline/buzz-client';

import { displayModel } from '@/buzz/model-display';
import { directMessagePresence } from '@/buzz/room-list-row';

/** Quiet DM-header copy, with all wording delegated to the shared presence grammar. */
export function directMessageHeaderPresence(
  item: Pick<ChatListItem, 'directMessage' | 'agentState'> | null,
  nowMs: number,
): string {
  return item ? (directMessagePresence(item, nowMs)?.label ?? '') : '';
}

/**
 * An agent DM's header line: the same handle, model and owner the member
 * cells and tag suggestions show, then the presence word when there is one.
 */
export function directMessageAgentHeaderMeta(
  agent: { handle?: string; model?: string; ownerHandle?: string },
  presence: string,
): string {
  return [
    agent.handle ? `@${agent.handle.replace(/^@/, '')}` : undefined,
    agent.model ? displayModel(agent.model) : undefined,
    agent.ownerHandle ? `@${agent.ownerHandle.replace(/^@/, '')}` : undefined,
    presence || undefined,
  ]
    .filter(Boolean)
    .join(' · ');
}
