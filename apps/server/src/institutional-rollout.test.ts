import { describe, expect, it } from 'vitest';
import { rolloutAllowsJobs, rolloutAllowsLive } from './institutional-rollout.js';

describe('institutional memory rollout gates', () => {
  it('treats a Workspace with no rollout row as live', () => {
    expect(rolloutAllowsLive(undefined)).toBe(true);
    expect(rolloutAllowsJobs(undefined)).toBe(true);
  });

  it('keeps only off and paused as off switches', () => {
    for (const stage of ['off', 'paused'] as const) {
      expect(rolloutAllowsLive(stage)).toBe(false);
      expect(rolloutAllowsJobs(stage)).toBe(false);
    }
    for (const stage of ['shadow', 'pilot', 'live'] as const) {
      expect(rolloutAllowsJobs(stage)).toBe(true);
    }
    // `shadow` is measurement-only: jobs are allowed but live serving is not.
    expect(rolloutAllowsLive('shadow')).toBe(false);
    expect(rolloutAllowsLive('pilot')).toBe(true);
    expect(rolloutAllowsLive('live')).toBe(true);
  });
});
