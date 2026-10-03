import { describe, expect, it } from 'vitest';
import { rolloutAllowsLive } from './institutional-rollout.js';

describe('institutional memory rollout gates', () => {
  it('treats a Workspace with no rollout row as live', () => {
    expect(rolloutAllowsLive(undefined)).toBe(true);
  });

  it('keeps only off and paused as off switches', () => {
    for (const stage of ['off', 'paused'] as const) {
      expect(rolloutAllowsLive(stage)).toBe(false);
    }
    // `shadow` is measurement-only: live serving is not allowed.
    expect(rolloutAllowsLive('shadow')).toBe(false);
    expect(rolloutAllowsLive('pilot')).toBe(true);
    expect(rolloutAllowsLive('live')).toBe(true);
  });
});
