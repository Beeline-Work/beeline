import type { KnownMessageReference } from '@beeline/buzz-client';

export type MessageReplyDisplayTarget = {
  messageId: string;
  authorName: string;
  authorPubkey?: string;
  isAgent: boolean;
  preview: string;
};

/** A composer reply exists only after the snapshot proved its same-Room parent. */
export type MessageReplyTarget = MessageReplyDisplayTarget & {
  reference: KnownMessageReference;
};

export function replyMessageText(text: string): string {
  return text.trim();
}
