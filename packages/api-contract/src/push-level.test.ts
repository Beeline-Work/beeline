import { describe, expect, it } from 'vitest';
import { DEFAULT_PUSH_LEVEL, PUSH_LEVELS, isPushLevel } from './push-level.js';

describe('push levels', () => {
  it('owns the complete vocabulary and Default default', () => {
    expect(PUSH_LEVELS).toEqual(['off', 'default', 'full']);
    expect(DEFAULT_PUSH_LEVEL).toBe('default');
    for (const level of PUSH_LEVELS) expect(isPushLevel(level)).toBe(true);
    expect(isPushLevel('full')).toBe(true);
    for (const retired of ['direct', 'mine', 'all', 'mentions'])
      expect(isPushLevel(retired)).toBe(false);
    expect(isPushLevel(null)).toBe(false);
  });
});
