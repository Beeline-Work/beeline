/** Compare final prose only with visible output from this generation and address. */
export function turnMessageRepetition(final: string, earlier: string): 'same' | 'similar' | false {
  // Preserve punctuation and case, and preserve whitespace inside code spans.
  // Only whitespace between tokens is presentation: signs, paths, identifiers
  // and code must never become equal through lossy text normalization.
  const tokens = (text: string) => text.match(/(`+)[\s\S]*?\1|[^\s]+/g) ?? [];
  const next = tokens(final), previous = tokens(earlier);
  if (!next.length || !previous.length) return false;
  const contains = (haystack: string[], needle: string[]) => {
    if (needle.length > haystack.length) return false;
    for (let start = 0; start <= haystack.length - needle.length; start++) {
      if (needle.every((word, offset) => word === haystack[start + offset])) return true;
    }
    return false;
  };
  if (contains(previous, next)) return 'same';
  // Any appended sentence is new information, even when most words repeat.
  if (contains(next, previous)) return false;
  // A near match remains in collapsed activity rather than losing authored text.
  const sentences = (text: string) => text.split(/[.!?]+(?:\s|$)/).filter(s => s.trim()).length;
  if (final.length > 16000 || earlier.length > 16000 || Math.max(next.length, previous.length) > 2048 || next.length < 12 || sentences(final) !== sentences(earlier)) return false;
  // Near matching may change ordinary connective words only. Anything that
  // could be a literal must occur exactly, in the same order and quantity.
  const literals = (words: string[]) => JSON.stringify(words.filter(word => !/^\p{L}+[.,!?;:]?$/u.test(word)));
  if (literals(next) !== literals(previous)) return false;
  const cosmetic = new Set(['now', 'already', 'just', 'the', 'a', 'an', 'is', 'was', 'has', 'been', 'ready', 'available']);
  const content = (words: string[]) => JSON.stringify(words.filter(word => !cosmetic.has(word)));
  if (content(next) !== content(previous)) return false;
  const oldWords = new Set(previous), newWords = new Set(next);
  if (next.some(word => !oldWords.has(word)) ||
      previous.some(word => !newWords.has(word) && !cosmetic.has(word))) return false;
  // Bounded token edit distance: small wording changes, no unbounded quadratic work.
  const budget = Math.min(3, Math.floor(Math.max(next.length, previous.length) * 0.08));
  if (Math.abs(next.length - previous.length) > budget) return false;
  let row = Array.from({ length: previous.length + 1 }, (_, i) => i);
  for (let i = 1; i <= next.length; i++) {
    const current = new Array<number>(previous.length + 1).fill(budget + 1);
    current[0] = i;
    for (let j = Math.max(1, i - budget); j <= Math.min(previous.length, i + budget); j++) {
      current[j] = Math.min(current[j - 1]! + 1, row[j]! + 1,
        row[j - 1]! + (next[i - 1] === previous[j - 1] ? 0 : 1));
    }
    row = current;
  }
  return row[previous.length]! <= budget ? 'similar' : false;
}
