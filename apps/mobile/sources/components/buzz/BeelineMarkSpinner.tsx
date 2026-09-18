import React from 'react';
import { BeelineGlyphPaint } from './BeelineGlyphPaint';
import { MARK_CELL, RELEASE_CYCLE_MS, ribbon } from '@/buzz/beeline-glyph';

export { MARK_CELL, ribbon };
/** One paint + one release + the rest at empty. */
export const RIBBON_CYCLE_MS = RELEASE_CYCLE_MS;

/**
 * The Beeline mark as the thinking line's glyph. Live, the icon's own stroke
 * paints the ribbon, then immediately releases to empty and rests before
 * redrawing — a loop that returns to rest, never a fill toward an unknown
 * finish. Settled, reduced-motion, or backgrounded, it is the completed
 * filled mark, the same glyph the splash holds when loading ends.
 */
export const BeelineMarkSpinner = React.memo(function BeelineMarkSpinner({
  live = false,
  testID,
}: {
  live?: boolean;
  testID?: string;
}) {
  return (
    <BeelineGlyphPaint
      framing="cell"
      live={live}
      loop="release"
      size={MARK_CELL}
      testID={testID}
    />
  );
});
