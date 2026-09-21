/**
 * The Room's bottom chrome: the turn line, then the composer.
 *
 * The line paints into the margin the transcript already leaves below its
 * newest message. It is not a band, it holds no height of its own, and the
 * transcript does not move when it comes or goes — because nothing about the
 * list changes size.
 *
 * Three earlier rounds are worth recording so the fourth is not attempted.
 * An absolute overlay at `bottom: '100%'` over a 12px tail covered the bottom
 * of the newest message. An in-flow band took its height out of the list, so
 * the transcript shifted every time an agent started or stopped. A permanently
 * reserved slot stopped the shift and bought it with an empty strip above the
 * composer in every Room, plus a hidden duplicate of the line mounted only to
 * measure it, plus a reserve that could never shrink.
 *
 * All three were solving a shortage that did not exist. The gap between the
 * newest message and the composer is already the ordinary speaker-change
 * margin, and that margin is taller than the line. Painting into room that is
 * there costs nothing and reserves nothing, so there is no height to hold, no
 * ruler to mount, and no shift to compensate for.
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
    // No rule and no fill. The line paints into the transcript's own margin,
    // so it has to read as part of that surface; a hairline or a second
    // background here would fence off space the transcript already owns. The
    // composer keeps its top border — that one separates two real surfaces.
    hangingTurnChrome: {
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


