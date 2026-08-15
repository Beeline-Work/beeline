const { withGradleProperties } = require('@expo/config-plugins');

/**
 * Keep generated Android projects fast without committing Expo's android/ output.
 *
 * `expo prebuild --clean` recreates android/ for every worktree, so this must be
 * a config plugin rather than an edit to android/gradle.properties.
 */
const GRADLE_PROPERTIES = {
  'org.gradle.jvmargs': '-Xmx8g -XX:MaxMetaspaceSize=1g',
  'org.gradle.caching': 'true',
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
  return withGradleProperties(config, (mod) => {
    for (const [key, value] of Object.entries(GRADLE_PROPERTIES)) {
      upsert(mod.modResults, key, value);
    }
    return mod;
  });
};
