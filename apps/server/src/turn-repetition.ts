/** Compare final prose only with visible output from this generation and address. */
export function turnMessageRepetition(final: string, earlier: string): 'same' | 'similar' | false {
  const tokens = (text: string) => text.normalize('NFKC').toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(/\s+/).filter(Boolean);
  // Punctuation in a URL or signed number carries meaning; normalization
  // must not turn a changed destination or amount into an exact match.
  const literals = (text: string) => text.match(/https?:\/\/\S+|(?<!\w)[+-]?\d+(?:\.\d+)?%?/g)?.join('|') ?? '';
  const next = tokens(final), previous = tokens(earlier);
  if (!next.length || !previous.length) return false;
  const a = next.join(' '), b = previous.join(' ');
  if (a === b) return literals(final) === literals(earlier) ? 'same' : false;
  if (` ${b} `.includes(` ${a} `)) return 'same';
  // Any appended sentence is new information, even when most words repeat.
  if (` ${a} `.includes(` ${b} `)) return false;
  // Require the same sentence count and no changed numbers, negations or links.
  // A near match remains in collapsed activity rather than losing authored text.
  const sentences = (text: string) => text.split(/[.!?]+(?:\s|$)/).filter(s => s.trim()).length;
  if (final.length > 16000 || earlier.length > 16000 || Math.max(next.length, previous.length) > 2048 || next.length < 12 || sentences(final) !== sentences(earlier)) return false;
  const facts = (text: string) => text.toLowerCase().match(/https?:\/\/\S+|\b\d+\b|\b(?:not|never|no|cannot|can't|failed|passed|pending)\b/g)?.sort().join('|') ?? '';
  if (facts(final) !== facts(earlier) || literals(final) !== literals(earlier)) return false;
  // A new content word can change the outcome despite a high similarity
  // score. Only tolerate small edits to connective/presentation wording.
  const cosmetic = new Set(['now', 'already', 'just', 'the', 'a', 'an', 'is', 'was', 'has', 'been', 'ready', 'available']);
  const oldWords = new Set(previous), newWords = new Set(next);
  if (next.some(word => !oldWords.has(word) && !cosmetic.has(word)) ||
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
