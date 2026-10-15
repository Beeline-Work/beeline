import { describe, expect, it } from 'vitest';
import { validateCornerBrief } from './corner-brief.js';
const brief = (spec: string, repositoryWork = true) => ({
  spec,
  repositoryWork,
  approval: { sourceMessageId: 'human-message' },
});
describe('repository bugfix reproduction flag', () => {
  it.each([
    ['Reproduction upload-1: A real Dreamina upload in Squire fails with a 403.', false],
    [
      'Reproduction not feasible: No authorized Dreamina account; Stand-in: upload the same fixture through the authenticated adapter.',
      false,
    ],
    ['', true],
  ])(
    'flags only a missing real-target reproduction or explained stand-in: %s',
    (proof, flagged) => {
      expect(
        validateCornerBrief(brief(`## Intent\nFix the reported upload bug.\n${proof}`), true)
          .length > 0,
      ).toBe(flagged);
    },
  );
  it('leaves features, refactors, designs, no-PR and repo-less briefs alone', () => {
    for (const intent of [
      'Add a new feature.',
      'Add a button to fix formatting.',
      'Refactor the uploader.',
      'Design only.',
    ])
      expect(validateCornerBrief(brief(`## Intent\n${intent}`), true)).toEqual([]);
    expect(validateCornerBrief(brief('Fix upload', false), true)).toEqual([]);
    expect(validateCornerBrief(brief('Fix upload'), false)).toEqual([]);
  });
});
