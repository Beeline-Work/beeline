import React from 'react';
import Svg, { Path } from 'react-native-svg';
import { useUnistyles } from 'react-native-unistyles';

/** The shared Room/DM swipe affordance: one unframed brass exit mark. */
export const ExitGlyph = React.memo(function ExitGlyph({ testID }: { testID?: string }) {
  const { theme } = useUnistyles();
  return (
    <Svg
      accessibilityElementsHidden
      height={26}
      testID={testID}
      viewBox="0 0 24 24"
      width={26}
    >
      <Path
        d="M14 4h6v16h-6"
        fill="none"
        stroke={theme.buzz.accent}
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.8}
      />
      <Path
        d="M4 12h11"
        fill="none"
        stroke={theme.buzz.accent}
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.8}
      />
      <Path
        d="M11 8l4 4-4 4"
        fill="none"
        stroke={theme.buzz.accent}
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.8}
      />
    </Svg>
  );
});
