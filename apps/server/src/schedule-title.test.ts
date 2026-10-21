import { describe, expect, it } from 'vitest';
import { scheduleFallbackTitle, validateScheduleTitle } from './schedule-title.js';

describe('short schedule titles', () => {
  it('normalizes one to four words and rejects blank or long labels', () => {
    expect(validateScheduleTitle('  Play  downloads check ')).toBe('Play downloads check');
    expect(validateScheduleTitle(undefined)).toBeUndefined();
    for (const title of ['', ' ', 'one two three four five', 'x'.repeat(81), 7, null])
      expect(() => validateScheduleTitle(title)).toThrow();
  });
  it('uses workflow display words, bounded to four, or a prompt-free fallback', () => {
    expect(scheduleFallbackTitle('feedback-triage')).toBe('Feedback triage');
    expect(scheduleFallbackTitle('one-two-three-four-five')).toBe('One two three four');
    expect(scheduleFallbackTitle(null)).toBe('Scheduled task');
  });
});
