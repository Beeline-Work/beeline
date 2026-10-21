/** Stable labels for legacy schedules; never expose instructions as a title. */
export function scheduleFallbackTitle(workflow?: string | null): string {
  const words = workflow?.replace(/[_-]+/g, ' ').trim().split(/\s+/).slice(0, 4).join(' ');
  return words ? words[0]!.toUpperCase() + words.slice(1) : 'Scheduled task';
}

export function validateScheduleTitle(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new Error('title must be one to four words');
  const title = value.trim().replace(/\s+/g, ' ');
  if (!title || title.length > 80 || title.split(' ').length > 4)
    throw new Error('title must be one to four words, at most 80 characters');
  return title;
}
