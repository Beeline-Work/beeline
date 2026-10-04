/**
 * Deterministic clean-up of a platform transcript against the Room lexicon.
 * No model runs and nothing leaves the phone: the recognizer alternative that
 * names the most Room terms wins, and sound-alike words are snapped to the
 * Room's proper nouns ("Croc" -> "Groq", "open rotor" -> "OpenRouter").
 */

// Longest run of spoken words joined into one lexicon term ("open rotor").
const MAX_WINDOW_WORDS = 3;
// Short names collide with ordinary words ("Ruby" / "rabbi"); never snap them.
const MIN_TERM_LETTERS = 4;
const MIN_KEY_LENGTH = 3;
// A long single word may differ by one sound; shorter ones must match exactly.
const SINGLE_WORD_EDIT_MIN_LENGTH = 8;
// A joined run may differ by one sound per this many letters.
const JOINED_LETTERS_PER_EDIT = 5;

type LexiconEntry = { term: string; sound: string; letters: string };

export type SpeechCorrector = {
  /** Chooses the best alternative and snaps it to the lexicon. */
  correct(alternatives: readonly string[]): string;
};

function lettersOf(text: string): string {
  return text.toLowerCase().replace(/[^a-z]/g, '');
}

/** Spelling with the consonants recognizers confuse merged: c/g/q/k, ph/f, z/s. */
function soundOf(text: string): string {
  return lettersOf(text)
    .replace(/ph/g, 'f')
    .replace(/ck/g, 'k')
    .replace(/c(?=[eiy])/g, 's')
    .replace(/[cgq]/g, 'k')
    .replace(/x/g, 'ks')
    .replace(/z/g, 's')
    .replace(/(.)\1+/g, '$1');
}

/** The consonant skeleton: first sound kept, later vowels and h/w/y dropped. */
function keyOf(sound: string): string {
  return sound.charAt(0) + sound.slice(1).replace(/[aeiouhwy]/g, '');
}

function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min(
        previous[j]! + 1,
        current[j - 1]! + 1,
        previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[b.length]!;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

type Token = { lead: string; core: string; trail: string };

function tokenize(word: string): Token {
  const match = /^([^A-Za-z0-9']*)(.*?)([^A-Za-z0-9']*)$/.exec(word)!;
  return { lead: match[1]!, core: match[2]!, trail: match[3]! };
}

/** Builds a corrector for one lexicon; reuse it across results. */
export function createSpeechCorrector(lexicon: readonly string[]): SpeechCorrector {
  const byKey = new Map<string, LexiconEntry[]>();
  // Proper nouns only: a lowercase term is a word the recognizer already knows,
  // and a camelCase identifier is not what a person means by "use speech input".
  for (const term of lexicon) {
    if (!/^[A-Z]/.test(term)) continue;
    const letters = lettersOf(term);
    if (letters.length < MIN_TERM_LETTERS) continue;
    const sound = soundOf(term);
    const key = keyOf(sound);
    if (key.length < MIN_KEY_LENGTH) continue;
    const entries = byKey.get(key) ?? [];
    entries.push({ term, sound, letters });
    byKey.set(key, entries);
  }
  const counters = lexicon
    .filter((term) => lettersOf(term).length > 0)
    .map((term) => new RegExp(`(^|[^A-Za-z0-9])${escapeRegExp(term)}(?![A-Za-z0-9])`, 'i'));

  const match = (words: readonly string[]): string | null => {
    const joined = words.join('');
    const sound = soundOf(joined);
    const entries = byKey.get(keyOf(sound));
    if (!entries) return null;
    const letters = lettersOf(joined);
    for (const entry of entries) {
      if (words.length === 1) {
        // A case-only difference is the recognizer's call ("candy" vs "Candy").
        if (letters === entry.letters) continue;
        const allowed = sound.length >= SINGLE_WORD_EDIT_MIN_LENGTH ? 1 : 0;
        if (editDistance(sound, entry.sound) <= allowed) return entry.term;
      } else {
        const allowed = Math.floor(entry.sound.length / JOINED_LETTERS_PER_EDIT);
        if (editDistance(sound, entry.sound) <= allowed) return entry.term;
      }
    }
    return null;
  };

  const snap = (text: string): string => {
    if (byKey.size === 0) return text;
    const parts = text.split(/(\s+)/);
    const words = parts.filter((_, index) => index % 2 === 0);
    const spaces = parts.filter((_, index) => index % 2 === 1);
    const tokens = words.map(tokenize);
    const out: string[] = [];
    let index = 0;
    while (index < tokens.length) {
      let replaced = false;
      for (let size = Math.min(MAX_WINDOW_WORDS, tokens.length - index); size >= 1; size -= 1) {
        const window = tokens.slice(index, index + size);
        // Punctuation inside a run ends a phrase; only its edges may carry any.
        const inner = window.every(
          (token, offset) =>
            /[A-Za-z]/.test(token.core) &&
            (offset === 0 || !token.lead) &&
            (offset === size - 1 || !token.trail),
        );
        if (!inner) continue;
        const term = match(window.map((token) => token.core));
        if (!term) continue;
        out.push(window[0]!.lead + term + window[size - 1]!.trail);
        if (index + size < tokens.length) out.push(spaces[index + size - 1]!);
        index += size;
        replaced = true;
        break;
      }
      if (replaced) continue;
      out.push(words[index]!);
      if (index + 1 < tokens.length) out.push(spaces[index]!);
      index += 1;
    }
    return out.join('');
  };

  return {
    correct(alternatives) {
      let best = '';
      let bestScore = -1;
      for (const alternative of alternatives) {
        if (!alternative) continue;
        const snapped = snap(alternative);
        const score = counters.filter((counter) => counter.test(snapped)).length;
        // Ties keep the recognizer's own ranking.
        if (score > bestScore) {
          best = snapped;
          bestScore = score;
        }
      }
      return best;
    },
  };
}
