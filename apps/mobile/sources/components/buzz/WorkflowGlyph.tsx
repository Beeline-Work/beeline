import React from 'react';
import Svg, { Polygon } from 'react-native-svg';
import { useUnistyles } from 'react-native-unistyles';
import { DECORATIVE_GLYPH_PROPS } from './decorative-glyph';
import brand from '@/buzz/brand.json';

/**
 * The workflow sigil: a stem standing on the corner mark, the corner polygon
 * turned 135° so its elbow points up. A workflow is the path work takes
 * through corners, so its mark grows out of theirs.
 *
 * One filled polygon in the same 24 viewBox as `CornerGlyph`: a 4.14-wide stem
 * from the top edge down to the elbow, and two tapering arms down to the
 * baseline. Brand mark gold while a run is live; the active theme's
 * `ledgerGhost` when the workflow is idle, so an idle mark reads as resting.
 */
export const WORKFLOW_POINTS =
  '9.93 3 14.07 3 14.07 13.81 21.76 21.5 15.9 21.5 12 17.6 8.1 21.5 2.24 21.5 9.93 13.81';

export function WorkflowGlyph({
  live = true,
  color,
  size = 16,
  testID,
}: {
  /** False draws the idle (ghost) mark. */
  live?: boolean;
  /** Overrides the live/idle fill. */
  color?: string;
  size?: number;
  testID?: string;
}) {
  const idle = useUnistyles().theme.buzz.ledgerGhost;
  return (
    <Svg
      {...DECORATIVE_GLYPH_PROPS}
      height={size}
      testID={testID}
      viewBox="0 0 24 24"
      width={size}
    >
      <Polygon fill={color ?? (live ? brand.mark : idle)} points={WORKFLOW_POINTS} />
    </Svg>
  );
}
