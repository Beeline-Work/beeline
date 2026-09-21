/**
 * The Room's bottom chrome is a column: the phone turn line in flow, then the
 * composer. The reason it lives here rather than inline in the screen is that
 * the one rule it has to keep is a MEASUREMENT: the line is a band above the
 * composer, never an overlay on the transcript, and the transcript does not
 * move when that band comes or goes.
 *
 * An absolute line at `bottom: '100%'` with an opaque canvas fill paints over
 * the newest row. The transcript tail is 12px and the line is ~30px, so that
 * overlay covers roughly the bottom 18px of the last message. Putting the
 * line in flow gives it its own band without growing inverted-list padding —
 * growing that padding only while thinking is a step.
 *
 * But an in-flow band takes its own height out of the list's viewport, so the
 * transcript still moved by the band's height the moment an agent started
 * working and moved back when it finished. Scroll compensation cannot undo
 * that: on an inverted list pinned at the tail the newest row already sits at
 * offset 0, glued to a viewport bottom that just rose, and compensating
 * downward would need offset −bandHeight, which clamps at 0. So the SLOT is
 * reserved permanently instead (`reservedTurnBandHeight`): the list's height
 * is the same whether or not an agent is working, and nothing moves in either
 * direction. The cost is an empty strip above the composer when nobody is
 * working, which is why the band carries no rule and no fill of its own
 * beyond the canvas it already sits on — an empty reserved strip must read as
 * part of the transcript's own background, not as a second surface.
 *
 * `room-bottom-chrome.test.tsx` measures the overlay-cover counterfactual, the
 * in-flow placement, and the reserve against a rendered line.
 */
/** The turn line's own row height (`TurnProgressLine`'s `row.minHeight`). */
export const TURN_LINE_ROW_MIN_HEIGHT = 26;

/** The air the turn line's outer box keeps below itself (`bar.marginBottom`). */
export const TURN_LINE_BAR_MARGIN_BOTTOM = 4;

/**
 * The band's height before anything has measured it, composed from the line's
 * own tokens rather than written down as a number. It is the exact height of a
 * single-line band at the default text scale, so the first band a Room ever
 * shows lands in a slot that already fits it.
 */
export const TURN_BAND_FALLBACK_HEIGHT = TURN_LINE_ROW_MIN_HEIGHT + TURN_LINE_BAR_MARGIN_BOTTOM;

export function roomBottomChromeStyles(hull: { bgTerminal: string; border: string }) {
  return {
    stack: {
      position: 'relative',
    },
    // No rule. The band no longer overlays anything, so a hairline here only
    // fences the transcript off from a transient status line that reads
    // better unfenced — and the slot is reserved even when nothing is
    // working, so that rule would be drawn across an empty strip. The
    // composer keeps its own top border; that one separates two real
    // surfaces.
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

/**
 * The height the band's slot holds open, whether or not an agent is working.
 *
 * It is MEASURED, not written down: the band's real height depends on the
 * mono label's line height, the mark cell, and the reader's text scale, so a
 * reserve typed as a number here would be wrong on the first phone that
 * disagrees with it and the shift would come straight back.
 * `TURN_BAND_FALLBACK_HEIGHT` only covers the moments before any band has
 * been laid out; the first real measurement takes over.
 *
 * The reserve never shrinks within a session. A taller band — a wrapped label,
 * a larger text scale — raises it once and it stays raised, because letting it
 * fall back would move the transcript in the other direction the next time a
 * short band replaced a tall one. Growing once is the only motion this rule
 * admits, and only on the first band that needs the extra room.
 */
export function reservedTurnBandHeight({
  reserved,
  measured,
}: {
  /** The height held open so far this session; null before the first band. */
  reserved: number | null;
  /** The band's height as just laid out; null or 0 when no band is mounted. */
  measured: number | null;
}): number {
  return Math.max(TURN_BAND_FALLBACK_HEIGHT, reserved ?? 0, measured ?? 0);
}

/** Pixels of the newest row an opaque overlay of `lineBox` would cover given
 *  the inverted-list tail padding. In-flow placement keeps the actual cover
 *  at 0 by not painting over the list. */
export function turnLineOverlayCoverPx(lineBox: number, tailPadding: number): number {
  return Math.max(0, lineBox - tailPadding);
}
