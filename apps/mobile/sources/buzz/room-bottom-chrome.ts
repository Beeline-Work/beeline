/**
 * The Room's bottom chrome is a column: the phone turn line in flow, then the
 * composer. The reason it lives here rather than inline in the screen is that
 * the one rule it has to keep is a MEASUREMENT: the line is a band above the
 * composer, never an overlay on the transcript.
 *
 * An absolute line at `bottom: '100%'` with an opaque canvas fill paints over
 * the newest row. The transcript tail is 12px and the line is ~30px, so that
 * overlay covers roughly the bottom 18px of the last message. Putting the
 * line in flow gives it its own band (hairline, then the line, then the
 * composer hairline) without growing inverted-list padding — growing that
 * padding only while thinking is a step. `room-bottom-chrome.test.tsx`
 * measures both the overlay-cover counterfactual and the in-flow placement.
 */
export function roomBottomChromeStyles(hull: { bgTerminal: string; border: string }) {
  return {
    stack: {
      position: 'relative',
    },
    hangingTurnChrome: {
      backgroundColor: hull.bgTerminal,
      borderTopWidth: 1,
      borderTopColor: hull.border,
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

/** Pixels of the newest row an opaque overlay of `lineBox` would cover given
 *  the inverted-list tail padding. In-flow placement keeps the actual cover
 *  at 0 by not painting over the list. */
export function turnLineOverlayCoverPx(lineBox: number, tailPadding: number): number {
  return Math.max(0, lineBox - tailPadding);
}
