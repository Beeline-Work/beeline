/**
 * Choice cards: one family for a lettered question and a Room poll.
 *
 * A plurality is a preference fact, never sandbox / spend / merge permission.
 * Letters A–D are assigned by the server. Skip is a question-only footer word.
 */

export const CHOICE_MODES = ['question', 'poll'] as const;
export type ChoiceMode = (typeof CHOICE_MODES)[number];

export const CHOICE_STATUSES = ['open', 'answered', 'skipped', 'closed', 'retracted'] as const;
export type ChoiceStatus = (typeof CHOICE_STATUSES)[number];

export const CHOICE_LETTERS = ['A', 'B', 'C', 'D'] as const;
export type ChoiceLetter = (typeof CHOICE_LETTERS)[number];

export const CHOICE_PROMPT_MAX_LENGTH = 120;
export const CHOICE_CONSTRAINT_MAX_LENGTH = 160;
export const CHOICE_LABEL_MAX_LENGTH = 32;
export const CHOICE_CONSEQUENCE_MAX_LENGTH = 80;
export const CHOICE_OPTIONS_MIN = 2;
export const CHOICE_OPTIONS_MAX = 4;
export const CHOICE_POLL_ELECTORATE_MIN = 2;
export const CHOICE_POLL_ELECTORATE_MAX = 50;

/** Required poll TTL, optional question TTL. */
export const CHOICE_TTL_SECONDS = [300, 900, 3600, 14_400, 86_400] as const;
export type ChoiceTtlSeconds = (typeof CHOICE_TTL_SECONDS)[number];

/** Visible transcript card. Hidden wakes use the event kind as card_type. */
export const CHOICE_CARD_TYPE = 'choice';
export const CHOICE_WAKE_CARD_TYPES = ['choice-answered', 'choice-skipped', 'poll-closed'] as const;
export type ChoiceWakeCardType = (typeof CHOICE_WAKE_CARD_TYPES)[number];

export type ChoiceOptionInput = {
  readonly label: string;
  readonly consequence: string;
  readonly costly?: boolean;
};

export type ChoiceOptionRecord = {
  readonly optionId: string;
  readonly letter: ChoiceLetter;
  readonly label: string;
  readonly consequence: string;
  readonly costly?: boolean;
};

export type ChoiceOptionView = ChoiceOptionRecord & {
  readonly votes?: number;
  readonly share?: number;
  readonly leader?: boolean;
};

export function isChoiceMode(value: unknown): value is ChoiceMode {
  return typeof value === 'string' && (CHOICE_MODES as readonly string[]).includes(value);
}

export function isChoiceStatus(value: unknown): value is ChoiceStatus {
  return typeof value === 'string' && (CHOICE_STATUSES as readonly string[]).includes(value);
}

export function isChoiceTtlSeconds(value: unknown): value is ChoiceTtlSeconds {
  return typeof value === 'number' && (CHOICE_TTL_SECONDS as readonly number[]).includes(value);
}

function flattenLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function refuse(message: string): never {
  throw new Error(message);
}

/**
 * Validate caller options and assign A–D. Labels and consequences are flattened
 * before length is judged, so only a genuinely over-long text is refused.
 */
export function normalizeChoiceOptions(input: unknown): ChoiceOptionRecord[] {
  if (!Array.isArray(input)) refuse('choice options are required');
  if (input.length < CHOICE_OPTIONS_MIN)
    refuse(`a choice needs ${CHOICE_OPTIONS_MIN} to ${CHOICE_OPTIONS_MAX} options`);
  if (input.length > CHOICE_OPTIONS_MAX)
    refuse(`a choice needs ${CHOICE_OPTIONS_MIN} to ${CHOICE_OPTIONS_MAX} options`);
  return input.map((raw, index) => {
    if (!raw || typeof raw !== 'object') refuse('choice option is invalid');
    const entry = raw as Record<string, unknown>;
    if (typeof entry.label !== 'string') refuse('choice option label is required');
    if (typeof entry.consequence !== 'string') refuse('choice option consequence is required');
    const label = flattenLine(entry.label);
    const consequence = flattenLine(entry.consequence);
    if (!label) refuse('choice option label is required');
    if (!consequence) refuse('choice option consequence is required');
    if (label.length > CHOICE_LABEL_MAX_LENGTH) refuse('choice option label is too long');
    if (consequence.length > CHOICE_CONSEQUENCE_MAX_LENGTH)
      refuse('choice option consequence is too long');
    const letter = CHOICE_LETTERS[index]!;
    return {
      optionId: letter,
      letter,
      label,
      consequence,
      ...(entry.costly === true ? { costly: true } : {}),
    };
  });
}

