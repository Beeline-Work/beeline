import React from 'react';
import { View } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { StyleSheet } from 'react-native-unistyles';

/** Google's four-color G on the Workbench and conversation connect card. */
export function GoogleMark({ size = 40 }: { size?: 32 | 40 }) {
  return <View style={[styles.plate, { width: size, height: size }]} testID="google-entry-mark">
    <Svg width={size === 40 ? 24 : 20} height={size === 40 ? 24 : 20} viewBox="0 0 24 24">
      <Path fill="#4285F4" d="M21.35 12.23c0-.71-.06-1.38-.18-2.03H12v3.84h5.24a4.48 4.48 0 0 1-1.94 2.94v2.45h3.14c1.84-1.69 2.91-4.18 2.91-7.2Z" />
      <Path fill="#34A853" d="M12 21.5c2.62 0 4.83-.87 6.44-2.07l-3.14-2.45c-.87.59-1.99.94-3.3.94-2.53 0-4.68-1.71-5.45-4.01H3.32v2.52A9.73 9.73 0 0 0 12 21.5Z" />
      <Path fill="#FBBC05" d="M6.55 13.91a5.85 5.85 0 0 1 0-3.82V7.57H3.32a9.73 9.73 0 0 0 0 8.86l3.23-2.52Z" />
      <Path fill="#EA4335" d="M12 6.08c1.43 0 2.71.49 3.72 1.45l2.79-2.79A9.34 9.34 0 0 0 12 2.5a9.73 9.73 0 0 0-8.68 5.07l3.23 2.52c.77-2.3 2.92-4.01 5.45-4.01Z" />
    </Svg>
  </View>;
}

const styles = StyleSheet.create((theme) => ({
  plate: { borderRadius: 9, backgroundColor: '#FFFFFF',
    borderWidth: StyleSheet.hairlineWidth, borderColor: theme.buzz.border,
    alignItems: 'center', justifyContent: 'center' },
}));
