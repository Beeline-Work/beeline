const path = require('path');
const base = require('../offline-proof/metro.config');
const { getDefaultConfig } = require('expo/metro-config');
const config = getDefaultConfig(__dirname);
config.watchFolders = [...base.watchFolders, __dirname];
config.resolver = { ...base.resolver, ...config.resolver, nodeModulesPaths: base.resolver.nodeModulesPaths };
config.resolver.resolveRequest = base.resolver.resolveRequest;
const prior = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, name, platform) => {
 if (name === 'react-native-svg') return {type:'sourceFile',filePath:path.join(__dirname,'node_modules/react-native-svg/src/index.ts')};
 if (name === 'expo-router' || name === './use-shared-surface' || name === '@/sync/transport/monolith-operation')
   return {type:'sourceFile',filePath:path.join(__dirname,'fixture.js')};
 return prior(context,name,platform);
};
module.exports=config;
