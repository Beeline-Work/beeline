import React from 'react';
import { Text, View, type ViewStyle } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { SurfaceGlyphLoader } from './SurfaceGlyphLoader';

/**
 * The Room-deck page loader. After BootPaint, the first mount is an empty wait
 * so cold start paints the mark only once; later visits to the deck still
 * replace the old four-dot page.
 */
export function RoomDeckLoadingView({
  suppressPaint,
  style,
}: {
  suppressPaint: boolean;
  style?: ViewStyle;
}) {
  return (
    <View
      style={[styles.center, style]}
      testID={suppressPaint ? 'rooms-loader-suppressed' : 'rooms-loader-gate'}
    >
      {suppressPaint ? null : (
        <>
          <SurfaceGlyphLoader testID="rooms-loader" />
          <Text style={styles.loading}>LOADING ROOMS</Text>
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create((theme) => {
  const hull = theme.buzz;
  return {
    center: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      gap: 14,
      backgroundColor: hull.bgTerminal,
      paddingHorizontal: 28,
    },
    loading: {
      ...Typography.mono('semiBold'),
      color: hull.textMuted,
      fontSize: 10,
      letterSpacing: 1.2,
    },
  };
});
