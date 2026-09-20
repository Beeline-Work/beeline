/**
 * The Room's bottom chrome is a column with one thing hanging off its top
 * edge, and the reason it lives here rather than inline in the screen is that
 * the one rule it has to keep is a MEASUREMENT: the phone turn line's bottom
 * edge and the first row of the stack must meet at exactly the same y.
 *
 * The turn line is absolutely positioned at `bottom: '100%'`, so it paints
 * over the transcript instead of growing the stack — the transcript reserves
 * that height itself (`phoneTranscriptTailPadding`). Everything in the stack
 * after it is in flow, the composer last.
 *
 * A pinned corner line used to sit between the two, which is why the turn line
 * could be 30px off the composer and nobody noticed. With the line gone there
 * is nothing to absorb a stray margin or padding, so any gap introduced here
 * is dead space the reader sees. `room-bottom-chrome.test.tsx` measures it.
 */
export function roomBottomChromeStyles(hull: { bgTerminal: string; border: string }) {
  return {
    stack: {
      position: 'relative',
    },
    hangingTurnChrome: {
      position: 'absolute',
      right: 0,
      bottom: '100%',
      left: 0,
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
