// Sentry runs in JS alongside our existing native-crash receipt module. Keep
// current store binaries OTA-compatible; do not autolink a second crash handler.
module.exports = {
  dependencies: {
    '@sentry/react-native': { platforms: { android: null, ios: null } },
  },
};
