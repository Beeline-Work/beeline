// Runtime-compatibility stamp policy for expo-updates (app.config.js sets
// `runtimeVersion: { policy: "fingerprint" }`). EAS Build and `eas update` both
// resolve the runtime through `expo-updates runtimeversion:resolve`, which
// reads this file, so the rules below decide which changes force a new binary.
//
// The stamp must be the SAME for every artifact built from one commit: the
// store AAB/IPA (`production`), the sideload APK (`production-apk`), the OTA
// canary vehicle (`beta-apk`, built with EXPO_UPDATES_CHANNEL=beta), and the
// `eas update` export run by the release governor. Anything that differs
// between those runs without changing native code is removed here.
//
// Verify: cd apps/mobile && npx expo-updates runtimeversion:resolve \
//   --platform android --workflow managed   (repeat with EXPO_UPDATES_CHANNEL=beta)
// The hashes must agree, and must survive `rm -rf node_modules && npm ci`.

/** @type {import('@expo/fingerprint').Config} */
module.exports = {
  sourceSkips: [
    // Restore the library default (config-file sourceSkips replace it).
    'PackageJsonAndroidAndIosScriptsIfNotContainRun',
    // apps/mobile/package.json `version` follows the release; EAS owns
    // versionCode/buildNumber remotely. Neither changes native compatibility.
    'ExpoConfigVersions',
    // `extra` is JS-only data (release version/SHA, commit metadata, service
    // URLs from EXPO_PUBLIC_*): it changes on every commit and never touches
    // native code, so it must not fork the stamp.
    'ExpoConfigExtraSection',
  ],
  fileHookTransform(source, chunk, _isEndOfFile, _encoding) {
    if (source.type !== 'contents' || source.id !== 'expoConfig' || typeof chunk !== 'string') {
      return chunk;
    }
    const config = JSON.parse(chunk);
    // The update channel is the delivery vehicle, not the compatibility
    // boundary: `beta-apk` bakes `beta`, every other artifact bakes
    // `production`, and both must accept the same update group.
    if (config.updates && typeof config.updates === 'object') {
      delete config.updates.requestHeaders;
    }
    // Local development (NODE_ENV unset) relaxes ATS; no store binary or OTA
    // is ever produced that way, so the stamp reads the production shape.
    const ats = config.ios?.infoPlist?.NSAppTransportSecurity;
    if (ats && typeof ats === 'object') {
      delete ats.NSAllowsArbitraryLoads;
    }
    return JSON.stringify(config);
  },
};
