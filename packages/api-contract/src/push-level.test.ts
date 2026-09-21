import { describe, expect, it } from 'vitest';
import { DEFAULT_PUSH_LEVEL, PUSH_LEVELS, isPushLevel } from './push-level.js';

describe('push levels', () => {
  it('owns the complete vocabulary and mine default', () => {
    expect(PUSH_LEVELS).toEqual(['off', 'direct', 'mine']);
    expect(DEFAULT_PUSH_LEVEL).toBe('mine');
    for (const level of PUSH_LEVELS) expect(isPushLevel(level)).toBe(true);
    expect(isPushLevel('all')).toBe(false);
    expect(isPushLevel('mentions')).toBe(false);
    expect(isPushLevel(null)).toBe(false);
  });
});
