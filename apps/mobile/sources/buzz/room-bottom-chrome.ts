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
 * The slot's height is that reserve EXACTLY, never a floor, and the reserve is
 * measured off a copy of the band that is mounted from the start and never
 * shown (`turnBandMeasure`, `TurnLineMeasure`). Both halves are load-bearing.
 * A floor would let a band taller than the reserve — a larger accessibility
 * text scale makes one — grow the slot at the moment it mounted, which is the
 * same shift by another route; and measuring off the visible band reports only
 * after that band has already been laid out, too late to hold anything still.
 * The hidden copy is laid out at the reader's text scale before any band is
 * shown, so the first band of the session lands in a slot that already fits.
 * `TurnBandSlot` shows nothing until that copy has reported, which is what
 * covers the cold open — a Room entered mid-turn, where the ruler and the band
 * would otherwise mount together and the slot would settle under a band the
 * reader can already see.
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
 * single-line band at the default text scale — it covers only the frames
 * between the slot mounting and the hidden copy reporting its layout, and at
 * any other text scale that copy's measurement is what the slot holds.
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
    // The copy of the band that exists only to be measured. Absolute, so it
    // contributes no height of its own to the slot it is measured inside, and
    // stretched to the slot's width so it wraps exactly as the real band
    // would. Invisible, not unmounted: the reserve has to be known before the
    // first band is shown.
    turnBandMeasure: {
      position: 'absolute',
      left: 0,
      right: 0,
      top: 0,
      opacity: 0,
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
 * `measured` comes from the hidden copy of the band, which is mounted whether
 * or not an agent is working — NOT from the visible band. A visible band can
 * only report its height after it has been laid out, and a band taller than
 * the reserve has by then already shrunk the transcript once. Measuring the
 * hidden copy settles the reserve while the slot is still empty, so the first
 * band of the session is shown into a slot that already fits it at whatever
 * text scale the reader is on.
 *
 * The reserve never shrinks within a session. A taller measurement raises it
 * and it stays raised, because letting it fall back would move the transcript
 * in the other direction the next time a short band replaced a tall one.
 */
export function reservedTurnBandHeight({
  reserved,
  measured,
}: {
  /** The height held open so far this session; null before the first layout. */
  reserved: number | null;
  /** The hidden copy's height as just laid out; null before it reports. */
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
