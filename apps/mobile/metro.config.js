const { getDefaultConfig } = require("expo/metro-config");
const fs = require("fs");
const path = require("path");

const config = getDefaultConfig(__dirname, {
  isCSSEnabled: true,
});

// @buzzy/buzz-client and @buzzy/nostr are file: symlinks to ../../packages/*.
// Metro must (a) follow symlinks, (b) watch the real package dirs, and
// (c) resolve their transitive deps from root node_modules.
config.resolver.unstable_enableSymlinks = true;
config.resolver.unstable_enablePackageExports = true;

const rootNodeModules = path.resolve(__dirname, '../../node_modules');

config.watchFolders = [
  path.resolve(__dirname, '../../packages'),
  rootNodeModules,
].filter(fs.existsSync);

config.resolver.nodeModulesPaths = [
  path.resolve(__dirname, 'node_modules'),
  rootNodeModules,
].filter(fs.existsSync);

config.resolver.assetExts.push('wasm');

config.resolver.blockList = [
  /[/\\]src-tauri[/\\]target[/\\].*/,
];

// preact ESM/CJS dedup
const preactCjsPath = require.resolve('preact');
const preactHooksCjsPath = require.resolve('preact/hooks');
// libsodium ESM fallback (CJS)
const libsodiumCjsPath = path.join(
  __dirname,
  'node_modules/libsodium/dist/modules/libsodium.js',
);
const libsodiumWrappersCjsPath = path.join(
  __dirname,
  'node_modules/libsodium-wrappers/dist/modules/libsodium-wrappers.js',
);

const baseResolveRequest = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName === 'preact') {
    return { filePath: preactCjsPath, type: 'sourceFile' };
  }
  if (moduleName === 'preact/hooks') {
    return { filePath: preactHooksCjsPath, type: 'sourceFile' };
  }
  if (moduleName === 'libsodium') {
    return { filePath: libsodiumCjsPath, type: 'sourceFile' };
  }
  if (moduleName === 'libsodium-wrappers') {
    return { filePath: libsodiumWrappersCjsPath, type: 'sourceFile' };
  }
  if (baseResolveRequest) {
    return baseResolveRequest(context, moduleName, platform);
  }
  return context.resolveRequest(context, moduleName, platform);
};

config.transformer.getTransformOptions = async () => ({
  transform: {
    experimentalImportSupport: false,
    inlineRequires: true,
  },
});

module.exports = config;
