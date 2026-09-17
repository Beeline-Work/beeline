import { describe, expect, it } from 'vitest';
import { typeRoles } from './groknight';
import { emojiTextStyle } from './emoji-text';

describe('emojiTextStyle', () => {
  // The Android clip: an explicit lineHeight sizes the line box from the first
  // font alone, so the fallback emoji glyph loses its top. The style must not
  // carry one at all — the test pins absence, not a tuned number.
  it('keeps the role sizing and drops lineHeight entirely', () => {
    const style = emojiTextStyle(typeRoles.body);
    expect(style.fontSize).toBe(typeRoles.body.fontSize);
    expect(style.fontFamily).toBe(typeRoles.body.fontFamily);
    expect(style.letterSpacing).toBe(typeRoles.body.letterSpacing);
    expect('lineHeight' in style).toBe(false);
    expect(style.lineHeight).toBeUndefined();
  });

  it('accepts any role unchanged apart from the lineHeight', () => {
    const style = emojiTextStyle(typeRoles.hero);
    expect(style.fontSize).toBe(22);
    expect('lineHeight' in style).toBe(false);
  });
});
