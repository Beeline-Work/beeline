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
  it('uses the layout-stable Android behavior for the room composer', () => {
    expect(chatSource).toContain(
      "behavior={Platform.OS === 'ios' ? 'padding' : 'translate-with-padding'}",
    );
    expect(chatSource).not.toContain("Platform.OS === 'ios' ? 'padding' : 'height'");
    expect(chatSource).toContain('contentContainerStyle={styles.messageListContent}');
    expect(chatSource).not.toContain('{ paddingBottom: 12 + keyboardHeight }');
  });

  it('does not render a decorative prefix inside the room composer', () => {
    expect(chatSource).not.toContain('styles.composerPrefix');
    expect(chatSource).not.toContain('styles.cornerComposerPrefix');
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
