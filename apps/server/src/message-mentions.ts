const MENTION_TOKEN = /@([\p{L}\p{M}\p{N}_]+(?:[.-][\p{L}\p{M}\p{N}_]+)*)/gu;
const TOKEN_CHARACTER = /[\p{L}\p{M}\p{N}_.-]/u;

function codePointBefore(text: string, offset: number): string | undefined {
  if (offset <= 0) return undefined;
  const prefix = text.slice(0, offset);
  return [...prefix].at(-1);
}

function codePointAt(text: string, offset: number): string | undefined {
  return [...text.slice(offset)][0];
}

/** Exact @handles written as standalone tokens. */
export function typedMentionHandles(text: string): Set<string> {
  const handles = new Set<string>();
  for (const match of text.matchAll(MENTION_TOKEN)) {
    const offset = match.index ?? 0;
    const before = codePointBefore(text, offset);
    const punctuation = text.slice(offset + match[0].length).match(/^[.-]+/u)?.[0];
    const afterPunctuation = punctuation
      ? codePointAt(text, offset + match[0].length + punctuation.length)
      : undefined;
    if (
      (!before || !TOKEN_CHARACTER.test(before)) &&
      (!afterPunctuation || !TOKEN_CHARACTER.test(afterPunctuation))
    )
      handles.add(match[1] ?? '');
  }
  return handles;
}
