const { getDefaultConfig } = require("expo/metro-config");
const path = require("path");

const config = getDefaultConfig(__dirname, {
  // Enable CSS support for web
  isCSSEnabled: true,
});

// Add support for .wasm files (required by Skia for all platforms)
// Source: https://shopify.github.io/react-native-skia/docs/getting-started/installation/
config.resolver.assetExts.push('wasm');

// Exclude Tauri Rust build artifacts from Metro's file watcher.
// Cargo writes/deletes transient files in src-tauri/target/debug/deps during
// `tauri dev`, which crashes Metro's fallback watcher on Windows with ENOENT.
config.resolver.blockList = [
  /[/\\]src-tauri[/\\]target[/\\].*/,
];

// Force every preact / preact/hooks import (ESM or CJS, from any package) to
// resolve to a SINGLE file. preact's package.json exports field maps "import"
// to preact.mjs and "require" to preact.js, which makes Metro register two
// separate module instances depending on the importer's module type. Two
// instances mean two `options` objects — preact/hooks patches one,
// @pierre/trees renders against the other, currentComponent stays undefined,
// `r.__H` crashes. Pin to the CJS bundles so everyone shares state.
const preactCjsPath = require.resolve('preact');
const preactHooksCjsPath = require.resolve('preact/hooks');
// libsodium 0.8 ESM uses bare `import.meta.url`, which crashes when Metro
// serves the web bundle as a classic <script> (not type=module). Pin CJS.
// Use absolute paths (package "exports" block require.resolve of subpaths).
const libsodiumCjsPath = path.join(
  __dirname,
  'node_modules/libsodium/dist/modules/libsodium.js',
);
const libsodiumWrappersCjsPath = path.join(
  __dirname,
  'node_modules/libsodium-wrappers/dist/modules/libsodium-wrappers.js',
);

// @buzzy/buzz-client and @buzzy/nostr are installed as file: dependencies but
// their resolved dist lives outside the project root via the symlink.
// Metro needs both a resolveRequest alias AND watchFolders to see those files.
const buzzClientDist = path.resolve(__dirname, '../../packages/buzz-client/dist');
const buzzNostrDist = path.resolve(__dirname, '../../packages/nostr/dist');
config.watchFolders = (config.watchFolders || []).concat([buzzClientDist, buzzNostrDist]);

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
  if (moduleName === '@buzzy/buzz-client') {
    return { filePath: path.join(buzzClientDist, 'index.js'), type: 'sourceFile' };
  }
  if (moduleName === '@buzzy/nostr') {
    return { filePath: path.join(buzzNostrDist, 'index.js'), type: 'sourceFile' };
  }
  // Transitive deps from @buzzy/nostr — @noble and nostr-tools are installed
  // in mobile's node_modules but the resolveRequest alias short-circuits
  // the normal node_modules walk from the dist file location. Resolve explicitly.
  if (moduleName.startsWith('@noble/')) {
    const sub = moduleName.slice('@noble/'.length);
    return { filePath: path.join(__dirname, 'node_modules/@noble', sub), type: 'sourceFile' };
  }
  if (moduleName === 'nostr-tools') {
    return { filePath: path.join(__dirname, 'node_modules/nostr-tools/lib/esm/index.js'), type: 'sourceFile' };
  }
  if (baseResolveRequest) {
    return baseResolveRequest(context, moduleName, platform);
  }
  return context.resolveRequest(context, moduleName, platform);
};

// Enable inlineRequires for proper Skia and Reanimated loading
// Source: https://shopify.github.io/react-native-skia/docs/getting-started/web/
// Without this, Skia throws "react-native-reanimated is not installed" error
// This is cross-platform compatible (iOS, Android, web)
config.transformer.getTransformOptions = async () => ({
  transform: {
    experimentalImportSupport: false,
    inlineRequires: true, // Critical for @shopify/react-native-skia
  },
});

module.exports = config;