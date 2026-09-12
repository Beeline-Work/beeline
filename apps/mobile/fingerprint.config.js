// Native-change detector for the NATIVE FINGERPRINT gate
// (`scripts/native-fingerprint.mjs`). `app.config.js` pins the runtime version
// by hand; this file decides which changes count as a native change, so the
// gate can tell an author that the pin has to move and a new binary has to
// ship. It is NOT bound to `runtimeVersion` as a policy — a computed runtime
// orphans every already-installed binary the moment the stamp moves.
//
// @expo/fingerprint reads this file automatically, so `npx expo-updates
// runtimeversion:resolve` and `npx @expo/fingerprint` agree with the gate.
//
// The stamp must be the SAME for every artifact built from one commit: the
// store AAB/IPA (`production`), the sideload APK (`production-apk`), the OTA
// canary vehicle (`beta-apk`, built with EXPO_UPDATES_CHANNEL=beta), and the
// `eas update` export run by the release governor. Anything that differs
// between those runs without changing native code is removed here.
//
// Verify: cd apps/mobile && npm run fingerprint:check
// The recorded hashes must survive `rm -rf node_modules && npm ci`.

/** @type {import('@expo/fingerprint').Config} */
module.exports = {
  sourceSkips: [
    // The whole `scripts` section is JS/CI tooling. The library hashes it by
    // default only because `expo prebuild` rewrites the android/ios entries,
    // and its narrower default skip (`PackageJsonAndroidAndIosScriptsIfNotContainRun`)
    // does not apply here: this app's `android`/`ios` scripts are `expo
    // run:*`, so every unrelated npm-script edit would otherwise read as a
    // native change and train authors to bump the pin for nothing.
    'PackageJsonScriptsAll',
    // apps/mobile/package.json `version` follows the release; EAS owns
    // versionCode/buildNumber remotely. Neither changes native compatibility.
    'ExpoConfigVersions',
    // The hand-pinned `runtimeVersion` is the ANSWER to a native change, not an
    // input to it. Skipping it keeps "the fingerprint moved" meaning exactly
    // "native code changed", so bumping the pin settles the gate instead of
    // moving the very number the gate compares.
    'ExpoConfigRuntimeVersionIfString',
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
