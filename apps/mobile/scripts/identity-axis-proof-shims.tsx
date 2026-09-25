import React from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import { beelineThemes } from '../sources/buzz/groknight';

const groknight =
  beelineThemes[
    new URLSearchParams(location.search).get('theme') === 'light' ? 'bone' : 'obsidian'
  ];

export function useUnistyles() {
  return { theme: { buzz: groknight } };
}

export const StyleSheet = {
  create: (factory: unknown) =>
    typeof factory === 'function'
      ? (factory as (theme: { buzz: typeof groknight }) => unknown)({ buzz: groknight })
      : factory,
};

export function HullLivePulse({
  children,
  style,
}: {
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  return <View style={style}>{children}</View>;
}
