/** A plain, one-line decision or action for the Needs-you tray. */
export const TRAY_ASK_MAX_LENGTH = 140;

export function plainAsk(value: string): string {
  return value
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]*>/g, '')
    .replace(/[*`~]/g, '')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/(^|\s)_([^_]+)_(?=\s|[.,;:!?]|$)/g, '$1$2')
    .replace(/^\s*(?:#{1,6}|>|[-+]\s|\d+[.)]\s)\s*/gm, '')
    .replace(/\b[0-9a-f]{20,64}\b/gi, hash => hash.slice(0, 7))
    .replace(/\s+/g, ' ')
    .replace(/^(?:…|\.{3})\s*/, '')
    .trim();
}

export function shortenAsk(value: string): string {
  const text = plainAsk(value);
  const chars = Array.from(text);
  if (chars.length <= TRAY_ASK_MAX_LENGTH) return text;
  const head = chars.slice(0, TRAY_ASK_MAX_LENGTH - 1).join('');
  const boundary = head.lastIndexOf(' ');
  return `${head.slice(0, boundary > 100 ? boundary : head.length).trimEnd()}…`;
}

export function normalizeTrayAsk(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('ask is required');
  const text = value.trim();
  if (/\r|\n/.test(text) || text !== plainAsk(text) || Array.from(text).length > TRAY_ASK_MAX_LENGTH)
    throw new Error('ask must be plain text on one line, at most 140 characters');
  if (/[.!?]\s+\S/.test(text)) throw new Error('ask must be one sentence');
  return text;
}
