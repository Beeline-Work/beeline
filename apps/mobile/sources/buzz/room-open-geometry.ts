import { groknight } from './groknight';
import { composerBottomPadding } from './composer-keyboard';

/**
 * Thin Room-open paint reserves the same bottom stack chrome will mount, so
 * the newest row does not jump when the 6k module replaces the shell.
 *
 * Tokens are the chrome styles, not ConversationComposer’s 26px single-line
 * input height. Keep this module free of that component so the route shell
 * does not pull speech-input onto the first-paint graph.
 */

/** `phoneTranscriptTailPadding` — the inverted phone list's visual tail.
 *  A speaker-change margin is 24px; the newest row contributes 6px of its own
 *  bottom padding, so the tail carries the other 18. See
 *  `buzz/room-scroll-follow.ts` for why this never steps with the turn line. */
export const ROOM_OPEN_LIST_TAIL_PADDING = 18;
/** `inputBar.paddingTop`. */
export const ROOM_OPEN_INPUT_BAR_PADDING_TOP = 8;
/** `inputBar.borderTopWidth`. */
export const ROOM_OPEN_INPUT_BAR_BORDER_TOP = 1;
/** ConversationComposer `composer.minHeight`. */
export const ROOM_OPEN_COMPOSER_BOX_MIN_HEIGHT = 44;
/** ConversationComposer `composer.borderWidth`. */
export const ROOM_OPEN_COMPOSER_BOX_BORDER = 1;

/**
 * Ledger `entry.paddingBottom` — the newest committed agent row's own visual
 * bottom padding. The speaker-change air now sits on the incoming row's
 * visual TOP (`entryWithByline.paddingTop`), so every row's tail edge is the
 * ordinary compact 6px and the list's tail padding supplies the rest of the
 * 24px speaker-change margin.
 */
export function roomOpenMessagePadding(): number {
  return groknight.messagePaddingVertical;
}

/** Ledger `ledgerText` / `steerText`. `type.body` uses lineHeight 23; chrome is 25. */
export function roomOpenNewestTextMetrics(): {
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
} {
  return {
    fontFamily: groknight.proseRegular,
    fontSize: groknight.proseSize,
    lineHeight: groknight.proseLineHeight,
  };
}

/** Closed-keyboard padding under the composer box (same worklet chrome uses). */
export function roomOpenComposerSafePadding(os: string, safeAreaBottom: number): number {
  return composerBottomPadding(os, safeAreaBottom, 0);
}

/** Height of the chrome column below the newest glyph, including the nav inset. */
export function roomOpenBottomChromeHeight(os: string, safeAreaBottom: number): number {
  return (
    ROOM_OPEN_LIST_TAIL_PADDING +
    roomOpenMessagePadding() +
    ROOM_OPEN_INPUT_BAR_PADDING_TOP +
    ROOM_OPEN_INPUT_BAR_BORDER_TOP +
    ROOM_OPEN_COMPOSER_BOX_MIN_HEIGHT +
    ROOM_OPEN_COMPOSER_BOX_BORDER * 2 +
    roomOpenComposerSafePadding(os, safeAreaBottom)
  );
}
