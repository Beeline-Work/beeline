import { ExpectedRefusalError } from './command-refusal.js';

/** The generic label a schedule shows when nothing names it. */
export const SCHEDULE_FALLBACK_TITLE = 'Scheduled task';

/** A derived title never runs past this many words or this many characters. */
const PROMPT_TITLE_WORDS = 4;
const TITLE_MAX_LENGTH = 80;

/** A workflow slug as up to four title words; never a prompt's instructions. */
export function scheduleFallbackTitle(workflow?: string | null): string {
  const words = workflow?.replace(/[_-]+/g, ' ').trim().split(/\s+/).slice(0, PROMPT_TITLE_WORDS).join(' ');
  const title = words ? words[0]!.toUpperCase() + words.slice(1) : SCHEDULE_FALLBACK_TITLE;
  return title.length > TITLE_MAX_LENGTH
    ? `${title.slice(0, TITLE_MAX_LENGTH - 1).trimEnd()}…`
    : title;
}

/**
 * The first few words of a prompt, so a schedule created without a name still
 * says what it runs. Never a whole sentence: one to four words, at most 80
 * characters, the same shape `validateScheduleTitle` accepts.
 */
export function schedulePromptTitle(prompt?: string | null): string | undefined {
  const words = prompt?.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean) ?? [];
  if (!words.length) return undefined;
  const title = words
    .slice(0, PROMPT_TITLE_WORDS)
    .join(' ')
    .replace(/[.!?,;:]+$/, '')
    .trim();
  if (!title) return undefined;
  return title.length > TITLE_MAX_LENGTH
    ? `${title.slice(0, TITLE_MAX_LENGTH - 1).trimEnd()}…`
    : title;
}

/**
 * The one-line name a schedule row shows. An explicit title wins, otherwise the
 * saved workflow's words, otherwise the first few words of the prompt it runs.
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
  if (typeof value !== 'string') throw new ExpectedRefusalError('title must be one to four words');
  const title = value.trim().replace(/\s+/g, ' ');
  if (!title || title.length > 80 || title.split(' ').length > 4)
    throw new ExpectedRefusalError('title must be one to four words, at most 80 characters');
  return title;
}
