const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');
const config = getDefaultConfig(__dirname);
config.watchFolders = [
  path.resolve(__dirname, '..'),
  path.resolve(__dirname, '../../../packages'),
  path.resolve(__dirname, '../../../node_modules'),
];
config.resolver.nodeModulesPaths = [
  path.resolve(__dirname, '../node_modules'),
  path.resolve(__dirname, '../../../node_modules'),
];
config.resolver.resolveRequest = (context, name, platform) =>
  name === 'react-native-unistyles'
    ? {
        type: 'sourceFile',
        filePath: path.resolve(__dirname, '../offline-proof/adapters/theme.js'),
      }
    : context.resolveRequest(context, name, platform);
module.exports = config;
