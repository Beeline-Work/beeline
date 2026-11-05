import { space } from './groknight';

/** Shared row geometry also used by desktop; the phone slot alone repositions it. */
export const TURN_LINE_ROW_MIN_HEIGHT = space.lg;
export const TURN_LABEL_LINE_HEIGHT = 18;
export const COMPOSER_TOP_GAP = TURN_LABEL_LINE_HEIGHT;
export const TURN_LINE_BAR_MARGIN_BOTTOM = COMPOSER_TOP_GAP / 2;
export const TURN_LINE_BOX_HEIGHT = TURN_LINE_ROW_MIN_HEIGHT + TURN_LINE_BAR_MARGIN_BOTTOM;

/** Fixed inverted-list tail measured from the newest ROW, including reactions.
 * Never subtract Ledger's padding: reactions are siblings of that entry. Keep
 * this constant with and without a line so starting a turn cannot move the list. */
export const PHONE_TRANSCRIPT_TAIL_PADDING = space.xl + space.xs;
const COMPOSER_ROW_PADDING_TOP = space.sm;
const COMPOSER_ROW_BORDER_TOP = 1;

/** Equal visible air to the newest row and the composer's FIELD border,
 * which is below the stack edge by its padding and border. */
export const TURN_LINE_INK_AIR =
  (PHONE_TRANSCRIPT_TAIL_PADDING + COMPOSER_ROW_PADDING_TOP + COMPOSER_ROW_BORDER_TOP
    - TURN_LABEL_LINE_HEIGHT) / 2;

/** Lower the shared row only in the phone overlay; preserve desktop spacing. */
const TURN_CHROME_LABEL_OFFSET =
  COMPOSER_ROW_PADDING_TOP + COMPOSER_ROW_BORDER_TOP
  + TURN_LINE_BAR_MARGIN_BOTTOM + (TURN_LINE_ROW_MIN_HEIGHT - TURN_LABEL_LINE_HEIGHT) / 2
  - TURN_LINE_INK_AIR;

/** Overlap the opaque composer canvas to avoid independently rounded joins.
 * The field paints after the slot, above this coverage. */
export const TURN_CHROME_COMPOSER_OVERLAP = space.sm;

export function roomBottomChromeStyles(hull: { bgTerminal: string; border: string }) {
  const overlapTransform = [{ translateY: TURN_CHROME_COMPOSER_OVERLAP }];
  return {
    stack: {
      position: 'relative',
      // Keep the hanging line and every gap around the field above the
      // scrolling transcript, on the same opaque canvas in both themes.
      zIndex: 1,
      backgroundColor: hull.bgTerminal,
    },
    // The line hangs on the composer's top edge and paints over the list's
    // bottom margin. Absolute, so the list's viewport is the same height with
    // the line as without it; anchored to `bottom: '100%'` of the stack, so
    // its own bottom lands exactly on the composer's top edge. The line's
    // outer box includes the fixed gap below its ink row. It and the composer
    // share one opaque canvas, with no rule between them.
    hangingTurnChrome: {
      position: 'absolute',
      left: 0,
      right: 0,
      bottom: '100%',
    },
    // Paint exactly the fixed tail, including the air above the row. Move
    // padding from below the shared bar to above it to lower the phone label;
    // the 8px overlap still seals the rounded join without covering the newest row.
    turnChromeCoverage: {
      backgroundColor: hull.bgTerminal,
      paddingTop: PHONE_TRANSCRIPT_TAIL_PADDING - TURN_LINE_BOX_HEIGHT + TURN_CHROME_LABEL_OFFSET,
      paddingBottom: TURN_CHROME_COMPOSER_OVERLAP - TURN_CHROME_LABEL_OFFSET,
      transform: overlapTransform,
    },
    composerRow: {
      paddingHorizontal: 16,
      position: 'relative',
      paddingTop: COMPOSER_ROW_PADDING_TOP,
      // Keep the Room-open geometry's 1px edge, painted as part of the same
      // opaque canvas so it never separates the status line and composer.
      borderTopWidth: COMPOSER_ROW_BORDER_TOP,
      borderTopColor: hull.bgTerminal,
      backgroundColor: hull.bgTerminal,
    },
  } as const;
}
