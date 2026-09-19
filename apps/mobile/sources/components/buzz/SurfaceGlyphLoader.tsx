import React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { MARK_CELL, SURFACE_GLYPH_SIZE } from '@/buzz/beeline-glyph';
import { BeelineGlyphPaint } from './BeelineGlyphPaint';

/**
 * The one in-app load-gate treatment: the same self-painting glyph as splash
 * and the thinking line. Duration is unknown, so this uses the release loop —
 * it never holds a completed stroke as progress toward a finish.
 */
export function SurfaceGlyphLoader({
  compact = false,
  testID = 'surface-glyph-loader',
}: {
  compact?: boolean;
  testID?: string;
}) {
  return (
    <View
      accessibilityLabel="Loading"
      accessibilityRole="progressbar"
      style={compact ? styles.compact : styles.surface}
      testID={testID}
    >
      <BeelineGlyphPaint
        framing="cell"
        live
        loop="release"
        size={compact ? MARK_CELL : SURFACE_GLYPH_SIZE}
        testID={testID ? `${testID}-glyph` : undefined}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  surface: { alignItems: 'center', justifyContent: 'center' },
  compact: { alignItems: 'center', justifyContent: 'center' },
});
