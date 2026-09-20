'use strict';

// Knip cannot follow Expo's plugin evaluator or the vitest createRequire()
// edge onto this plugin. This harness is the static entry that names the
// splash-theme proof surface (same pattern as identity-axis-proof).
const {
  applyAndroid12SplashTheme,
  android12SplashThemeGaps,
  styleItems,
  ANDROID_12_SPLASH_ITEMS,
  LIGHT_SPLASH_BACKGROUND,
  DARK_SPLASH_BACKGROUND,
  EXPO_ANDROIDX_ONLY_SPLASH_STYLE,
} = require('../plugins/android-splash-theme.js');

const stockItems = styleItems(EXPO_ANDROIDX_ONLY_SPLASH_STYLE);
const stockGaps = android12SplashThemeGaps(stockItems);
const applied = applyAndroid12SplashTheme(
  JSON.parse(JSON.stringify(EXPO_ANDROIDX_ONLY_SPLASH_STYLE)),
);

if (stockGaps.length === 0) {
  throw new Error('Expo AndroidX-only splash theme must fail the platform contract');
}
if (android12SplashThemeGaps(styleItems(applied)).length !== 0) {
  throw new Error('applyAndroid12SplashTheme must write android: windowSplashScreen attributes');
}
if (ANDROID_12_SPLASH_ITEMS['android:windowSplashScreenAnimatedIcon'] !== '@drawable/splashscreen_logo') {
  throw new Error('platform splash icon must be splashscreen_logo, not the adaptive icon');
}
if (LIGHT_SPLASH_BACKGROUND !== '#F3EEE4' || DARK_SPLASH_BACKGROUND !== '#14091A') {
  throw new Error('light splash must stay cream and dark splash must stay aubergine');
}
