import { describe, expect, it } from 'vitest';

import { isCornerProposalText } from './corner-proposal';

describe('corner proposal transcript lines', () => {
  it('recognizes the exact one-line proposal ceremony', () => {
    expect(
      isCornerProposalText('Proposed corner: Faster reads — Bound query latency under load'),
    ).toBe(true);
    expect(
      isCornerProposalText('  Proposed corner: Faster reads — Use the edited objective  '),
    ).toBe(true);
  });

  it('keeps controls active with only trailing triage warnings', () => {
    expect(
      isCornerProposalText(
        'Proposed corner: Faster reads — Bound query latency under load\nTriage warning — warranted: A related pull request may already cover this behavior',
      ),
    ).toBe(true);
    expect(
      isCornerProposalText(
        'Proposed corner: Faster reads — Bound query latency under load\r\nTriage warning — warranted: The bug did not reproduce\r\nTriage warning — desirable: No product direction covers this behavior',
      ),
    ).toBe(true);
  });

  it('does not activate controls for quoted, incomplete, or expanded prose', () => {
    expect(isCornerProposalText('I suggest: Proposed corner: Faster reads — Bound latency')).toBe(
      false,
    );
    expect(isCornerProposalText('Proposed corner: Faster reads')).toBe(false);
    expect(
      isCornerProposalText('Proposed corner: Faster reads — Bound latency\nWant me to proceed?'),
    ).toBe(false);
    expect(
      isCornerProposalText(
        'Proposed corner: Faster reads — Bound latency\nTriage warning — priority: This is not a supported warning',
      ),
    ).toBe(false);
    expect(
      isCornerProposalText(
        'Proposed corner: Faster reads — Bound latency\nTriage warning — warranted:',
      ),
    ).toBe(false);
    expect(
      isCornerProposalText(
        'Proposed corner: Faster reads — Bound latency\nTriage warning — warranted: A related change exists\nWant me to proceed?',
      ),
    ).toBe(false);
  });
});
