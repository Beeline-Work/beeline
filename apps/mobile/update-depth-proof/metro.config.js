const { getDefaultConfig } = require('expo/metro-config');
const fs = require('node:fs');
const path = require('node:path');
const mobile = path.resolve(__dirname, '..');
const config = getDefaultConfig(__dirname);
config.watchFolders = [mobile, path.resolve(mobile, '../../packages'), path.resolve(mobile, '../../node_modules')];
config.resolver.nodeModulesPaths = [path.join(mobile, 'node_modules'), path.resolve(mobile, '../../node_modules')];
config.resolver.resolveRequest = (context, name, platform) => {
  if (name === '@/buzz/room-message-records' && process.env.UPDATE_DEPTH_BEFORE) {
    return { type: 'sourceFile', filePath: path.join(__dirname, '.before-store.ts') };
  }
  if (name.startsWith('@/') || (context.originModulePath.endsWith('.before-store.ts') && name.startsWith('./'))) {
    const base = name.startsWith('@/') ? path.join(mobile, 'sources', name.slice(2))
      : path.join(mobile, 'sources/buzz', name.slice(2));
    const filePath = ['', '.ts', '.tsx', '/index.ts'].map(ext => base + ext).find(file => fs.existsSync(file));
    if (filePath) return { type: 'sourceFile', filePath };
  }
  return context.resolveRequest(context, name, platform);
};
module.exports = config;
