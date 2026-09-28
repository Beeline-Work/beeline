export type CornerProposal = {
  title: string;
  objective: string;
  warnings: string[];
};

const WARNING_LINE = /^Triage warning — (?:warranted|desirable): \S(?:[^\n]*\S)?$/u;
const PROPOSAL_LINE = /^Proposed corner: (\S(?:[^\n]*?\S)?) — (\S(?:[^\n]*\S)?)$/u;

/**
 * The Room agent's proposal ceremony is one exact transcript line followed
 * only by the triage skill's bounded warning vocabulary. Keeping the matcher
 * structural avoids turning quoted instructions or surrounding explanation
 * into live controls.
 */
export function parseCornerProposal(text: string): CornerProposal | null {
  const lines = text.trim().split(/\r?\n/u);
  const warnings: string[] = [];
  while (lines.length > 1 && WARNING_LINE.test(lines.at(-1) ?? '')) {
    warnings.unshift(lines.pop()!);
  }
  if (lines.length !== 1) return null;
  const match = PROPOSAL_LINE.exec(lines[0] ?? '');
  return match ? { title: match[1]!, objective: match[2]!, warnings } : null;
}

/** The proposal card's two choices send these exact replies. */
export function cornerProposalDecision(replyText: string): 'open' | 'cancel' | null {
  const reply = replyText.trim().toLowerCase();
  return reply === 'go' ? 'open' : reply === 'cancel' ? 'cancel' : null;
}
