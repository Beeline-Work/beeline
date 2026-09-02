import { describe, expect, it } from 'vitest';
import {
  SPINNER_FRAMES,
  SPINNER_STEP_MS,
  TURN_VERBS,
  elapsedSeconds,
  formatSettledLine,
  pickTurnVerb,
  spinnerFrameAt,
  spinnerFrameIndexAt,
} from './turn-clock';

describe('the thinking clock', () => {
  it('walks the spinner frames forward, then bounces back', () => {
    expect(spinnerFrameIndexAt(0)).toBe(0);
    expect(spinnerFrameIndexAt(SPINNER_STEP_MS * 1)).toBe(1);
    expect(spinnerFrameIndexAt(SPINNER_STEP_MS * 5)).toBe(5);
    // One past the last forward frame turns around.
    expect(spinnerFrameIndexAt(SPINNER_STEP_MS * 6)).toBe(4);
    expect(spinnerFrameIndexAt(SPINNER_STEP_MS * 9)).toBe(1);
    expect(spinnerFrameIndexAt(SPINNER_STEP_MS * 10)).toBe(0);
    // And the cycle repeats.
    expect(spinnerFrameIndexAt(SPINNER_STEP_MS * 10 + SPINNER_STEP_MS * 5)).toBe(5);
  });

  it('never leaves the frame list, even for absurd elapsed times', () => {
    for (let seconds = 0; seconds < 600; seconds += 7) {
      const index = spinnerFrameIndexAt(seconds * 1_000);
      expect(index).toBeGreaterThanOrEqual(0);
      expect(index).toBeLessThan(SPINNER_FRAMES.length);
      expect(SPINNER_FRAMES).toContain(spinnerFrameAt(seconds * 1_000));
    }
  });

  it('picks one verb per turn key, and different turns can differ', () => {
    const verb = pickTurnVerb('agent-a:req-1');
    expect(TURN_VERBS).toContain(verb);
    // Never per tick: the same turn always draws the same verb.
    expect(pickTurnVerb('agent-a:req-1')).toBe(verb);
    // Across many turns every verb is reachable.
    const picked = new Set(
      Array.from({ length: 200 }, (_, index) => pickTurnVerb(`agent-a:req-${index}`).gerund),
    );
    expect(picked.size).toBe(TURN_VERBS.length);
  });

  it('counts whole seconds from the receipt time, floored at zero', () => {
    expect(elapsedSeconds(10_000, 10_900)).toBe(0);
    expect(elapsedSeconds(10_000, 11_000)).toBe(1);
    expect(elapsedSeconds(10_000, 25_400)).toBe(15);
    // A skewed clock must not show negative seconds.
    expect(elapsedSeconds(10_000, 9_000)).toBe(0);
  });

  it('settles to "<Past> for Ns · done h:MM"', () => {
    const line = formatSettledLine({ gerund: 'Brewing', past: 'Brewed' }, 0, 14_000);
    expect(line).toMatch(/^Brewed for 14s \u00b7 done \d{1,2}:\d{2} (am|pm)$/);
  });
});
