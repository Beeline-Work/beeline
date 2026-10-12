// Native tray proof: shipped components with Expo Go adapters for Unistyles,
// the swipe wrapper and busy loader.
const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const fs = require('fs');

const config = getDefaultConfig(__dirname);
config.resolver.unstable_enableSymlinks = true;
config.resolver.unstable_enablePackageExports = true;
config.watchFolders = [
  path.resolve(__dirname, '..'),
  path.resolve(__dirname, '../../../packages'),
  path.resolve(__dirname, '../../../node_modules'),
];
config.resolver.nodeModulesPaths = [
  path.resolve(__dirname, '../node_modules'),
  path.resolve(__dirname, '../../node_modules'),
  path.resolve(__dirname, '../../../node_modules'),
];
// The app sources use the app tsconfig's `@/` alias; resolve it the same way.
const resolveAliased = (base) => {
  for (const ext of ['', '.ts', '.tsx', '/index.ts', '/index.tsx']) {
    if (fs.existsSync(base + ext)) return base + ext;
  }
  return base;
};
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName === 'react-native-gesture-handler' || moduleName === './MonoHull') {
    return { type: 'sourceFile', filePath: path.resolve(__dirname, 'interaction-proof-shim.tsx') };
  }
  if (moduleName.startsWith('@/')) {
    return {
      type: 'sourceFile',
      filePath: resolveAliased(path.resolve(__dirname, '../sources', moduleName.slice(2))),
    };
  }
  if (moduleName === 'react-native-unistyles') {
    return { type: 'sourceFile', filePath: path.resolve(__dirname, 'unistyles-proof-shim.tsx') };
  }
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
