import { describe, expect, it } from 'vitest';
import { inspectorCornerObjective } from './inspector-corners';

describe('inspectorCornerObjective', () => {
  it('returns the distinct objective and hides a missing or duplicate line', () => {
    expect(
      inspectorCornerObjective(
        'Desktop Update Diagnosis',
        'Find why desktop update stalls after the helper probe.',
      ),
    ).toBe('Find why desktop update stalls after the helper probe.');
    expect(inspectorCornerObjective('Desktop Update Diagnosis', undefined)).toBeUndefined();
    expect(inspectorCornerObjective('Desktop Update Diagnosis', '   ')).toBeUndefined();
    expect(
      inspectorCornerObjective('Desktop Update Diagnosis', 'Desktop Update Diagnosis'),
    ).toBeUndefined();
    expect(
      inspectorCornerObjective('Desktop Update Diagnosis', 'desktop update diagnosis'),
    ).toBeUndefined();
  });

  it('keeps a longer objective whose first words match the title', () => {
    expect(
      inspectorCornerObjective(
        'Rework the room',
        'Rework the room list so every corner row carries a state mark',
      ),
    ).toBe('Rework the room list so every corner row carries a state mark');
  });
});
