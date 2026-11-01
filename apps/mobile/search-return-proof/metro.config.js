const path = require('path');
const fs = require('fs');
const mobile = path.resolve(__dirname, '..');
const {getDefaultConfig} = require(path.join(mobile,'node_modules/expo/metro-config'));
const config = getDefaultConfig(__dirname);
config.watchFolders = [mobile, path.resolve(mobile,'../../packages'), path.resolve(mobile,'../../node_modules')];
config.resolver.nodeModulesPaths = [path.join(mobile,'node_modules'),path.resolve(mobile,'../../node_modules')];
config.resolver.resolveRequest = (ctx,name,platform) => {
  if(name==='./draft-identity' && ctx.originModulePath.endsWith('use-text-draft.ts'))return {type:'sourceFile',filePath:path.join(__dirname,'draft-identity.js')};
  const adapters = {'react-native-unistyles': 'theme.js', 'react-native-keyboard-controller': '../approval-proof/keyboard.js','react-native-reanimated':'../approval-proof/animation.js'};
  if (adapters[name]) return {type:'sourceFile',filePath:path.join(__dirname,adapters[name])};
  if (name.startsWith('@/')) {
    const base=path.join(mobile,'sources',name.slice(2));
    for(const ext of ['','.ts','.tsx','.js','.json','/index.ts','/index.tsx']) if(fs.existsSync(base+ext))return {type:'sourceFile',filePath:base+ext};
  }
  return ctx.resolveRequest(ctx,name,platform);
};
module.exports=config;
