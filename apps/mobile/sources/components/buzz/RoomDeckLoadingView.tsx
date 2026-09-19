import React from 'react';
import { Text, View, type ViewStyle } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { SurfaceGlyphLoader } from './SurfaceGlyphLoader';

/**
 * The Room-deck page loader. The native launch splash hands directly to the
 * real app, so this treatment appears only when Rooms themselves are loading.
 */
export function RoomDeckLoadingView({
  style,
}: {
  style?: ViewStyle;
}) {
  return (
    <View style={[styles.center, style]} testID="rooms-loader-gate">
      <SurfaceGlyphLoader testID="rooms-loader" />
      <Text style={styles.loading}>LOADING ROOMS</Text>
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
      ...hull.type.sectionHead,
      color: hull.textMuted,
    },
  };
});
