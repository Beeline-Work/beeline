import { describe, expect, it } from 'vitest';
import {
  scheduleDisplayTitle,
  scheduleFallbackTitle,
  schedulePromptTitle,
  validateScheduleTitle,
} from './schedule-title.js';

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
  it('leads with a prompt first sentence, bounded to a row', () => {
    expect(schedulePromptTitle("Summarize yesterday's merged PRs. Then group them."))
      .toBe("Summarize yesterday's merged PRs…");
    expect(schedulePromptTitle('Ping the Room.')).toBe('Ping the Room');
    expect(schedulePromptTitle('  ')).toBeUndefined();
    expect(schedulePromptTitle('x'.repeat(60))).toHaveLength(48);
  });
  it('names a row from the title, then the workflow, then the prompt', () => {
    expect(scheduleDisplayTitle({ title: 'Play downloads check', workflow: 'feedback-triage', prompt: 'x' }))
      .toBe('Play downloads check');
    expect(scheduleDisplayTitle({ title: null, workflow: 'feedback-triage', prompt: 'x' }))
      .toBe('Feedback triage');
    expect(scheduleDisplayTitle({ title: null, workflow: null, prompt: 'Ping the Room.' }))
      .toBe('Ping the Room');
    // Legacy rows stored the generic fallback as a real title.
    expect(scheduleDisplayTitle({ title: 'Scheduled task', workflow: null, prompt: 'Ping the Room.' }))
      .toBe('Ping the Room');
    expect(scheduleDisplayTitle({ title: 'Scheduled task', workflow: null, prompt: null }))
      .toBe('Scheduled task');
  });
});
