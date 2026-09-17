import type { TypeRole } from './groknight';

/**
 * The one derivation for an emoji-only `Text` style, taken from a type role.
 *
 * The `lineHeight` is deliberately absent — not merely larger. On Android,
 * `CustomLineHeightSpan` (react-native, ReactAndroid …/views/text/internal/span)
 * implements the W3C inline-height model: an explicit `lineHeight` sizes the
 * line box from the FIRST font's metrics alone, "ignoring glyphs from other
 * fonts", so a fallback emoji glyph taller than that box loses its top at the
 * Text view's top edge. Reaction chips (19px), the strip (22px), and even the
 * theme's calm 23px all sit under the ~1.17em box Android's emoji font needs,
 * which is why every tuned value still clipped. Without the span the line
 * merges every run's metrics, so the fallback emoji font's own ascent+descent
 * — which by definition contains the glyph — sizes the box instead.
 *
 * Web and PC (react-native-web) never clip: `line-height` leaves overflow ink
 * visible, and the strip's choices, the quick picker's cells, and the reaction
 * chips all size themselves from their own minHeight, so nothing shifts there.
 * If an emoji-only `Text` ever needs a bigger glyph than `body`, give this
 * function an argument, never a `lineHeight` back.
 */
export function emojiTextStyle(role: TypeRole): Omit<TypeRole, 'lineHeight'> {
  const { lineHeight: _off, ...withoutLineHeight } = role;
  return withoutLineHeight;
}
