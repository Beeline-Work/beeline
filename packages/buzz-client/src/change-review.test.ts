import { describe, expect, it } from 'vitest';
import { parseChangeReviewGenerationComplete } from './change-review.js';

describe('change review generation completion', () => {
  it('requires a non-empty summary and complete generation counts', () => {
    const base = 'a'.repeat(40);
    const tip = 'b'.repeat(40);
    const patchId = 'c'.repeat(40);
    expect(
      parseChangeReviewGenerationComplete(
        JSON.stringify({
          version: 1,
          base,
          tip,
          patchId,
          summary: 'Update review continuity',
          manifestChunks: 2,
          fileCount: 101,
        }),
      ),
    ).toMatchObject({ summary: 'Update review continuity', manifestChunks: 2, fileCount: 101 });
    expect(
      parseChangeReviewGenerationComplete(
        JSON.stringify({
          version: 1,
          base,
          tip,
          patchId,
          summary: '   ',
          manifestChunks: 2,
          fileCount: 101,
        }),
      ),
    ).toBeNull();
  });
});
