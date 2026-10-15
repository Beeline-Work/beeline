const path = require('path');
const { getDefaultConfig } = require('expo/metro-config');
const shared = require('../tray-proof/metro.config');
const config = getDefaultConfig(__dirname);
config.watchFolders = shared.watchFolders;
config.resolver.nodeModulesPaths = shared.resolver.nodeModulesPaths;
const resolve = shared.resolver.resolveRequest;
const adapters = new Set(['@/auth/buzz-identity-storage', '@/buzz/surface-storage',
  '@/sync/transport/monolith-operation', '@/sync/transport/live-connection']);
config.resolver.resolveRequest = (context, name, platform) => name.endsWith('/sources/buzz/needs-you-store') && process.env.TRAY_BEFORE
  ? { type: 'sourceFile', filePath: path.join(__dirname, 'before-store.ts') }
  : name === './HullDialog'
  ? { type: 'sourceFile', filePath: path.join(__dirname, 'dialog-adapter.tsx') }
  : adapters.has(name)
  ? { type: 'sourceFile', filePath: path.join(__dirname, 'adapters.ts') }
  : resolve(context, name, platform);
module.exports = config;
