import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./chat/[channelId].tsx', import.meta.url), 'utf8');
const variants = readFileSync(new URL('./chat/RoomMessageVariants.tsx', import.meta.url), 'utf8');

describe('Room composer status layout', () => {
  const composerInput = source.slice(
    source.indexOf('              <TextInput'),
    source.indexOf('              <TouchableOpacity\n                style={[\n                  styles.sendButton'),
  );
  const inputStyle = source.slice(
    source.indexOf('    input: {'),
    source.indexOf('    sendButton: {'),
  );

  it('lets iOS use native line metrics for long composer text', () => {
    expect(inputStyle).toContain(
      "...Platform.select({ ios: {}, default: { lineHeight: 20 } })",
    );
    expect(inputStyle).not.toMatch(/^\s*lineHeight:\s*20,/m);
  });

  it('lets newline content drive the multiline input height', () => {
    expect(composerInput).toContain('style={styles.input}');
    expect(composerInput).toContain('multiline');
    expect(composerInput).not.toContain('numberOfLines=');
    expect(composerInput).not.toContain('height: composerHeight');
  });

  it('lets soft-wrapped content grow until the 120px scrolling cap', () => {
    expect(composerInput).toContain('onContentSizeChange={(event) => {');
    expect(composerInput).toContain(
      'Math.min(COMPOSER_MAX_HEIGHT, Math.max(COMPOSER_MIN_HEIGHT, contentHeight))',
    );
    expect(composerInput).toContain(
      'scrollEnabled={composerHeight >= COMPOSER_MAX_HEIGHT}',
    );
    expect(inputStyle).toContain('maxHeight: 120');
  });

  it('keeps turn progress inside the growing composer stack, above the field', () => {
    const inputBar = source.slice(source.indexOf('<View style={[styles.inputBar'));
    const progress = inputBar.indexOf('<TurnProgressLine');
    const composer = inputBar.search(/<View\s+style=\{\[\s*styles\.composer/);
    expect(progress).toBeGreaterThanOrEqual(0);
    expect(composer).toBeGreaterThan(progress);
  });

  it('uses a long-press wrapper to copy a complete turn', () => {
    expect(variants).toContain('onLongPress={onLongPress}');
    expect(variants).toContain('onCopy(message.text)');
    expect(source).toContain('copyEntireTurn(text, Clipboard.setStringAsync)');
  });
});
