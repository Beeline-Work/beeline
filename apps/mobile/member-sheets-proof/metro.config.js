// Production sheets in Expo Go; adapt only native runtimes outside this proof.
const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');
const fs = require('fs');
const config = getDefaultConfig(__dirname);
config.maxWorkers = 2;
config.watchFolders = [
  path.resolve(__dirname, '..'),
  path.resolve(__dirname, '../../../packages'),
  path.resolve(__dirname, '../../../node_modules'),
];
config.resolver.nodeModulesPaths = [
  path.resolve(__dirname, '../node_modules'),
  path.resolve(__dirname, '../../../node_modules'),
];
config.resolver.resolveRequest = (context, name, platform) => {
  const adapters = {
    'react-native-unistyles': 'theme.js',
    'react-native-reanimated': 'animation.js',
    'react-native-keyboard-controller': 'keyboard.js',
    'react-native-device-info': 'fixtures.js',
    '@/buzz/android-modal-navigation-bar': 'fixtures.js',
    // Expo Go's SVG native runtime differs from the shipped app runtime.
    'react-native-svg': 'node_modules/react-native-svg/src/index.ts',
  };
  if (adapters[name])
    return { type: 'sourceFile', filePath: path.resolve(__dirname, adapters[name]) };
  if (name.startsWith('@/')) {
    const base = path.resolve(__dirname, '../sources', name.slice(2));
    return {
      type: 'sourceFile',
      filePath: ['', '.ts', '.tsx', '/index.ts', '/index.tsx']
        .map((ext) => base + ext)
        .find((file) => fs.existsSync(file) && fs.statSync(file).isFile()),
    };
  }
  return context.resolveRequest(context, name, platform);
};
module.exports = config;
