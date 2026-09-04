import { describe, expect, it } from 'vitest';
import {
  advanceStream,
  mixHex,
  openStream,
  pendingTailLength,
  type StreamState,
} from './streaming-prose';

/**
 * The honesty rules of the provisional lane (C98). Nothing here renders: these
 * are the two promises the arithmetic itself has to keep — the reader is never
 * shown a character the model has not produced, and text already read never
 * animates again.
 */
describe('streaming prose', () => {
  it('opens with everything pending, and with nothing pending under reduced motion', () => {
    expect(openStream('Working on it', true)).toEqual({
      text: 'Working on it',
      settled: 0,
      progress: 0,
    });
    expect(openStream('Working on it', false)).toEqual({
      text: 'Working on it',
      settled: 13,
      progress: 1,
    });
  });

  it('pends only the appended characters, never the ones already read', () => {
    const first = openStream('The answer', true);
    const grown = advanceStream(first, 'The answer is', true);
    expect(grown.text).toBe('The answer is');
    expect(grown.settled).toBe(0);
    expect(pendingTailLength(grown)).toBe(13);

    const settled: StreamState = { text: 'The answer', settled: 10, progress: 1 };
    const next = advanceStream(settled, 'The answer is', true);
    expect(next.settled).toBe(10);
    expect(pendingTailLength(next)).toBe(3);
    // A settled lane opens its new window at the ground, so the arriving tail
    // never flashes at full tone before it fades.
    expect(next.progress).toBe(0);
  });

  it('lets characters that land mid-window join the window already running', () => {
    const running: StreamState = { text: 'The answer', settled: 4, progress: 0.5 };
    const next = advanceStream(running, 'The answer is', true);
    expect(next.progress).toBe(0.5);
    expect(pendingTailLength(next)).toBe(9);
  });

  it('settles a rewrite whole — replaced text has not just arrived', () => {
    const running: StreamState = { text: 'The answer is 41', settled: 0, progress: 0.25 };
    const next = advanceStream(running, 'The answer is 42', true);
    expect(next).toEqual({ text: 'The answer is 42', settled: 16, progress: 1 });
    expect(pendingTailLength(next)).toBe(0);
  });

  it('never animates at all when motion is reduced', () => {
    const state = advanceStream(openStream('One', false), 'One two', false);
    expect(state).toEqual({ text: 'One two', settled: 7, progress: 1 });
    expect(pendingTailLength(state)).toBe(0);
  });

  it('is a no-op when the same text arrives twice', () => {
    const state = openStream('Same', true);
    expect(advanceStream(state, 'Same', true)).toBe(state);
  });

  it('walks a colour from the ground to the tone and clamps at both ends', () => {
    expect(mixHex('#000000', '#ffffff', 0)).toBe('#000000');
    expect(mixHex('#000000', '#ffffff', 1)).toBe('#ffffff');
    expect(mixHex('#000000', '#ffffff', 0.5)).toBe('#808080');
    expect(mixHex('#14091a', '#83838d', -1)).toBe('#14091a');
    expect(mixHex('#14091a', '#83838d', 2)).toBe('#83838d');
  });
});
