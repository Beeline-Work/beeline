export type ChatReplyTarget = {
  id: string;
  authorLabel: string;
  text: string;
  agentPubkey?: string;
  agentHandle?: string;
};

export type ChatReplySubmission = {
  text: string;
  replyToEventId: string;
  mentionedAgentPubkey?: string;
};

/**
 * Preserve the visible @Agent convention while also returning the pubkey that
 * must be written to the message p-tag. The p-tag is the authoritative signal
 * Body uses to address an Agent; the text prefix keeps that intent legible to
 * everyone in the Room.
 */
export function prepareChatReply(text: string, target: ChatReplyTarget): ChatReplySubmission {
  const trimmed = text.trim();
  const agentPrefix = target.agentHandle ? `@${target.agentHandle}` : undefined;
  const alreadyPrefixed = agentPrefix
    ? trimmed.toLocaleLowerCase().startsWith(agentPrefix.toLocaleLowerCase()) &&
      (trimmed.length === agentPrefix.length ||
        /[\s,.:;!?)}\]]/.test(trimmed[agentPrefix.length] ?? ''))
    : false;

  return {
    text: agentPrefix && !alreadyPrefixed ? `${agentPrefix} ${trimmed}`.trim() : trimmed,
    replyToEventId: target.id,
    ...(target.agentPubkey ? { mentionedAgentPubkey: target.agentPubkey } : {}),
  };
}

export function chatReplyPreview(text: string, hasAttachments = false): string {
  const compact = text.replace(/\s+/g, ' ').trim();
  if (compact) return compact;
  return hasAttachments ? 'Attachment' : 'Message';
}
