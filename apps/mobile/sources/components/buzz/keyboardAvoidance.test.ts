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
    // The list is inverted (newest message at offset 0), so keyboard/composer
    // growth never needs a manual keyboardHeight content-padding hack or a
    // scrollToEnd simulation to keep the tail visible.
    expect(chatSource).toContain('inverted');
    // minIndexForVisible: 1 (not 0) — the newest slot is volatile (a fresh
    // send, then its optimistic-id -> real-id swap; an agent stream token),
    // so anchoring there instead of the row below it fights the reveal of
    // a just-sent message. autoscrollToTopThreshold makes offset 0 (visual
    // bottom, inverted) sticky instead, matching sources/components/ChatList.tsx.
    expect(chatSource).toContain('minIndexForVisible: 1');
    expect(chatSource).toContain('autoscrollToTopThreshold: 50');
    expect(chatSource).not.toContain('MESSAGE_LIST_PADDING');
    expect(chatSource).not.toContain('scrollToLatestMessage');
    expect(chatSource).not.toContain('handleMessageListLayout');
    expect(chatSource).not.toContain('handleMessageListContentSizeChange');
  });

  it('keeps active work outside a growing multiline composer', () => {
    const listEnd = chatSource.indexOf('        />\n\n        {!isArchived');
    const inputBar = chatSource.indexOf('<View style={[styles.inputBar');
    expect(listEnd).toBeGreaterThanOrEqual(0);
    expect(inputBar).toBeGreaterThan(listEnd);
    expect(chatSource.indexOf('testID="agent-live-status"')).toBeGreaterThan(listEnd);
    expect(chatSource.indexOf('testID="agent-live-status"')).toBeLessThan(inputBar);
  });

  it('does not rerender the transcript on a fixed presence clock', () => {
    expect(chatSource).not.toContain('setInterval(() => setPresenceNow(Date.now()), 5_000)');
    expect(chatSource).toContain('Presence only changes at a lease/grace deadline');
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
