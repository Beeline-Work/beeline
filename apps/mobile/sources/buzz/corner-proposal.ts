/**
 * The Room agent's proposal ceremony is one exact transcript line followed
 * only by the triage skill's bounded warning vocabulary. Keeping the matcher
 * structural avoids turning quoted instructions or surrounding explanation
 * into live controls.
 */
export function isCornerProposalText(text: string): boolean {
  const lines = text.trim().split(/\r?\n/u);
  while (
    lines.length > 1 &&
    /^Triage warning — (?:warranted|desirable): \S(?:[^\n]*\S)?$/u.test(lines.at(-1) ?? '')
  ) {
    lines.pop();
  }
  return (
    lines.length === 1 &&
    /^Proposed corner: \S(?:[^\n]*\S)? — \S(?:[^\n]*\S)?$/u.test(lines[0] ?? '')
  );
}
