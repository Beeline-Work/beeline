import React from 'react';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { SPLASH_GLYPH_SIZE, glyphPaintGround } from '@/buzz/beeline-glyph';
import { BeelineGlyphPaint } from './BeelineGlyphPaint';

/**
 * The app's first screen after the OS splash. Same ground as expo-splash-screen
 * so the handoff is a colour match, not a flash; the glyph then paints once
 * and holds, because this load actually ends.
 */
export function BootPaint({
  onPainted,
  onReady,
  testID = 'boot-paint',
}: {
  onPainted: () => void;
  onReady?: () => void;
  testID?: string;
}) {
  const { theme } = useUnistyles();
  const ground = glyphPaintGround(theme.buzz.dark);
  return (
    <View
      accessibilityLabel="Loading Beeline"
      accessibilityRole="progressbar"
      onLayout={onReady}
      style={{
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: ground,
      }}
      testID={testID}
    >
      <BeelineGlyphPaint
        framing="icon"
        loop="once"
        onPainted={onPainted}
        size={SPLASH_GLYPH_SIZE}
        testID={testID ? `${testID}-glyph` : undefined}
      />
    </View>
  );
}
