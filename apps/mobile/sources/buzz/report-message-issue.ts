import type { ReportMessageIssueInput, ReportMessageIssueResult } from '@beeline/api-contract/phone';

/** The note prompt's copy; the Hull input dialog paints it on every platform. */
export const REPORT_ISSUE_PROMPT = {
  title: 'Report issue',
  message: 'Send this message to the Beeline feedback loop. Add a note if it helps.',
  placeholder: 'What went wrong? (optional)',
  confirmText: 'Report',
  cancelText: 'Cancel',
} as const;

export type ReportMessageIssueOutcome =
  | { readonly status: 'cancelled' }
  | { readonly status: 'reported'; readonly duplicate: boolean }
  | { readonly status: 'failed'; readonly error: unknown };

/** The reporter's confirmation toast. A second report files nothing new. */
export function reportIssueToastCopy(duplicate: boolean): string {
  return duplicate ? 'Already reported' : 'Reported to Beeline';
}

/**
 * The Report issue action: ask for an optional note, then file the message
 * with `reportMessageIssue`. Cancelling the prompt files nothing; an empty or
 * blank note is sent as no note at all.
 */
export async function promptAndReportMessageIssue(
  target: { readonly roomId: string; readonly messageId: string },
  deps: {
    prompt(
      title: string,
      message: string,
      options: { placeholder: string; confirmText: string; cancelText: string },
    ): Promise<string | null>;
    report(input: ReportMessageIssueInput): Promise<ReportMessageIssueResult>;
  },
): Promise<ReportMessageIssueOutcome> {
  const { title, message, ...options } = REPORT_ISSUE_PROMPT;
  const answer = await deps.prompt(title, message, options);
  if (answer === null) return { status: 'cancelled' };
  const note = answer.trim();
  try {
    const result = await deps.report({
      roomId: target.roomId,
      messageId: target.messageId,
      ...(note ? { note } : {}),
    });
    return { status: 'reported', duplicate: result.duplicate };
  } catch (error) {
    return { status: 'failed', error };
  }
}
