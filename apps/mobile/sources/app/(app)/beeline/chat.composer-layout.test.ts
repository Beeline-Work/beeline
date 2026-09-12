import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./chat/[channelId].tsx', import.meta.url), 'utf8');
const variants = readFileSync(new URL('./chat/RoomMessageVariants.tsx', import.meta.url), 'utf8');
const composerSource = readFileSync(
  new URL('../../../components/buzz/ConversationComposer.tsx', import.meta.url),
  'utf8',
);

describe('Room composer status layout', () => {
  const composerInput = composerSource.slice(
    composerSource.indexOf('      <TextInput'),
    composerSource.indexOf('      <Pressable'),
  );
  const inputStyle = composerSource.slice(
    composerSource.indexOf('  input: {'),
    composerSource.indexOf('  sendButton: {'),
  );

  it('lets iOS use native line metrics for long composer text', () => {
    expect(inputStyle).toContain('...Platform.select({ ios: {}, default: { lineHeight: 20 } })');
    expect(inputStyle).not.toMatch(/^\s*lineHeight:\s*20,/m);
  });

  it('lets newline content drive the iOS input height without changing web sizing', () => {
    expect(composerInput).toContain(
      "style={[styles.input, Platform.OS === 'ios' ? undefined : { height, maxHeight }]}",
    );
    expect(composerInput).toContain('multiline');
    expect(composerInput).not.toContain('numberOfLines=');
  });

  it('lets soft-wrapped content grow until the 120px scrolling cap', () => {
    expect(composerInput).toContain('onContentSizeChange={onContentSizeChange}');
    expect(source).toContain(
      'Math.min(COMPOSER_MAX_HEIGHT, Math.max(COMPOSER_MIN_HEIGHT, contentHeight))',
    );
    expect(composerInput).toContain('scrollEnabled={height >= maxHeight}');
    expect(source).toContain('maxHeight={COMPOSER_MAX_HEIGHT}');
    expect(inputStyle).toContain('maxHeight: 120');
  });

  it('keeps turn progress inside the growing composer stack, above the field', () => {
    const inputBar = source.slice(source.indexOf('<View style={[styles.inputBar'));
    const progress = inputBar.indexOf('<TurnProgressLine');
    const composer = inputBar.indexOf('<ConversationComposer');
    expect(progress).toBeGreaterThanOrEqual(0);
    expect(composer).toBeGreaterThan(progress);
  });

  it('keeps the send arrow inset from the focus border', () => {
    const sendButtonStyle = composerSource.slice(
      composerSource.indexOf('  sendButton: {'),
      composerSource.indexOf('  sendButtonDisabled: {'),
    );
    expect(sendButtonStyle).toContain('marginRight: 4');
  });

  it('uses a long-press wrapper to copy a complete turn', () => {
    expect(variants).toContain('onLongPress={onLongPress}');
    expect(variants).toContain('onCopy(message.text)');
    expect(source).toContain('copyEntireTurn(text, Clipboard.setStringAsync)');
  });

  it('keeps desktop transcript rows out of transform-based inversion', () => {
    expect(source).toContain('const desktopTranscript = isDesktop;');
    expect(source).not.toContain("const desktopTranscript = Platform.OS === 'web';");
    expect(source).toContain('const transcriptMessages = desktopTranscript ? visibleMessages');
    expect(source).toContain('inverted={!desktopTranscript && transcriptMessages.length > 0}');
    expect(source).toContain('flatListRef.current?.scrollToEnd({ animated: false });');
    expect(source).toContain('desktopTranscript && styles.messageListContentDesktop');
  });
});

describe('Room composer keyboard dismissal', () => {
  const transcript = source.slice(
    source.indexOf('<FlatList'),
    source.indexOf('renderItem={renderItem}'),
  );

  it('lets a drag on the transcript put the keyboard away', () => {
    expect(transcript).toContain(
      'keyboardDismissMode={transcriptKeyboardDismissMode(Platform.OS)}',
    );
    // Taps that no row handles still reach the list, which blurs the composer.
    expect(transcript).toContain('keyboardShouldPersistTaps="handled"');
  });

  it('lets a tap on a transcript row put the keyboard away', () => {
    expect(source).toContain('onTapOutsideComposer={dismissComposerKeyboard}');
    expect(source).toContain(
      'const dismissComposerKeyboard = useCallback(() => {\n    Keyboard.dismiss();\n  }, []);',
    );
    expect(variants).toContain('onPress={onPress}');
  });
});
