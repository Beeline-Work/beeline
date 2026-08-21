import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./chat/[channelId].tsx', import.meta.url), 'utf8');

describe('Room composer status layout', () => {
  it('keeps turn progress inside the growing composer stack, above the field', () => {
    const inputBar = source.slice(source.indexOf('<View style={[styles.inputBar'));
    const progress = inputBar.indexOf('<TurnProgressLine');
    const composer = inputBar.search(/<View\s+style=\{\[\s*styles\.composer/);
    expect(progress).toBeGreaterThanOrEqual(0);
    expect(composer).toBeGreaterThan(progress);
  });

  it('uses a long-press wrapper to copy a complete turn', () => {
    expect(source).toContain('onLongPress={onLongPress}');
    expect(source).toContain('copyEntireTurn(item.text, Clipboard.setStringAsync)');
  });
});
