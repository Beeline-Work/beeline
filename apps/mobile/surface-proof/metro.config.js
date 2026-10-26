// Production section surfaces with Expo Go adapters for Unistyles,
// reduced motion and the unused keyboard controller.
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
    if (fs.existsSync(base + ext) && fs.statSync(base + ext).isFile()) return base + ext;
  }
  return base;
};
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName === 'react-native-webview' || moduleName.includes('node_modules/react-native-webview/src/index'))
    return { type: 'sourceFile', filePath: path.resolve(__dirname, '../node_modules/react-native-webview/src/index.ts') };
  if (moduleName === 'react-native-svg' && platform !== 'web')
    return {
      type: 'sourceFile',
      filePath: path.resolve(__dirname, '../node_modules/react-native-svg/src/index.ts'),
    };

  if (
    moduleName === 'react-native-reanimated' ||
    moduleName === 'react-native-keyboard-controller'
  ) {
    return {
      type: 'sourceFile',
      filePath: path.resolve(
        __dirname,
        moduleName === 'react-native-reanimated' ? 'animation.js' : 'keyboard.js',
      ),
    };
  }
  if (
    [
      '@/auth/signin-funnel',
      '@/buzz/artifact-link',
      '@/buzz/app-reconnect',
      '@/buzz/use-active-community',
      '@/buzz/use-text-draft',
      'react-native-device-info',
      'expo-router',
      '@/buzz/workbench-source',
      '@/buzz/workbench-surface',
      '@/buzz/company-connection-actions',
      '@/buzz/latency-route-hook',
      '@/components/buzz/ServiceMark',
      '@/buzz/android-modal-navigation-bar',
    ].includes(moduleName)
  )
    return { type: 'sourceFile', filePath: path.resolve(__dirname, 'fixtures.js') };
  if (moduleName.startsWith('@/')) {
    return {
      type: 'sourceFile',
      filePath: resolveAliased(path.resolve(__dirname, '../sources', moduleName.slice(2))),
    };
  }
  if (moduleName === 'react-native-unistyles') {
    return { type: 'sourceFile', filePath: path.resolve(__dirname, 'theme.js') };
  }
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
