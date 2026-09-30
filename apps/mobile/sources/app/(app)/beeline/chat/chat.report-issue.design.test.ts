import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * The feedback loop's human path on the chat surface: `@system` in the mention
 * menu and Report issue on the message sheet. This screen has no render
 * harness, so the wiring is checked as source text — the technique
 * `chat.actions-sheet.design.test` uses here. The behaviour behind each hook
 * is tested where it lives (room-participants, report-message-issue,
 * MentionSuggestionMenu, RoomMessageVariants, Ledger).
 */
const chat = readFileSync(new URL('./_chat-surface.tsx', import.meta.url), 'utf8');

function slice(from: string, to: string): string {
  const start = chat.indexOf(from);
  expect(start, `missing ${from}`).toBeGreaterThanOrEqual(0);
  const end = chat.indexOf(to, start);
  expect(end, `unclosed ${from}`).toBeGreaterThan(start);
  return chat.slice(start, end);
}

describe('Report issue on the chat surface', () => {
  it('offers @system in every conversation’s mention menu without binding a pubkey', () => {
    expect(chat).toContain(
      '() => [CHANNEL_MENTION_OPTION, ...roomParticipants, SYSTEM_MENTION_OPTION]',
    );
    const selectMention = slice('const selectMention = useCallback(', '[activeMention]');
    expect(selectMention).toContain('recordMentionPick(selectedMentionsRef.current, participant)');
    expect(selectMention).not.toContain('selectedMentionsRef.current.set(');
  });

  it('puts Report issue on the message sheet and files it with reportMessageIssue', () => {
    const sheet = slice('testID="message-actions-sheet"', '</HullActionSheetModal>');
    const anchor = sheet.indexOf('testID="message-report-action"');
    expect(anchor).toBeGreaterThanOrEqual(0);
    const row = sheet.slice(sheet.lastIndexOf('<HullActionSheetRow', anchor), anchor);
    expect(row).toContain('label="Report issue"');
    expect(row).toContain('handleReportMessage(target)');

    const handler = slice('const handleReportMessage = useCallback(', 'const canDeleteMessage');
    expect(handler).toContain("monolithPhoneOperation('reportMessageIssue', input)");
    expect(handler).toContain('Modal.prompt(');
    expect(handler).toContain('showReportToast(copy)');
    expect(handler).toContain("Modal.alert('Could not report message'");
    // Optimistic: the Reported marker lands before the next read.
    expect(handler).toContain('setOptimisticReports(');
    expect(chat).toContain('onReportIssue={handleReportMessage}');
    expect(chat).toContain('feedbackReported: messageIsReported(item)');
  });
});

describe('Feedback triage on the corner … sheet', () => {
  it('offers the switch only through cornerFeedbackTriageRow and saves it with setCornerFeedbackTriage', () => {
    const sheet = slice('testID="corner-actions-sheet"', '</HullActionSheetModal>');
    const anchor = sheet.indexOf('testID="corner-feedback-triage-toggle"');
    expect(anchor).toBeGreaterThanOrEqual(0);
    expect(sheet.slice(0, anchor)).toContain('{feedbackTriageRow && (');
    const row = sheet.slice(sheet.lastIndexOf('<HullActionSheetRow', anchor), anchor);
    expect(row).toContain('label="Feedback triage"');

    const gate = slice('const feedbackTriageRow = cornerFeedbackTriageRow({', '});');
    expect(gate).toContain('canManageWorkspace');
    expect(gate).toContain('enabled: roomSurface?.cornerFeedbackTriage');
    const handler = slice(
      'const handleToggleFeedbackTriage = useCallback(',
      'const handleCloseCorner',
    );
    expect(handler).toContain("monolithPhoneOperation('setCornerFeedbackTriage', {");
    expect(handler).toContain('enabled: !feedbackTriageRow.value');
    expect(handler).toContain("Modal.alert('Could not change Feedback triage'");
  });
});
