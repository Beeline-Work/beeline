/**
 * The Feedback triage row on a corner's … sheet. Only a Room admin sees it:
 * the server refuses anyone else's change (`setCornerFeedbackTriage`), so a
 * member is never offered a switch that cannot work.
 */
export function cornerFeedbackTriageRow(input: {
  readonly isCorner: boolean;
  readonly viewerIsAgent: boolean;
  readonly canManageWorkspace: boolean;
  readonly enabled: boolean | undefined;
}): { readonly value: boolean } | null {
  if (!input.isCorner || input.viewerIsAgent || !input.canManageWorkspace) return null;
  return { value: input.enabled === true };
}

export const CORNER_FEEDBACK_TRIAGE_DESCRIPTION =
  'Agents here can triage Beeline feedback into GitHub issues and open fix corners in the Room.';
