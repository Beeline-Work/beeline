function withoutFencedCode(text: string): { text: string; open: boolean } {
  let fence: string | undefined;
  const lines: string[] = [];
  for (const line of text.split('\n')) {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (marker && marker[1]![0] === fence[0] && marker[1]!.length >= fence.length && !marker[2]!.trim()) fence = undefined;
    } else if (marker) {
      fence = marker[1]!;
      lines.push('');
    } else lines.push(line);
  }
  return { text: lines.join('\n'), open: !!fence };
}

function withoutLinkDestinations(text: string): string {
  const opening = /!?\[([^\]]*)\]\(/g;
  let result = '';
  let consumed = 0;
  let match: RegExpExecArray | null;
  while ((match = opening.exec(text))) {
    let depth = 1;
    let end = opening.lastIndex;
    for (; end < text.length; end++) {
      const character = text[end];
      if (character === '\n') break;
      if (character === '\\') { end++; continue; }
      if (character === '(') depth++;
      if (character === ')') {
        depth--;
        if (depth === 0) break;
      }
    }
    if (depth !== 0) continue;
    result += text.slice(consumed, match.index) + match[1];
    consumed = end + 1;
    opening.lastIndex = consumed;
  }
  return result + text.slice(consumed);
}

/** Normalize only speech input; the transcript keeps the original Markdown. */
export function markdownToSpeech(text: string): string {
  return withoutLinkDestinations(withoutFencedCode(text).text)
    .replace(/^\s*\[[^\]]+\]:\s+\S+.*$/gm, '')
    .replace(/\[([^\]]+)\]\[[^\]]*\]/g, '$1')
    .replace(/^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/gm, '')
    .replace(/^ {0,3}(?:#{1,6}\s+|(?:>\s*)+|[-+*]\s+|\d+[.)]\s+)/gm, '')
    .replace(/[ \t]+#+[ \t]*$/gm, '')
    .replace(/^\s*(?:[-*_]\s*){3,}$/gm, '')
    .replace(/^(.+)\n\s*(?:=+|-+)\s*$/gm, '$1')
    .replace(/`+([^`]*?)`+/g, '$1')
    .replace(/\*{2,}|_{2,}|~~/g, '')
    .replace(/(?<![\p{L}\p{N}])([*_])(?=\S)|(?<=\S)([*_])(?![\p{L}\p{N}])/gu, '')
    .replace(/(?<![\p{L}\p{N}])@([\p{L}\p{N}_-]+)/gu, '$1')
    .replace(/^[ \t]*\|[ \t]*|[ \t]*\|[ \t]*$/gm, '')
    .replace(/[ \t]*\|[ \t]*/g, ', ')
    .trim()
    .replace(/([.!?,;:])?\n+/g, (_break, punctuation: string | undefined) => punctuation ? `${punctuation} ` : '. ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Hold Markdown until its paragraph is complete, so split syntax never reaches TTS.
 * Plain prose still starts playback on the first clause.
 */
export class MarkdownSpeechStream {
  private pending = '';
  push(delta: string): string[] {
    this.pending += delta;
    const phrases: string[] = [];
    // A blank line is safe only outside a fenced block.
    let boundary = this.pending.indexOf('\n\n');
    while (boundary >= 0) {
      const prefix = this.pending.slice(0, boundary + 2);
      if (withoutFencedCode(prefix).open) break;
      phrases.push(markdownToSpeech(prefix));
      this.pending = this.pending.slice(boundary + 2);
      boundary = this.pending.indexOf('\n\n');
    }
    if (!/[*_`~\[\]#>|@\n]/.test(this.pending) && !/^\s*(?:[-+]\s|\d+[.)]\s)/.test(this.pending)) {
      let match: RegExpExecArray | null;
      while ((match = /[.!?,;:]\s/.exec(this.pending))) {
        phrases.push(markdownToSpeech(this.pending.slice(0, match.index + 1)));
        this.pending = this.pending.slice(match.index + 2);
      }
    }
    return phrases.filter(Boolean);
  }
  finish(): string {
    const text = markdownToSpeech(this.pending);
    this.pending = '';
    return text;
  }
}
