import { describe, expect, it, vi } from 'vitest';

import {
  promptAndReportMessageIssue,
  REPORT_ISSUE_PROMPT,
  reportIssueToastCopy,
} from './report-message-issue';

const target = { roomId: 'room-1', messageId: 'msg-7' };

function deps(answer: string | null, report = vi.fn(async () => ({ itemId: 'fb-1', duplicate: false }))) {
  return { prompt: vi.fn(async () => answer), report };
}

describe('Report issue', () => {
  it('asks for an optional note, then calls reportMessageIssue with it', async () => {
    const d = deps('  The summary skipped the failing test.  ');
    await expect(promptAndReportMessageIssue(target, d)).resolves.toEqual({
      status: 'reported',
      duplicate: false,
    });
    expect(d.prompt).toHaveBeenCalledWith(REPORT_ISSUE_PROMPT.title, REPORT_ISSUE_PROMPT.message, {
      placeholder: REPORT_ISSUE_PROMPT.placeholder,
      confirmText: 'Report',
      cancelText: 'Cancel',
    });
    expect(d.report).toHaveBeenCalledWith({
      roomId: 'room-1',
      messageId: 'msg-7',
      note: 'The summary skipped the failing test.',
    });
  });

  it('sends no note when the field is left blank', async () => {
    const d = deps('   ');
    await promptAndReportMessageIssue(target, d);
    expect(d.report).toHaveBeenCalledWith({ roomId: 'room-1', messageId: 'msg-7' });
  });

  it('files nothing when the prompt is cancelled', async () => {
    const d = deps(null);
    await expect(promptAndReportMessageIssue(target, d)).resolves.toEqual({ status: 'cancelled' });
    expect(d.report).not.toHaveBeenCalled();
  });

  it('passes a duplicate through and hands a refusal back to the caller', async () => {
    const duplicate = deps('', vi.fn(async () => ({ itemId: 'fb-1', duplicate: true })));
    await expect(promptAndReportMessageIssue(target, duplicate)).resolves.toEqual({
      status: 'reported',
      duplicate: true,
    });

    const refusal = new Error('note looks like a secret');
    const failed = deps(
      'sk-live',
      vi.fn(async () => {
        throw refusal;
      }),
    );
    await expect(promptAndReportMessageIssue(target, failed)).resolves.toEqual({
      status: 'failed',
      error: refusal,
    });
  });

  it('confirms with Reported to Beeline, or Already reported for a repeat', () => {
    expect(reportIssueToastCopy(false)).toBe('Reported to Beeline');
    expect(reportIssueToastCopy(true)).toBe('Already reported');
  });
});
