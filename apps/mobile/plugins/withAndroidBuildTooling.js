const { withGradleProperties, withAppBuildGradle, withDangerousMod } = require('@expo/config-plugins');
const fs = require('node:fs/promises');
const path = require('node:path');
const withAndroidSplashTheme = require('./android-splash-theme');

/**
 * Keep generated Android projects fast without committing Expo's android/ output.
 *
 * `expo prebuild --clean` recreates android/ for every worktree, so this must be
 * a config plugin rather than an edit to android/gradle.properties.
 */
const GRADLE_PROPERTIES = {
  'org.gradle.jvmargs': '-Xmx8g -XX:MaxMetaspaceSize=1g',
  'org.gradle.caching': 'true',
  'android.enableMinifyInReleaseBuilds': 'true',
  'android.enableShrinkResourcesInReleaseBuilds': 'true',
};

function upsert(properties, key, value) {
  const existing = properties.find(
    (property) => property.type === 'property' && property.key === key,
  );

  if (existing) {
    existing.value = value;
  } else {
    properties.push({ type: 'property', key, value });
  }
}

module.exports = function withAndroidBuildTooling(config) {
  config = withAndroidSplashTheme(config);
  config = withAppBuildGradle(config, (mod) => {
    mod.modResults.contents = mod.modResults.contents.replace(
      'getDefaultProguardFile("proguard-android.txt")',
      'getDefaultProguardFile("proguard-android-optimize.txt")',
    );
    return mod;
  });
  config = withDangerousMod(config, ['android', async (mod) => {
    const app = path.join(mod.modRequest.platformProjectRoot, 'app');
    const rulesPath = path.join(app, 'proguard-rules.pro');
    const marker = '# Beeline release reflection rules';
    const existing = await fs.readFile(rulesPath, 'utf8');
    const rules = await fs.readFile(path.join(__dirname, 'android-release.pro'), 'utf8');
    const endMarker = '# End Beeline release reflection rules';
    const block = `${marker}\n${rules.trimEnd()}\n${endMarker}`;
    const pattern = /# Beeline release reflection rules\n[\s\S]*?# End Beeline release reflection rules/g;
    await fs.writeFile(rulesPath, existing.includes(endMarker)
      ? existing.replace(pattern, block)
      : `${existing.trimEnd()}\n\n${block}\n`);
    const raw = path.join(app, 'src/main/res/raw');
    await fs.mkdir(raw, { recursive: true });
    await fs.writeFile(path.join(raw, 'beeline_keep.xml'),
      '<resources xmlns:tools="http://schemas.android.com/tools" tools:keep="@drawable/notification_icon,@drawable/splashscreen_logo,@color/splashscreen_background" />\n');
    return mod;
  }]);
  return withGradleProperties(config, (mod) => {
    for (const [key, value] of Object.entries(GRADLE_PROPERTIES)) {
      upsert(mod.modResults, key, value);
    }
    return mod;
  });
};
