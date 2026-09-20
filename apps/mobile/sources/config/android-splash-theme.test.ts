import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const splashTheme = require('../../plugins/android-splash-theme.js') as {
  android12SplashThemeGaps: (items: Record<string, string | undefined>) => string[];
  applyAndroid12SplashTheme: (styles: unknown) => unknown;
  styleItems: (styles: unknown) => Record<string, string | undefined>;
  ANDROID_12_SPLASH_ITEMS: Record<string, string>;
  LIGHT_SPLASH_BACKGROUND: string;
  DARK_SPLASH_BACKGROUND: string;
  EXPO_ANDROIDX_ONLY_SPLASH_STYLE: unknown;
};

const appConfig = (await import('../../app.config.js')).default.expo;
const mobileRoot = resolve(__dirname, '../..');

describe('Android 12+ splash theme resolution', () => {
  it('fails the platform splash contract on Expo’s AndroidX-only theme', () => {
    // This is the style expo-splash-screen actually writes today. A store
    // build of that output still shows the adaptive icon (brass on aubergine)
    // in light mode, because Android 12+ reads android:windowSplashScreen*.
    const items = splashTheme.styleItems(splashTheme.EXPO_ANDROIDX_ONLY_SPLASH_STYLE);
    expect(items.windowSplashScreenAnimatedIcon).toBe('@drawable/splashscreen_logo');
    expect(items['android:windowSplashScreenAnimatedIcon']).toBeUndefined();
    expect(splashTheme.android12SplashThemeGaps(items)).toEqual([
      'android:windowSplashScreenBackground',
      'android:windowSplashScreenAnimatedIcon',
      'android:windowSplashScreenIconBackgroundColor',
    ]);
  });

  it('writes the platform attributes the system starting window reads', () => {
    const next = splashTheme.applyAndroid12SplashTheme(
      structuredClone(splashTheme.EXPO_ANDROIDX_ONLY_SPLASH_STYLE),
    );
    expect(splashTheme.android12SplashThemeGaps(splashTheme.styleItems(next))).toEqual([]);
  });

  it('is composed from the Android tooling plugin so Expo’s styles rewrite cannot drop it', () => {
    const tooling = readFileSync(resolve(mobileRoot, 'plugins/withAndroidBuildTooling.js'), 'utf8');
    expect(tooling).toContain("require('./android-splash-theme')");
    expect(tooling).toContain('withAndroidSplashTheme(config)');
    const theme = readFileSync(resolve(mobileRoot, 'plugins/android-splash-theme.js'), 'utf8');
    expect(theme).toContain('withFinalizedMod');
  });

  it('keeps cream as the default splash color and aubergine as night-only', () => {
    const splashPlugin = appConfig.plugins.find(
      (plugin: unknown) => Array.isArray(plugin) && plugin[0] === 'expo-splash-screen',
    ) as [string, { android: { backgroundColor: string; dark: { backgroundColor: string } } }];
    expect(splashPlugin[1].android.backgroundColor).toBe(splashTheme.LIGHT_SPLASH_BACKGROUND);
    expect(splashPlugin[1].android.dark.backgroundColor).toBe(splashTheme.DARK_SPLASH_BACKGROUND);

    const {
      getAndroidSplashConfig,
      getAndroidDarkSplashConfig,
    } = require('@expo/prebuild-config/build/plugins/unversioned/expo-splash-screen/getAndroidSplashConfig');
    const androidProps = splashPlugin[1].android;
    expect(getAndroidSplashConfig(appConfig, androidProps).backgroundColor).toBe(
      splashTheme.LIGHT_SPLASH_BACKGROUND,
    );
    expect(getAndroidDarkSplashConfig(appConfig, androidProps).backgroundColor).toBe(
      splashTheme.DARK_SPLASH_BACKGROUND,
    );
  });

  it('does not pin the default generated splash logo to the dark adaptive icon', () => {
    expect(splashTheme.ANDROID_12_SPLASH_ITEMS['android:windowSplashScreenAnimatedIcon']).toBe(
      '@drawable/splashscreen_logo',
    );
    const styles = readFileSync(resolve(mobileRoot, 'plugins/android-splash-theme.js'), 'utf8');
    expect(styles).not.toContain('ic_launcher');
    expect(styles).toContain('android:windowSplashScreenAnimatedIcon');
  });
});
