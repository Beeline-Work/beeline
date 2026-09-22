export const PEEK_LINE_COUNT = 4;
const PLAIN_TEXT_LANGUAGES = new Set(['text', 'txt', 'plaintext', 'markdown', 'md']);

export function isPlainTextFence(language: string | null) {
  const normalized = language?.trim().toLowerCase();
  return !normalized || PLAIN_TEXT_LANGUAGES.has(normalized);
}

export function fenceByteLength(code: string): number {
  return new TextEncoder().encode(code).length;
}

export function formatFenceBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 10) return `${Math.round(kb * 10) / 10} KB`;
  return `${Math.round(kb)} KB`;
}

export function fenceInscription(language: string | null, code: string): string {
  const lines = code.split('\n').length;
  const lang = (language?.trim() || 'text').toLowerCase();
  const lineLabel = lines === 1 ? '1 line' : `${lines} lines`;
  return `${lang} · ${lineLabel} · ${formatFenceBytes(fenceByteLength(code))}`;
}

export function isLongFence(code: string): boolean {
  return code.split('\n').length > PEEK_LINE_COUNT;
}

export function hiddenLineLabel(lineCount: number): string {
  const hidden = Math.max(0, lineCount - PEEK_LINE_COUNT);
  return hidden === 1 ? '1 more line' : `${hidden} more lines`;
}
