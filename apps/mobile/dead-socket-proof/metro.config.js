const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');
const fs = require('fs');
const boundaries = require('./boundaries.cjs');
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
config.resolver.unstable_enableSymlinks = true;
const source = (base) =>
  ['', '.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.tsx']
    .map((ext) => base + ext)
    .find((file) => fs.existsSync(file) && fs.statSync(file).isFile()) ?? base;
config.resolver.resolveRequest = (context, name, platform) => {
  if (process.env.SOCKET_PROOF_BASELINE === '1' && name.endsWith('/live-connection'))
    return { type: 'sourceFile', filePath: path.resolve(__dirname, 'baseline-live.ts') };
  if (process.env.SOCKET_PROOF_BASELINE === '1' && name.endsWith('/useRoomSurfaceSession'))
    return { type: 'sourceFile', filePath: path.resolve(__dirname, 'baseline.ts') };
  if (name === 'react-native-svg')
    return {
      type: 'sourceFile',
      filePath: path.resolve(__dirname, 'node_modules/react-native-svg/src/index.ts'),
    };
  if (name in boundaries)
    return {
      type: 'sourceFile',
      filePath: fs.existsSync(path.resolve(__dirname, 'adapters', boundaries[name]))
        ? path.resolve(__dirname, 'adapters', boundaries[name])
        : path.resolve(__dirname, '../offline-proof/adapters', boundaries[name]),
    };
  if (name === 'react-native-unistyles')
    return { type: 'sourceFile', filePath: path.resolve(__dirname, 'adapters/theme.js') };
  if (name === 'react-native-reanimated')
    return {
      type: 'sourceFile',
      filePath: path.resolve(__dirname, '../offline-proof/adapters/animation.js'),
    };
  if (name.startsWith('@/'))
    return {
      type: 'sourceFile',
      filePath: source(path.resolve(__dirname, '../sources', name.slice(2))),
    };
  return context.resolveRequest(context, name, platform);
};
module.exports = config;
