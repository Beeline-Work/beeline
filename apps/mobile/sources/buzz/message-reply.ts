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

/** Agent replies are ordinary messages with the original Agent explicitly addressed first. */
export function replyMessageText(text: string, target: MessageReplyDisplayTarget): string {
  const trimmed = text.trim();
  if (!target.isAgent) return trimmed;

  const prefix = `@${target.authorName}`;
  const normalized = trimmed.toLocaleLowerCase();
  const normalizedPrefix = prefix.toLocaleLowerCase();
  const trailing = trimmed[prefix.length];
  if (
    normalized.startsWith(normalizedPrefix) &&
    (trailing === undefined || /[\s,.:;!?)}\]]/.test(trailing))
  ) {
    return trimmed;
  }
  return trimmed ? `${prefix} ${trimmed}` : prefix;
}