export function normalizeChoicePrompt(value: unknown): string {
  if (typeof value !== 'string') refuse('choice prompt is required');
  const prompt = flattenLine(value);
  if (!prompt) refuse('choice prompt is required');
  if (prompt.length > CHOICE_PROMPT_MAX_LENGTH) refuse('choice prompt is too long');
  return prompt;
}

export function normalizeChoiceConstraint(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') refuse('choice constraint is invalid');
  const constraint = flattenLine(value);
  if (!constraint) return undefined;
  if (constraint.length > CHOICE_CONSTRAINT_MAX_LENGTH) refuse('choice constraint is too long');
  return constraint;
}

export function normalizeChoiceTtl(value: unknown, required: boolean): ChoiceTtlSeconds | undefined {
  if (value === undefined || value === null) {
    if (required) refuse('poll ttlSeconds is required');
    return undefined;
  }
  if (!isChoiceTtlSeconds(value)) refuse('choice ttlSeconds must be 300, 900, 3600, 14400, or 86400');
  return value;
}

export type ChoiceTally = {
  readonly votesByOption: Readonly<Record<string, number>>;
  readonly leadingVotes: number;
  readonly uniqueLeaderId: string | undefined;
  readonly outcome: 'winner' | 'tie' | 'no-votes';
};

/** Width is votes / leading votes. A unique leader is also the longest bar. Ties have no winner. */
export function tallyChoiceVotes(
  options: readonly ChoiceOptionRecord[],
  votesByOption: Readonly<Record<string, number>>,
): ChoiceTally {
  const counts: Record<string, number> = {};
  let leadingVotes = 0;
  for (const option of options) {
    const votes = Math.max(0, Math.floor(votesByOption[option.optionId] ?? 0));
    counts[option.optionId] = votes;
    if (votes > leadingVotes) leadingVotes = votes;
  }
  if (leadingVotes === 0) {
    return { votesByOption: counts, leadingVotes: 0, uniqueLeaderId: undefined, outcome: 'no-votes' };
  }
  const leaders = options.filter((option) => counts[option.optionId] === leadingVotes);
  if (leaders.length !== 1) {
    return { votesByOption: counts, leadingVotes, uniqueLeaderId: undefined, outcome: 'tie' };
  }
  return {
    votesByOption: counts,
    leadingVotes,
    uniqueLeaderId: leaders[0]!.optionId,
    outcome: 'winner',
  };
}

export function choiceOptionShare(votes: number, leadingVotes: number): number {
  if (leadingVotes <= 0 || votes <= 0) return 0;
  return votes / leadingVotes;
}

export function decorateChoiceOptions(
  options: readonly ChoiceOptionRecord[],
  tally: ChoiceTally | undefined,
): ChoiceOptionView[] {
  if (!tally) return options.map((option) => ({ ...option }));
  return options.map((option) => {
    const votes = tally.votesByOption[option.optionId] ?? 0;
    const leader = tally.uniqueLeaderId === option.optionId;
    return {
      ...option,
      votes,
      share: choiceOptionShare(votes, tally.leadingVotes),
      ...(leader ? { leader: true } : {}),
    };
  });
}

export function choiceClosedFooter(
  tally: ChoiceTally,
  votedCount: number,
  electorateCount: number,
): string {
  if (tally.outcome === 'no-votes') return 'closed · no votes';
  if (tally.outcome === 'tie') {
    const tied = Object.values(tally.votesByOption).filter((votes) => votes === tally.leadingVotes);
    return `tied · ${tied.join(' and ')}`;
  }
  return `closed · ${votedCount} of ${electorateCount} voted`;
}

export function formatChoiceClock(unixSeconds: number): string {
  const date = new Date(unixSeconds * 1000);
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${hours}:${minutes}`;
}
