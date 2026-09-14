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

  it('does not activate controls for quoted, incomplete, or expanded prose', () => {
    expect(isCornerProposalText('I suggest: Proposed corner: Faster reads — Bound latency')).toBe(
      false,
    );
    expect(isCornerProposalText('Proposed corner: Faster reads')).toBe(false);
    expect(
      isCornerProposalText('Proposed corner: Faster reads — Bound latency\nWant me to proceed?'),
    ).toBe(false);
  });
});
