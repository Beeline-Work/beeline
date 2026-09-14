/**
 * The Room agent's proposal ceremony is intentionally one exact transcript
 * line. Keeping the matcher structural avoids turning quoted instructions or
 * an agent's surrounding explanation into live controls.
 */
export function isCornerProposalText(text: string): boolean {
  return /^Proposed corner: \S(?:[^\n]*\S)? — \S(?:[^\n]*\S)?$/u.test(text.trim());
}
