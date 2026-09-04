/**
 * A corner carries two texts and they do different jobs.
 *
 *   - the NAME titles the corner on every surface — the Room-list child row,
 *     the corner header, the corner card, the archived card, the push. It is
 *     at most three words because those places are one line wide (C89);
 *   - the OBJECTIVE is the fixed statement of the work. It stays at 24 words,
 *     is shown in the card body, and is the corner's opening line.
 *
 * Both are NORMALISED before they are judged. A brief handed over with line
 * breaks, a tab, or a double space is untidy, not wrong, and refusing it cost
 * two silent turns: the refusal reached the model only as "failed via
 * use_tool" and the helper logged nothing at all (C90). What survives here is
 * one rule — too many words — and it refuses in a sentence that names the
 * limit and the actual count.
 */

export const CORNER_NAME_MAX_WORDS = 3;
export const CORNER_OBJECTIVE_MAX_WORDS = 24;
export const CORNER_NAME_MAX_LENGTH = 120;
export const CORNER_OBJECTIVE_MAX_LENGTH = 2000;

export type CornerTextField = 'name' | 'objective';

const LIMITS: Readonly<
  Record<CornerTextField, { readonly words: number; readonly characters: number }>
> = {
  name: { words: CORNER_NAME_MAX_WORDS, characters: CORNER_NAME_MAX_LENGTH },
  objective: { words: CORNER_OBJECTIVE_MAX_WORDS, characters: CORNER_OBJECTIVE_MAX_LENGTH },
};

/** One trimmed paragraph: every whitespace run, line break included, becomes one space. */
export function normalizeCornerText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/**
 * The plain sentence a refusal is owed, or `undefined` when the normalised
 * text is acceptable. It always names both the limit and what actually
 * arrived, so the agent can fix the call without guessing.
 */
export function cornerTextRefusal(field: CornerTextField, value: unknown): string | undefined {
  const limit = LIMITS[field];
  if (typeof value !== 'string' || !normalizeCornerText(value)) {
    return `the ${field} is required; give ${
      field === 'name' ? 'a title' : 'one statement'
    } of at most ${limit.words} words`;
  }
  const normalized = normalizeCornerText(value);
  if (normalized.length > limit.characters) {
    return `the ${field} is ${normalized.length} characters; the limit is ${limit.characters}`;
  }
  const words = normalized.split(' ').length;
  if (words > limit.words) {
    return `the ${field} is ${words} words; the limit is ${limit.words}`;
  }
  return undefined;
}

/**
 * The title a corner is drawn with. Corners opened before the name existed
 * stored the whole objective in that slot, so the first three words stand in
 * — cut on a word boundary, never mid-word, and never with an ellipsis.
 */
export function cornerDisplayName(name: string | null | undefined): string {
  const normalized = normalizeCornerText(name ?? '');
  if (!normalized) return '';
  const words = normalized.split(' ');
  return words.length <= CORNER_NAME_MAX_WORDS
    ? normalized
    : words.slice(0, CORNER_NAME_MAX_WORDS).join(' ');
}
