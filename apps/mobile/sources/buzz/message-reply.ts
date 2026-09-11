import type { KnownMessageReference } from '@beeline/buzz-client';

export type MessageReplyDisplayTarget = {
  messageId: string;
  authorName: string;
  authorHandle?: string;
  authorPubkey?: string;
  isAgent: boolean;
  preview: string;
};

/** A composer reply exists only after the snapshot proved its same-Room parent. */
export type MessageReplyTarget = MessageReplyDisplayTarget & {
  reference: KnownMessageReference;
};

export function replyMessageText(text: string, agentHandle?: string): string {
  const body = text.trim();
  return agentHandle ? `@${agentHandle} ${body}` : body;
}
