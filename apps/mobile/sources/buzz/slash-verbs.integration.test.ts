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

  it('opens the palette after an @agent mention and renders THAT agent\'s published commands', () => {
    // The mention-scoped query detects `@agent /query` at the composer tail.
    expect(chatSource).toContain('agentMentionSlashQuery(inputText)');
    // The addressed agent's commands are read from the relay record — the only
    // source — never a hardcoded inventory.
    expect(chatSource).toContain(
      'agentCommandsRead(decodedId, pubkey, activeCommunityId ?? undefined)',
    );
    expect(chatSource).not.toMatch(/commands:\s*\[\s*\{\s*name:\s*'/);
    // The picker receives both the agent's list and Beeline's built-ins.
    expect(chatSource).toContain('commands={mentionAgentCommands}');
  });

  it('selecting an advertised command inserts it after the mention, keeping the mention', () => {
    const insertStart = chatSource.indexOf('const insertAgentCommand');
    const insertEnd = chatSource.indexOf('\n  );', insertStart);
    const insertBlock = chatSource.slice(insertStart, insertEnd);
    // The typed /token is replaced in place; the @mention prefix survives.
    expect(insertBlock).toContain("inputText.replace(/\\/[a-z0-9-]*$/i");
    expect(insertBlock).not.toContain('clearSlashComposer()');
  });

  it('states honestly when a harness does not advertise commands', () => {
    expect(pickerSource).toContain('slash-agent-no-commands');
    expect(pickerSource).toContain('DOES NOT ADVERTISE COMMANDS');
    // Unknown is not absent: the quiet state renders only once the read resolved.
    expect(chatSource).toContain('agentCommandsByScope[mentionAgentCommandScope] !== undefined');
    const readStart = chatSource.indexOf('.agentCommandsRead(decodedId');
    const readEnd = chatSource.indexOf('\n  }, [', readStart);
    const readBlock = chatSource.slice(readStart, readEnd);
    expect(readBlock).toContain('A transport failure is not evidence that no record exists');
    expect(readBlock.match(/setAgentCommandsByScope/g)).toHaveLength(1);
  });
});
