export type ChatReplyTarget = {
  messageId: string;
  authorName: string;
  authorHandle?: string;
  excerpt: string;
  agentPubkey?: string;
};

export type PreparedChatReply = {
  text: string;
  /** When present, the transport must add the Agent's signed p-tag. */
  agentPubkey?: string;
};

const MENTION_BOUNDARY = /[\s,.:;!?)}\]]/;

/**
 * Turn a selected reply into the ordinary Room message shape understood by
 * people and Body. The visible @handle provides context for every reply; an
 * Agent target additionally survives as a pubkey so submission can carry the
 * authoritative p-tag that wakes exactly that Agent.
 */
export function prepareChatReply(draft: string, target: ChatReplyTarget | null): PreparedChatReply {
  const text = draft.trim();
  if (!target) return { text };

  const handle = target.authorHandle?.trim().replace(/^@+/, '');
  let replyText = text;
  if (handle) {
    const prefix = `@${handle}`;
    const normalizedText = text.normalize('NFKC').toLocaleLowerCase();
    const normalizedPrefix = prefix.normalize('NFKC').toLocaleLowerCase();
    const trailing = normalizedText[normalizedPrefix.length];
    const alreadyPrefixed =
      normalizedText.startsWith(normalizedPrefix) &&
      (trailing === undefined || MENTION_BOUNDARY.test(trailing));
    replyText = alreadyPrefixed ? text : `${prefix}${text ? ` ${text}` : ''}`;
  }

  return {
    text: replyText,
    ...(target.agentPubkey ? { agentPubkey: target.agentPubkey } : {}),
  };
}

/** Keep reply previews compact and single-line without losing their meaning. */
export function chatReplyExcerpt(text: string, maxLength = 96): string {
  const compact = text.replace(/\s+/g, ' ').trim();
  if (compact.length <= maxLength) return compact;
  return `${compact.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}
