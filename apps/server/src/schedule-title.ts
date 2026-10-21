/** The generic label a schedule shows when nothing names it. */
export const SCHEDULE_FALLBACK_TITLE = 'Scheduled task';

/** The longest a prompt's first sentence runs on a row before it is ellipsized. */
const PROMPT_LEAD = 48;

/** A workflow slug as up to four title words; never a prompt's instructions. */
export function scheduleFallbackTitle(workflow?: string | null): string {
  const words = workflow?.replace(/[_-]+/g, ' ').trim().split(/\s+/).slice(0, 4).join(' ');
  return words ? words[0]!.toUpperCase() + words.slice(1) : SCHEDULE_FALLBACK_TITLE;
}

/**
 * The first sentence of a prompt, cut to fit a list row. A schedule created
 * without a name still says what it runs, one trimmed line at a time.
 */
export function schedulePromptTitle(prompt?: string | null): string | undefined {
  const text = prompt?.replace(/\s+/g, ' ').trim();
  if (!text) return undefined;
  const sentence = text.match(/^.*?[.!?](?=\s|$)/)?.[0] ?? text;
  const bare = sentence.replace(/[.!?]$/, '');
  if (!bare) return undefined;
  if (bare.length > PROMPT_LEAD) return `${bare.slice(0, PROMPT_LEAD - 1).trimEnd()}…`;
  return bare.length < text.replace(/[.!?]$/, '').length ? `${bare}…` : bare;
}

/**
 * The one-line name a schedule row shows. An explicit title wins, otherwise the
 * saved workflow's words, otherwise the first sentence of the prompt it runs.
 * Rows that stored the generic fallback before this derivation existed read as
 * having no title, so they gain a real name without a backfill.
 */
export function scheduleDisplayTitle(input: {
  title?: string | null;
  workflow?: string | null;
  prompt?: string | null;
}): string {
  const explicit = input.title?.trim();
  if (explicit && explicit !== SCHEDULE_FALLBACK_TITLE) return explicit;
  const workflow = scheduleFallbackTitle(input.workflow);
  if (workflow !== SCHEDULE_FALLBACK_TITLE) return workflow;
  return schedulePromptTitle(input.prompt) ?? SCHEDULE_FALLBACK_TITLE;
}

export function validateScheduleTitle(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new Error('title must be one to four words');
  const title = value.trim().replace(/\s+/g, ' ');
  if (!title || title.length > 80 || title.split(' ').length > 4)
    throw new Error('title must be one to four words, at most 80 characters');
  return title;
}
