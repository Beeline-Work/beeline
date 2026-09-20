const { withFinalizedMod, AndroidConfig, XML } = require('@expo/config-plugins');

/**
 * Android 12+ paints the system splash from the activity theme's platform
 * attributes (`android:windowSplashScreen*`) before the process starts.
 *
 * Expo's splash plugin only writes the AndroidX names (`windowSplashScreen*`)
 * and relies on `Theme.SplashScreen` to alias them. When that alias is not
 * what the starting window reads, the OS falls back to the adaptive launcher
 * icon — always brass on aubergine, in light mode too.
 */
const SPLASH_STYLE = { name: 'Theme.App.SplashScreen' };

const ANDROID_12_SPLASH_ITEMS = {
  'android:windowSplashScreenBackground': '@color/splashscreen_background',
  'android:windowSplashScreenAnimatedIcon': '@drawable/splashscreen_logo',
  'android:windowSplashScreenIconBackgroundColor': '@color/splashscreen_background',
};

const LIGHT_SPLASH_BACKGROUND = '#F3EEE4';
const DARK_SPLASH_BACKGROUND = '#14091A';

function styleItems(stylesXml) {
  const styles = stylesXml?.resources?.style ?? [];
  const splash = (Array.isArray(styles) ? styles : [styles]).find(
    (style) => style?.$?.name === 'Theme.App.SplashScreen',
  );
  const items = {};
  for (const item of splash?.item ?? []) {
    if (item?.$?.name) {
      items[item.$.name] = item._;
    }
  }
  return items;
}

function android12SplashThemeGaps(items) {
  return Object.entries(ANDROID_12_SPLASH_ITEMS)
    .filter(([name, value]) => items[name] !== value)
    .map(([name]) => name);
}

function applyAndroid12SplashTheme(stylesXml) {
  let next = stylesXml;
  for (const [name, value] of Object.entries(ANDROID_12_SPLASH_ITEMS)) {
    next = AndroidConfig.Styles.assignStylesValue(next, {
      add: true,
      parent: SPLASH_STYLE,
      name,
      value,
    });
  }
  return next;
}

function withAndroidSplashTheme(config) {
  // Finalized: expo-splash-screen rewrites Theme.App.SplashScreen in its
  // styles mod, so a same-phase withAndroidStyles patch is overwritten.
  return withFinalizedMod(config, [
    'android',
    async (mod) => {
      const stylesPath = await AndroidConfig.Styles.getProjectStylesXMLPathAsync(
        mod.modRequest.projectRoot,
      );
      const styles = await AndroidConfig.Styles.readStylesXMLAsync({ path: stylesPath });
      await XML.writeXMLAsync({
        path: stylesPath,
        xml: applyAndroid12SplashTheme(styles),
      });
      return mod;
    },
  ]);
}

module.exports = withAndroidSplashTheme;
module.exports.applyAndroid12SplashTheme = applyAndroid12SplashTheme;
module.exports.android12SplashThemeGaps = android12SplashThemeGaps;
module.exports.styleItems = styleItems;
module.exports.ANDROID_12_SPLASH_ITEMS = ANDROID_12_SPLASH_ITEMS;
module.exports.LIGHT_SPLASH_BACKGROUND = LIGHT_SPLASH_BACKGROUND;
module.exports.DARK_SPLASH_BACKGROUND = DARK_SPLASH_BACKGROUND;
module.exports.EXPO_ANDROIDX_ONLY_SPLASH_STYLE = {
  resources: {
    style: [
      {
        $: { name: 'Theme.App.SplashScreen', parent: 'Theme.SplashScreen' },
        item: [
          { $: { name: 'windowSplashScreenBackground' }, _: '@color/splashscreen_background' },
          { $: { name: 'windowSplashScreenAnimatedIcon' }, _: '@drawable/splashscreen_logo' },
          { $: { name: 'postSplashScreenTheme' }, _: '@style/AppTheme' },
          { $: { name: 'android:windowSplashScreenBehavior' }, _: 'icon_preferred' },
        ],
      },
    ],
  },
};
