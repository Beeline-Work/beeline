/**
 * The Room's bottom chrome: the turn line, then the composer.
 *
 * The line paints into the margin the transcript already leaves below its
 * newest message. It is not a band and it holds no height: `hangingTurnChrome`
 * is an ordinary style object only in the sense that it is the line's box; the
 * box itself is `position: 'absolute'` and anchored to the composer's top
 * edge, so it takes nothing out of the list whether or not it is showing.
 *
 * Three earlier rounds are worth recording so the fourth is not attempted.
 * An absolute overlay of a taller box covered the bottom of the newest
 * message. An in-flow band took its height out of the list, so the transcript
 * shifted every time an agent started or stopped. A permanently reserved slot
 * stopped the shift and bought it with an empty strip above the composer in
 * every Room, plus a hidden duplicate of the line mounted only to measure it,
 * plus a reserve that could never shrink.
 *
 * All three were solving a shortage that did not exist. The gap between the
 * newest message and the composer is already the ordinary speaker-change
 * margin (24px), and the line's box is exactly that margin, flush on the
 * composer's border. Painting into room that is there costs nothing and
 * reserves nothing, so there is no height to hold, no ruler to mount, and no
 * shift to compensate for.
 */

/** The line's own row. It paints inside the transcript's existing
 *  speaker-change margin, so the row plus its margin must not exceed that
 *  margin — otherwise the line covers the message above it, which is the
 *  overlay failure this design exists to avoid. The ink is 18px (`MARK_CELL`
 *  and the 12px mono label's line box), so 24 leaves 3px either side. */
export const TURN_LINE_ROW_MIN_HEIGHT = 24;

/** None: the line sits flush on the composer's top border, and the composer's
 *  own paddingTop is the breathing room below it. Any margin here comes out of
 *  the 24px the line has to fit inside. */
export const TURN_LINE_BAR_MARGIN_BOTTOM = 0;

export function roomBottomChromeStyles(hull: { bgTerminal: string; border: string }) {
  return {
    stack: {
      position: 'relative',
    },
    // The line hangs on the composer's top edge and paints over the list's
    // bottom margin. Absolute, so the list's viewport is the same height with
    // the line as without it; anchored to `bottom: '100%'` of the stack, so
    // its own bottom lands exactly on the composer's border. No rule and no
    // fill of its own beyond the canvas it sits on — a hairline or a second
    // background would fence off space the transcript already owns. The
    // composer keeps its top border; that one separates two real surfaces.
    hangingTurnChrome: {
      position: 'absolute',
      left: 0,
      right: 0,
      bottom: '100%',
      backgroundColor: hull.bgTerminal,
    },
    composerRow: {
      paddingHorizontal: 16,
      position: 'relative',
      paddingTop: 8,
      borderTopWidth: 1,
      borderTopColor: hull.border,
      backgroundColor: hull.bgTerminal,
    },
  } as const;
}
