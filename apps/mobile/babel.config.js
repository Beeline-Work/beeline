module.exports = {
  presets: ['module:@react-native/babel-preset'],
  // react-native-reanimated requires its babel plugin to be the
  // *last* plugin in the list.
  plugins: ['react-native-reanimated/plugin'],
};
