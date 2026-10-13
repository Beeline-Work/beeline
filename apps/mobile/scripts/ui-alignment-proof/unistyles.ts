import { StyleSheet as NativeStyleSheet } from 'react-native';
import { beelineThemes } from '@/buzz/groknight';
export const theme = {
  buzz: beelineThemes[
    new URLSearchParams(location.search).get('theme') === 'bone' ? 'bone' : 'obsidian'
  ],
};
export const StyleSheet = {
  ...NativeStyleSheet,
  create: (fn: any) => (typeof fn === 'function' ? fn(theme) : fn),
  hairlineWidth: 1,
};
export const useUnistyles = () => ({
  theme,
  rt: { themeName: theme.buzz.dark ? 'obsidian' : 'bone' },
});
