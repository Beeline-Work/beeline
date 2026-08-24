import React from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

type HullActionSheetProps = {
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

/**
 * The one Beeline overlay surface: opaque aubergine, one hairline, and the
 * shared hull radius. It deliberately owns no blur, texture, or glass fill.
 */
export function HullActionSheet({ children, style, testID }: HullActionSheetProps) {
  return (
    <View style={[styles.sheet, style]} testID={testID}>
      {children}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  sheet: {
    overflow: 'hidden',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.buzz.borderStrong,
    borderRadius: theme.buzz.radius,
    backgroundColor: theme.buzz.bgRaised,
  },
}));
