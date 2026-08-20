import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

const chatSource = fs.readFileSync(
  new URL('../app/(app)/buzz/chat/[channelId].tsx', import.meta.url),
  'utf8',
);
const pickerSource = fs.readFileSync(
  new URL('../components/buzz/SlashVerbPicker.tsx', import.meta.url),
  'utf8',
);

function slashDispatchCase(id: string): string {
  const start = chatSource.indexOf(`case '${id}':`);
  const nextCase = chatSource.indexOf('\n        case ', start + 1);
  return chatSource.slice(start, nextCase < 0 ? undefined : nextCase);
}

describe('Buzz composer slash picker integration', () => {
  it('is composer-native and has no web-only platform gate', () => {
    expect(chatSource).toContain('<SlashVerbPicker');
    expect(pickerSource).toContain('testID="slash-verb-picker"');
    expect(pickerSource).toContain('keyboardShouldPersistTaps="handled"');
    expect(pickerSource).not.toContain("Platform.OS === 'web'");
  });

  it('dispatches through the same handlers as the existing controls', () => {
    expect(slashDispatchCase('open-corner')).toContain(
      "handleWritePermission(pendingCornerRequest, 'allow')",
    );
    expect(slashDispatchCase('close-corner')).toContain('handleCloseCorner()');
    expect(slashDispatchCase('approve')).toContain('handleApprove()');
    expect(slashDispatchCase('change-target-branch')).toContain(
      'handleConfirmTargetBranch(pendingTargetBranchProposal)',
    );
    expect(slashDispatchCase('add-agent')).toContain("setParticipantPickerKind('agent')");
    expect(slashDispatchCase('invite')).toContain("setParticipantPickerKind('person')");
  });

  it('supports tap, hardware keyboard selection, and dismissal without submit', () => {
    expect(pickerSource).toContain('onPress={() => onSelect(verb.id)}');
    expect(chatSource).toContain("action === 'next' || action === 'previous'");
    expect(chatSource).toContain('mentionKeyboardAction(event.nativeEvent.key)');
    expect(chatSource).toContain('dismissSlashMenu();');

    const dismissStart = chatSource.indexOf('const dismissSlashMenu');
    const dismissEnd = chatSource.indexOf('\n  );', dismissStart);
    expect(chatSource.slice(dismissStart, dismissEnd)).not.toContain('handleSend');
    expect(chatSource.slice(dismissStart, dismissEnd)).not.toContain('messageSubmit');
  });
});
