import React from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import { groknight } from '../sources/buzz/groknight';

export function useUnistyles() {
  return { theme: { buzz: groknight } };
}

export function HullLivePulse({
  children,
  style,
}: {
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  return <View style={style}>{children}</View>;
}
