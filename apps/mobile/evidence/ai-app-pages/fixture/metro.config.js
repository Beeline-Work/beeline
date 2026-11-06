const path=require('path');const fs=require('fs'); const {getDefaultConfig}=require('expo/metro-config');
const config=getDefaultConfig(__dirname);const mobile=path.resolve(__dirname,'../../..');const root=path.resolve(mobile,'../..');
config.cacheVersion=(config.cacheVersion||'')+'-ai-proof-'+(process.env.PROOF_BEFORE||'0');
config.watchFolders=[mobile,path.join(root,'packages'),path.join(root,'node_modules')];config.resolver.nodeModulesPaths=[path.join(mobile,'node_modules'),path.join(root,'node_modules')];
const stubs={'auth/buzz-identity-storage':'identity','sync/transport/monolith-operation':'transport','sync/transport/live-connection':'live','buzz/surface-storage':'storage','buzz/community-storage':'community'};
config.resolver.blockList=[/ai-app-pages\/fixture\/(web-after|web-before)\/.*/];
config.resolver.resolveRequest=(context,name,platform)=>{
 if(name==='react-native-mmkv') return {type:'sourceFile',filePath:path.join(__dirname,'stubs/mmkv.ts')};
 let key=name.startsWith('@/')?name.slice(2):null;
 if(!key&&name.startsWith('.')){const abs=path.resolve(path.dirname(context.originModulePath),name);if(abs.startsWith(path.join(__dirname,'before')+'/'))key=path.relative(path.join(__dirname,'before'),abs).replace(/\\/g,'/').replace(/\.(tsx?|jsx?)$/,'');if(abs.startsWith(path.join(mobile,'sources')+'/'))key=path.relative(path.join(mobile,'sources'),abs).replace(/\\/g,'/').replace(/\.(tsx?|jsx?)$/,'');}
 if(key&&stubs[key])return {type:'sourceFile',filePath:path.join(__dirname,'stubs',stubs[key]+'.ts')};
 if(key){const base=process.env.PROOF_BEFORE==='1'&&fs.existsSync(path.join(__dirname,'before',key+'.tsx'))?path.join(__dirname,'before',key):path.join(mobile,'sources',key);return context.resolveRequest(context,base,platform);}
 return context.resolveRequest(context,name,platform);
};module.exports=config;
