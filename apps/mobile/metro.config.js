const { getSentryExpoConfig } = require("@sentry/react-native/metro");
const fs = require("fs");
const path = require("path");

const config = getSentryExpoConfig(__dirname, {
  isCSSEnabled: true,
  injectReleaseForWeb: false,
  enableSourceContextInDevelopment: false,
  optionsFile: false,
});

// Babel instrumentation depends on this flag, which Metro does not hash itself.
if (process.env.BEELINE_TRANSCRIPT_MEASURE === '1') {
  config.cacheVersion += '-transcript-measure';
}

// @beeline/buzz-client and @beeline/nostr are file: symlinks to ../../packages/*.
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
  // Tests are Node/Vitest-only source and must never be considered by an OTA bundle.
  // Cover both colocated test/spec/support files and conventional __tests__ directories.
  /(?:^|[/\\])(?:__tests__[/\\].*|[^/\\]+\.(?:test|spec|test-support)\.[cm]?[jt]sx?)$/,
];

// preact ESM/CJS dedup
const preactCjsPath = require.resolve('preact');
const preactHooksCjsPath = require.resolve('preact/hooks');
const rootHashesPath = path.join(rootNodeModules, '@noble/hashes');
const mobileHashesPath = path.join(__dirname, 'node_modules/@noble/hashes');
const sameHashesVersion = fs.existsSync(path.join(rootHashesPath, 'package.json')) &&
  fs.existsSync(path.join(mobileHashesPath, 'package.json')) &&
  require(path.join(rootHashesPath, 'package.json')).version ===
    require(path.join(mobileHashesPath, 'package.json')).version;
const baseResolveRequest = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName === 'preact') {
    return { filePath: preactCjsPath, type: 'sourceFile' };
  }
  if (moduleName === 'preact/hooks') {
    return { filePath: preactHooksCjsPath, type: 'sourceFile' };
  }
  const resolved = baseResolveRequest
    ? baseResolveRequest(context, moduleName, platform)
    : context.resolveRequest(context, moduleName, platform);
  // Keep identical workspace/mobile hash copies in one module graph. Nested
  // dependencies with another version retain their original resolution.
  if (sameHashesVersion && resolved.type === 'sourceFile' &&
      resolved.filePath.startsWith(rootHashesPath + path.sep)) {
    return { ...resolved, filePath: path.join(mobileHashesPath, path.relative(rootHashesPath, resolved.filePath)) };
  }
  return resolved;
};

// Fold bindings introduced by module extraction using the existing minifier.
config.transformer.minifierConfig = {
  ...config.transformer.minifierConfig,
  output: {
    ...config.transformer.minifierConfig.output,
    ascii_only: false,
  },
  compress: {
    ...config.transformer.minifierConfig.compress,
    passes: 2,
  },
};

config.transformer.getTransformOptions = async () => ({
  transform: {
    experimentalImportSupport: false,
    inlineRequires: true,
  },
});

/** @public Metro loads this configuration by filename. */
module.exports = config;
