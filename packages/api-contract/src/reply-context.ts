export const REPLY_EXCERPT_MAX_LENGTH = 300;

/** Keep reply context short, cutting at a word boundary when one is available. */
export function boundReplyExcerpt(text: string): string {
  if (text.length <= REPLY_EXCERPT_MAX_LENGTH) return text.trim();
  const prefix = text.slice(0, REPLY_EXCERPT_MAX_LENGTH - 1);
  return `${prefix.replace(/\s+\S*$/, '').trim()}…`;
}
