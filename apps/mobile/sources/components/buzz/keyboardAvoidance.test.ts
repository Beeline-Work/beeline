import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const chatSource = readFileSync(
  new URL('../../app/(app)/buzz/chat/[channelId].tsx', import.meta.url),
  'utf8',
);
const agentsSource = readFileSync(
  new URL('../../app/(app)/buzz/agents.tsx', import.meta.url),
  'utf8',
);

describe('Buzz keyboard avoidance', () => {
  it('keeps the latest room message above the Android keyboard', () => {
    expect(chatSource).toContain(
      "behavior={Platform.OS === 'ios' ? 'padding' : 'translate-with-padding'}",
    );
    expect(chatSource).not.toContain("Platform.OS === 'ios' ? 'padding' : 'height'");
    expect(chatSource).toContain('const MESSAGE_LIST_PADDING = 12;');
    expect(chatSource).toContain('contentContainerStyle={[');
    expect(chatSource).toContain(
      'keyboardHeight > 0 && { paddingBottom: MESSAGE_LIST_PADDING + keyboardHeight }',
    );
    expect(chatSource).toContain('[80, 260, 520].map((delay, index)');
  });

  it('keeps focused Agent fields visible in keyboard-aware scroll content', () => {
    expect(agentsSource).toContain(
      "import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';",
    );
    expect(agentsSource).toContain('<KeyboardAwareScrollView');
    expect(agentsSource).toContain('bottomOffset={16}');
    expect(agentsSource).toContain('</KeyboardAwareScrollView>');
  });
});
