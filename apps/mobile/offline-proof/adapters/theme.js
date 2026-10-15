import { StyleSheet as RNStyleSheet } from 'react-native';
import { beelineThemes } from '../../sources/buzz/groknight';
import { proofTheme } from '../settings';
const theme = { buzz: beelineThemes[proofTheme] };
export const StyleSheet = {
  ...RNStyleSheet,
  create: (factory) =>
    typeof factory === 'function'
      ? factory(theme, {
          insets: { top: 24, bottom: 24, left: 0, right: 0 },
          screen: { width: 412, height: 915 },
        })
      : factory,
};
export const useUnistyles = () => ({
  theme,
  rt: { insets: { top: 24, bottom: 24, left: 0, right: 0 } },
});
export const UnistylesRuntime = { themeName: proofTheme, setTheme() {}, setAdaptiveThemes() {} };
