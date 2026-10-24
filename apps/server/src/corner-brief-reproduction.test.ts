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
    ['**Reproduction R1:** steps fail', false],
    ['*Reproduction R1*: steps fail', false],
    ['__Reproduction R1:__ steps fail', false],
    ['_Reproduction R1_: steps fail', false],
    ['## Reproduction\nReproduction not feasible: reason\nStand-in: check', false],
    ['## Reproduction\nReproduction not feasible: reason Stand-in: check', false],
    ['## Reproduction\n**Reproduction not feasible:** reason\n\n**Stand-in:** check', false],
    ['Reproduction not feasible: reason', true],
    ['Reproduction not feasible: reason\n## Other\nStand-in: check', true],
    ['Stand-in: check\nReproduction not feasible: reason', true],
    ['Reproduction not feasible: \nStand-in: check', true],
    ['Reproduction not feasible: reason\nStand-in:', true],
    ['## Reproduction\nRun the revise tool with the brief; it loses the approval link.', false],
    ['## Reproduction R1\nThe revise call fails.', false],
    ['## Reproduction\n## Other\nUnrelated text', true],
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
