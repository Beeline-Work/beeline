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

export type SpeechMember = { handle?: string | null; name: string };
export type SpeechMembers = ReadonlyMap<string, string> | Readonly<Record<string, string>> | readonly SpeechMember[];

function memberIndex(members?: SpeechMembers): Map<string, string> {
  const index = new Map<string, string>();
  const add = (handle: unknown, name: unknown) => {
    if (typeof handle !== 'string' || typeof name !== 'string' || !name.trim()) return;
    const key = handle.replace(/^@/, '').trim().toLowerCase();
    if (key) index.set(key, name.trim());
  };
  if (!members) return index;
  if (members instanceof Map) {
    for (const [handle, name] of members) add(handle, name);
  } else if (Array.isArray(members)) {
    for (const member of members as readonly SpeechMember[]) add(member.handle ?? member.name, member.name);
  } else {
    for (const [handle, name] of Object.entries(members as Readonly<Record<string, string>>)) add(handle, name);
  }
  return index;
}

const HANDLE_TOKEN = /(?<![\p{L}\p{N}_@\/-])([\p{L}\p{N}][\p{L}\p{N}_-]*)(?![\p{L}\p{N}_-])/gu;
const TOKEN = /(?<![\p{L}\p{N}_@\/-])([A-Za-z0-9][A-Za-z0-9_.+-]*[A-Za-z0-9])(?![\p{L}\p{N}_-])/gu;

/** A word-like token keeps its digits; identifiers do not. */
function readsAsWord(token: string): boolean {
  const runs = token.split(/[^A-Za-z]+/).filter(run => run.length >= 4);
  return runs.some(run => /[aeiouy]/i.test(run));
}

/** A machine identifier mixes letters and digits with no pronounceable word. */
function isMachineId(token: string): boolean {
  return token.length >= 8 && /[A-Za-z]/.test(token) && /\d/.test(token) && !readsAsWord(token);
}

/** True when no bracket opened before the cut is still unclosed. */
function bracketsClosed(text: string): boolean {
  const closing: Record<string, string> = { ')': '(', ']': '[', '}': '{' };
  const stack: string[] = [];
  for (const character of text) {
    if (character === '(' || character === '[' || character === '{') stack.push(character);
    else if (character in closing && stack[stack.length - 1] === closing[character]) stack.pop();
  }
  return stack.length === 0;
}

/** Deterministic speech cleanup; the written transcript is never changed. */
function speakIdentifiers(text: string, members?: SpeechMembers): string {
  const index = memberIndex(members);
  let spoken = text
    .replace(/(?<![\p{L}\p{N}_])@([\p{L}\p{N}_-]+)/gu, (_mention, handle: string) => {
      const named = index.get(handle.toLowerCase());
      if (named) return named;
      const letters = handle.replace(/[\d._-]+$/g, '');
      return letters.length >= 2 ? letters : handle;
    })
    .replace(HANDLE_TOKEN, (token: string) => index.get(token.toLowerCase()) ?? token)
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '')
    .replace(/\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,}\b/gi, '')
    .replace(/\b(?=[0-9a-f]*[a-f])[0-9a-f]{16,}\b/gi, '')
    .replace(/(?<![\p{L}\p{N}_])(?:fb|msg|evt|req|obj|att|sha|uuid|id)_[A-Za-z0-9][A-Za-z0-9_-]{5,}(?![\p{L}\p{N}_-])/giu, '')
    .replace(HANDLE_TOKEN, (token: string) => {
      // A consonant-only machine ID drops before the bare-handle digit fallback.
      if (isMachineId(token)) return '';
      // A handle-like word keeps its letters: bananaman614305 -> bananaman.
      const match = /^([\p{L}][\p{L}_-]*?)(\d{4,})$/u.exec(token);
      if (!match || token.length < 10) return token;
      const letters = match[1]!.replace(/[_\-]+$/g, '');
      return letters.length >= 3 ? letters : token;
    })
    .replace(TOKEN, (token: string) => (isMachineId(token) ? '' : token));

  let previous: string;
  do {
    previous = spoken;
    spoken = spoken
      .replace(/[([{]\s*[)\]}]/g, '')
      .replace(/\b(?:i\.?d|uuid|sha|hash)\s*[:=]\s*(?=$|[.,;!?)\]A-Za-z])/gi, '')
      .replace(/,+\s*(?=[,.;:!?)\]])/g, '')
      .replace(/(?:^|\s)[,;:](?=\s|$)/g, '')
      .replace(/\s+([.,;:!?)\]])/g, '$1')
      .replace(/([([{])\s+/g, '$1')
      .replace(/\s{2,}/g, ' ');
  } while (spoken !== previous);
  return spoken.trim();
}

/** Normalize only speech input; the transcript keeps the original Markdown. */
export function markdownToSpeech(text: string, members?: SpeechMembers): string {
  const spoken = withoutLinkDestinations(withoutFencedCode(text).text)
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
    .replace(/^[ \t]*\|[ \t]*|[ \t]*\|[ \t]*$/gm, '')
    .replace(/[ \t]*\|[ \t]*/g, ', ')
    .trim()
    .replace(/([.!?,;:])?\n+/g, (_break, punctuation: string | undefined) => punctuation ? `${punctuation} ` : '. ')
    .replace(/\s+/g, ' ')
    .trim();
  return speakIdentifiers(spoken, members);
}

/** Hold Markdown until its paragraph is complete, so split syntax never reaches TTS.
 * Plain prose still starts playback on the first clause.
 */
export class MarkdownSpeechStream {
  private pending = '';
  constructor(private readonly members?: SpeechMembers) {}
  push(delta: string): string[] {
    this.pending += delta;
    const phrases: string[] = [];
    // A blank line is safe only outside a fenced block.
    let boundary = this.pending.indexOf('\n\n');
    while (boundary >= 0) {
      const prefix = this.pending.slice(0, boundary + 2);
      if (withoutFencedCode(prefix).open) break;
      phrases.push(markdownToSpeech(prefix, this.members));
      this.pending = this.pending.slice(boundary + 2);
      boundary = this.pending.indexOf('\n\n');
    }
    if (!/[*_`~\[\]#>|@\n]/.test(this.pending) && !/^\s*(?:[-+]\s|\d+[.)]\s)/.test(this.pending)) {
      const sentence = /[.!?,;:]\s/g;
      let match: RegExpExecArray | null;
      while ((match = sentence.exec(this.pending))) {
        const cut = match.index + 1;
        // Never split inside an open bracket: a parenthesized ID clause must stay whole.
        if (!bracketsClosed(this.pending.slice(0, cut))) continue;
        phrases.push(markdownToSpeech(this.pending.slice(0, cut), this.members));
        this.pending = this.pending.slice(cut + 1);
        sentence.lastIndex = 0;
      }
    }
    return phrases.filter(Boolean);
  }
  finish(): string {
    const text = markdownToSpeech(this.pending, this.members);
    this.pending = '';
    return text;
  }
}
