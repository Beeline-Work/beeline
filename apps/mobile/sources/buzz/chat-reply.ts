/** Prefix an Agent reply with its visible handle without duplicating an existing prefix. */
export function prefixAgentReply(text: string, agentHandle?: string): string {
  const trimmed = text.trim();
  if (!agentHandle) return trimmed;

  const mention = `@${agentHandle}`;
  const normalizedText = trimmed.normalize('NFKC').toLocaleLowerCase();
  const normalizedMention = mention.normalize('NFKC').toLocaleLowerCase();
  const trailing = normalizedText[normalizedMention.length];
  if (
    normalizedText.startsWith(normalizedMention) &&
    (trailing === undefined || /[\s,.:;!?)}\]]/.test(trailing))
  ) {
    return trimmed;
  }
  return trimmed ? `${mention} ${trimmed}` : mention;
}

/** Keep reply affordances compact while retaining enough context to identify the target. */
export function replyExcerpt(text: string, maxLength = 96): string {
  const normalized = text.trim().replace(/\s+/g, ' ');
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}
