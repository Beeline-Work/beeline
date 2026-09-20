import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./chat/_chat-surface.tsx', import.meta.url), 'utf8');
const variants = readFileSync(new URL('./chat/RoomMessageVariants.tsx', import.meta.url), 'utf8');
const ledger = readFileSync(
  new URL('../../../components/buzz/Ledger.tsx', import.meta.url),
  'utf8',
);
const composerSource = readFileSync(
  new URL('../../../components/buzz/ConversationComposer.tsx', import.meta.url),
  'utf8',
);

describe('Room composer status layout', () => {
  // The invariant is about the TextInput element itself; the region after it
  // (the listening interim overlay, added with speech input) is a Text.
  const composerInput = composerSource.slice(
    composerSource.indexOf('      <TextInput'),
    composerSource.indexOf('/>', composerSource.indexOf('      <TextInput')),
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
    expect(composerInput).toContain("Platform.OS === 'ios' ? undefined : { height, maxHeight }");
    expect(composerInput).toContain("Platform.OS === 'android' && styles.inputAndroid");
    expect(composerInput).toContain('multiline');
    expect(composerInput).not.toContain('numberOfLines=');
  });

  it('lets soft-wrapped content grow until the five-line scrolling cap', () => {
    expect(composerInput).toContain('onContentSizeChange={onContentSizeChange}');
    expect(source).toContain(
      'Math.min(COMPOSER_MAX_HEIGHT, Math.max(COMPOSER_MIN_HEIGHT, contentHeight))',
    );
    expect(composerInput).toContain('scrollEnabled={height >= maxHeight}');
    expect(source).toContain('maxHeight={COMPOSER_MAX_HEIGHT}');
    expect(composerSource).toContain(
      'export const COMPOSER_MAX_INPUT_HEIGHT = 5 * groknight.type.body.lineHeight',
    );
    expect(inputStyle).toContain('maxHeight: COMPOSER_MAX_INPUT_HEIGHT');
  });

  it('keeps turn progress inside the composer stack, above the field', () => {
    const inputBar = source.slice(source.indexOf('<Animated.View style={[styles.inputBar'));
    const progress = inputBar.indexOf('<TurnProgressLine');
    const composer = inputBar.indexOf('<ConversationComposer');
    expect(progress).toBeGreaterThanOrEqual(0);
    expect(composer).toBeGreaterThan(progress);
  });

  it('hangs the phone turn line over the transcript so it does not open a composer gap', () => {
    // The geometry itself is measured in `buzz/room-bottom-chrome.test.tsx`;
    // what this file holds is that the screen mounts that shared column
    // rather than a second hand-rolled copy of it.
    expect(source).toContain('const bottomChrome = roomBottomChromeStyles(groknight);');
    expect(source).toContain('hangingTurnChrome: bottomChrome.hangingTurnChrome,');
    expect(source).toContain('inputBar: bottomChrome.composerRow,');
    expect(source).toContain('styles.bottomChromeStack');
    const stack = source.slice(source.indexOf('styles.bottomChromeStack'));
    expect(stack.indexOf('hanging-turn-chrome')).toBeGreaterThanOrEqual(0);
    expect(stack.indexOf('hanging-turn-chrome')).toBeLessThan(stack.indexOf('<ConversationComposer'));
    const inputBar = source.slice(source.indexOf('<Animated.View style={[styles.inputBar'));
    expect(inputBar.indexOf('hanging-turn-chrome')).toBe(-1);
    expect(source).toContain('paddingTop: phoneTranscriptTailPadding({');
    // The pinned corner line is gone, so the offline hint is the only chrome
    // left that pushes the tail. The turn line lands directly on the
    // composer — measured in `buzz/room-bottom-chrome.test.tsx`.
    expect(source).toContain('pushedChromeVisible: agentsOffline');
    expect(source).not.toContain('CornerLiveBar');
  });

  it('keeps the Room header outside the Android keyboard translation surface', () => {
    const conversation = source.slice(
      source.indexOf('<View style={styles.desktopConversationFrame}>'),
    );
    const header = conversation.indexOf('{/* Header. No surface of its own');
    const keyboardSurface = conversation.indexOf('<KeyboardAvoidingView');

    expect(header).toBeGreaterThanOrEqual(0);
    expect(keyboardSurface).toBeGreaterThan(header);
  });

  it('keeps the send arrow separated from the text field', () => {
    const sendButtonStyle = composerSource.slice(
      composerSource.indexOf('  sendButton: {'),
      composerSource.indexOf('  sendButtonText: {'),
    );
    expect(sendButtonStyle).toContain('marginLeft: 8');
  });

  it('uses a long-press wrapper to copy a complete turn', () => {
    expect(variants).toContain('onLongPress={onLongPress}');
    expect(variants).toContain('onCopy(message.text)');
    expect(source).toContain('copyEntireTurn(text, Clipboard.setStringAsync)');
  });

  it('keeps desktop transcript rows out of transform-based inversion at every window width', () => {
    // Tauri's Windows shell is a web surface and can be resized below the
    // persistent-sidebar breakpoint. Transcript flow follows the platform,
    // not that width breakpoint, because variable-height inverted web rows
    // can retain stale transform coordinates and overlap.
    expect(source).toContain('const desktopTranscript = desktopExperience;');
    expect(source).not.toContain('const desktopTranscript = isDesktop;');
    expect(source).not.toContain("const desktopTranscript = Platform.OS === 'web';");
    expect(source).toContain('const transcriptMessages = desktopTranscript ? visibleMessages');
    expect(source).toContain('inverted={!desktopTranscript && transcriptMessages.length > 0}');
    expect(source).toContain('flatListRef.current?.scrollToEnd({ animated: false });');
    expect(source).toContain('desktopTranscript && styles.messageListContentDesktop');
  });

  it('keeps attachment and system-message height in the measured row flow', () => {
    const entry = ledger.slice(
      ledger.indexOf('export function LedgerEntry'),
      ledger.indexOf('export function LedgerSteer'),
    );
    const entryStyle = ledger.slice(
      ledger.indexOf('  entry: {'),
      ledger.indexOf('  entryWithByline: {'),
    );
    const systemLineStyle = ledger.slice(
      ledger.indexOf('  systemLine: {'),
      ledger.indexOf('  systemLineText: {'),
    );
    const attachmentStyle = variants.slice(
      variants.indexOf('  attachmentCard: {'),
      variants.indexOf('  attachmentThumbnail: {'),
    );

    // Attachments stay inside the message's measured outer row, and system
    // lines own a relative outer row. The timestamp may hang in its reserved
    // gutter, but neither variable-height row itself may be absolute.
    expect(entry).toContain('{attachments}');
    expect(entryStyle).toContain("width: '100%'");
    expect(entryStyle).not.toContain("position: 'absolute'");
    expect(attachmentStyle).toContain('minHeight: 58');
    expect(attachmentStyle).not.toContain("position: 'absolute'");
    expect(systemLineStyle).toContain("position: 'relative'");
    expect(systemLineStyle).toContain("width: '100%'");
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

describe('Room composer keyboard inset', () => {
  it('lets the full-screen avoiding view meet the keyboard without a fixed header offset', () => {
    expect(source).not.toContain('keyboardVerticalOffset=');
  });

  it('moves the safe-area inset with keyboard progress instead of snapping at event boundaries', () => {
    expect(source).toContain(
      'paddingBottom: composerBottomPadding(Platform.OS, insets.bottom, keyboardProgress.value)',
    );
    expect(source).toContain('<Animated.View style={[styles.inputBar, composerBottomInsetStyle]}>');
  });
});
